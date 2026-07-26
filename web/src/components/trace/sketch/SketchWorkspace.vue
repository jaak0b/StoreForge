<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor, type SketchTool } from '../../../stores/sketchEditor';
import SketchCanvas from './SketchCanvas.vue';
import type { MmPoint } from '../../../engine/trace/types';
import type { SketchEntity } from '../../../engine/sketch/model';
import type { DimensionSelectionKind } from '../../../engine/sketch/dimensionSelection';
import {
  applicableConstraintKinds,
  canToggleConstruction,
  type ApplicableConstraintKind,
} from '../../../engine/sketch/constraintApplicability';
import { constraintKindSentence } from '../../../engine/sketch/constraintGlyphs';
import { assertNever } from '../../../engine/plan/types';
import {
  formatDegrees,
  formatMm,
  formatScale,
  parseDimensionValue,
  parseSignedValue,
} from '../../../engine/sketch/measure';

const emit = defineEmits<{
  (e: 'finish'): void;
  (e: 'cancel'): void;
}>();

/** Template ref to the canvas, so the toolbar's Fit button can call its
 * exposed fitToView; the canvas owns the viewBox math (convention 10). */
const sketchCanvas = ref<InstanceType<typeof SketchCanvas> | null>(null);

const editor = useSketchEditor();
const {
  activeTool,
  sketch,
  chainTailId,
  chainTailSegmentId,
  solveState,
  pendingClicks,
  pendingHitPointIds,
  cursorMm,
  dimensionPending,
} = storeToRefs(editor);

/** A one-line hint under the toolbar naming the tool's next expected click. */
const toolHint = ref('');

/** Tool row buttons: icon, tooltip name, and (for tools without a clean mdi
 * match) an inline custom icon. Order matches the toolbar's display order. */
const toolButtons: { tool: SketchTool; label: string; icon?: string }[] = [
  { tool: 'select', label: 'Select', icon: 'mdi-cursor-default-outline' },
  { tool: 'line', label: 'Line', icon: 'mdi-vector-line' },
  { tool: 'arcThreePoint', label: 'Arc', icon: 'mdi-vector-curve' },
  { tool: 'arcTangent', label: 'Tangent arc' },
  { tool: 'circle', label: 'Circle', icon: 'mdi-circle-outline' },
  { tool: 'rectangle', label: 'Rectangle', icon: 'mdi-rectangle-outline' },
  { tool: 'slot', label: 'Slot', icon: 'mdi-capsule' },
  { tool: 'mirror', label: 'Mirror line', icon: 'mdi-reflect-horizontal' },
  { tool: 'dimension', label: 'Dimension', icon: 'mdi-ruler' },
];

/** Icon and tooltip for each applicable-constraint button. */
const constraintButtons: Record<ApplicableConstraintKind, { label: string; icon: string }> = {
  horizontal: { label: 'Horizontal', icon: 'mdi-minus' },
  vertical: { label: 'Vertical', icon: 'mdi-height' },
  parallel: { label: 'Parallel', icon: 'mdi-equal' },
  perpendicular: { label: 'Perpendicular', icon: 'mdi-plus' },
  tangent: { label: 'Tangent', icon: 'mdi-vector-radius' },
  coincident: { label: 'Coincident', icon: 'mdi-vector-point' },
  symmetric: { label: 'Symmetric', icon: 'mdi-reflect-horizontal' },
};

/**
 * The quick numeric entry: typing digits while the line or circle tool is
 * mid-placement, or the width prompt that opens automatically after the
 * slot tool's second click. One shared small input drives all three, per
 * the spec's "same inline numeric input pattern".
 */
type QuickEntryKind = 'segmentLength' | 'diameter' | 'slotWidth';
const quickEntryKind = ref<QuickEntryKind | null>(null);
const quickEntryText = ref('');
/** Set when Enter is pressed on unparseable quick-entry text; cleared as soon
 * as the field is reopened or the text changes. Drives the field's error
 * styling (convention 8's complete-sentence message, not a raw exception). */
const quickEntryErrorText = ref<string | null>(null);

/** Clears a shown error as soon as the user edits the text again, so the
 * error styling reflects the last commit attempt, not stale earlier input. */
watch(quickEntryText, () => {
  quickEntryErrorText.value = null;
});

/** The complete-sentence validation message for a given quick-entry kind.
 * All three kinds are millimeter values, but the switch stays exhaustive
 * (convention 13) so a future non-mm quick entry cannot fall through
 * unnoticed. */
function quickEntryErrorMessage(kind: QuickEntryKind): string {
  switch (kind) {
    case 'segmentLength':
    case 'diameter':
    case 'slotWidth':
      return 'Enter the value as a number in millimeters.';
    default:
      return assertNever(kind);
  }
}

/** The hint text for a tool, in one place so both the explicit tool switch
 * (selectTool) and the auto-return watcher below (task F: a one-shot or
 * closed chain tool switching the store's activeTool back to select on its
 * own) keep the hint in sync without duplicating the switch. */
function hintForTool(tool: SketchTool): string {
  switch (tool) {
    case 'select':
      return 'Click an entity to select it, or drag a point to move the geometry.';
    case 'line':
      return (
        'Click to place each corner. Click the first point again to close the outline. ' +
        'Type a number to set the next segment\'s length.'
      );
    case 'arcThreePoint':
      return 'Click the arc start, then the arc end, then a point the arc passes through.';
    case 'arcTangent':
      return 'Click the end point of the arc; it continues tangent from the last chain point.';
    case 'circle':
      return 'Click the circle center, then a point on the circle. Type a number to set the diameter.';
    case 'rectangle':
      return 'Click one corner, then the opposite corner.';
    case 'slot':
      return 'Click the two ends of the slot axis, then type the width.';
    case 'mirror':
      return 'Click the two ends of the mirror line.';
    case 'dimension':
      return (
        'Click one line, arc or circle for a length or radius, or two entities for a distance or angle. ' +
        'Click again to place the label, then type the value.'
      );
    default:
      return assertNever(tool);
  }
}

function selectTool(tool: SketchTool): void {
  activeTool.value = tool;
  editor.clearPendingClicks();
  quickEntryKind.value = null;
  quickEntryText.value = '';
  editor.selectedConstraintId = null;
  editor.endChain();
  dimensionPending.value = null;
  editor.cancelDimensionDraft();
  toolHint.value = hintForTool(tool);
}
selectTool('select');

/**
 * A one-shot tool (circle, rectangle, slot, mirror) or a chain tool (line,
 * arcThreePoint, arcTangent) that closes its chain sets activeTool back to
 * 'select' directly in the store (task F), the single place each already
 * detects its own completion (addCircle, addRectangle, addSlot,
 * addMirrorLine, closeChainTo, addThreePointArc's closing branch). This
 * keeps the toolbar's hint text in sync with that store-driven switch
 * without re-detecting completion here.
 */
watch(activeTool, (tool) => {
  toolHint.value = hintForTool(tool);
});

/** Whether the quick numeric entry is currently applicable, and which kind:
 * a line tool mid-chain (segment length), a circle tool after its center
 * click (diameter), or a slot tool after both axis clicks (width prompt). */
const quickEntryApplicable = computed<QuickEntryKind | null>(() => {
  if (activeTool.value === 'line' && chainTailId.value !== null) return 'segmentLength';
  if (activeTool.value === 'circle' && pendingClicks.value.length === 1) return 'diameter';
  if (activeTool.value === 'slot' && pendingClicks.value.length === 2) return 'slotWidth';
  return null;
});

/** Opens the quick numeric entry for the given kind, seeded with the first
 * typed character (or empty, for the slot width prompt which opens on its
 * own rather than on a keypress). */
function openQuickEntry(kind: QuickEntryKind, seedChar: string): void {
  quickEntryKind.value = kind;
  quickEntryText.value = seedChar;
  quickEntryErrorText.value = null;
}

/** Commits the quick numeric entry, applying the typed length/diameter/width
 * to the segment, circle or slot being placed, and adding the matching
 * dimension constraint. Silently ignores an unparseable value (the field
 * stays open for another attempt); Escape is the only way to abandon it. */
function commitQuickEntry(): void {
  const kind = quickEntryKind.value;
  if (kind === null) return;
  const value = parseDimensionValue(quickEntryText.value);
  if (value === null) {
    quickEntryErrorText.value = quickEntryErrorMessage(kind);
    return;
  }
  switch (kind) {
    case 'segmentLength': {
      if (chainTailId.value === null) break;
      const tail = sketch.value.entities.find((e) => e.id === chainTailId.value);
      if (tail === undefined || tail.kind !== 'point') break;
      const cursor = cursorMm.value ?? { x: tail.x + value, y: tail.y };
      const dx = cursor.x - tail.x;
      const dy = cursor.y - tail.y;
      const dirLen = Math.hypot(dx, dy) || 1;
      const target = { x: tail.x + (dx / dirLen) * value, y: tail.y + (dy / dirLen) * value };
      editor.runGrouped(() => {
        editor.appendChainPoint(target);
        if (chainTailSegmentId.value !== null) {
          editor.addDimension({
            kind: 'length', id: editor.nextId(), lineId: chainTailSegmentId.value, mm: value,
          });
        }
      });
      scheduleSolve();
      break;
    }
    case 'diameter': {
      if (pendingClicks.value.length !== 1) break;
      const center = pendingClicks.value[0];
      const centerHitId = pendingHitPointIds.value[0] ?? undefined;
      editor.runGrouped(() => {
        const circleId = editor.addCircle(center, value / 2, centerHitId);
        editor.addDimension({ kind: 'diameter', id: editor.nextId(), entityId: circleId, mm: value });
      });
      editor.clearPendingClicks();
      scheduleSolve();
      break;
    }
    case 'slotWidth': {
      if (pendingClicks.value.length !== 2) break;
      const [a, b] = pendingClicks.value;
      editor.runGrouped(() => {
        editor.addSlot(a, b, value);
      });
      editor.clearPendingClicks();
      scheduleSolve();
      break;
    }
    default:
      assertNever(kind);
  }
  quickEntryKind.value = null;
  quickEntryText.value = '';
  quickEntryErrorText.value = null;
}

/** Abandons the quick numeric entry without applying anything. The slot
 * width prompt also clears its two axis clicks: unlike the line/circle quick
 * entry (whose seed click stays live for a retry), the slot tool has no
 * further use for those points once its own prompt is dismissed, and
 * leaving them behind would wedge the tool: a third click would push a
 * length-3 pendingClicks that never reopens the prompt. */
function cancelQuickEntry(): void {
  if (quickEntryKind.value === 'slotWidth') {
    editor.clearPendingClicks();
  }
  quickEntryKind.value = null;
  quickEntryText.value = '';
  quickEntryErrorText.value = null;
}

/** Blur commits a parseable value, same as Enter; an unparseable value on
 * blur cancels instead of leaving the field stuck open (Enter is the
 * gesture that shows the error and keeps the field open for a retry). */
function onQuickEntryBlur(): void {
  if (parseDimensionValue(quickEntryText.value) !== null) {
    commitQuickEntry();
  } else {
    cancelQuickEntry();
  }
}

let solveTimer: ReturnType<typeof setTimeout> | null = null;
/** Runs the solver shortly after every edit, coalescing rapid changes. */
function scheduleSolve(): void {
  if (solveTimer !== null) clearTimeout(solveTimer);
  solveTimer = setTimeout(() => {
    void editor.solveNow();
  }, 150);
}

function entityById(id: string): SketchEntity | undefined {
  return sketch.value.entities.find((e) => e.id === id);
}

/** The currently selected entities, resolved from the store's selected ids. */
const selectedEntities = computed<SketchEntity[]>(() =>
  editor.selectedIds.map(entityById).filter((e): e is SketchEntity => e !== undefined),
);

/** Constraint kinds the current selection admits, per model.ts's shapes. */
const availableConstraintKinds = computed<ApplicableConstraintKind[]>(() =>
  applicableConstraintKinds(selectedEntities.value),
);

/** Whether the construction toggle applies to the current selection. */
const constructionApplicable = computed<boolean>(() =>
  canToggleConstruction(selectedEntities.value),
);

/** The constraint row only renders when the selection admits at least one
 * constraint or the construction toggle. */
const showConstraintRow = computed<boolean>(
  () => availableConstraintKinds.value.length > 0 || constructionApplicable.value,
);

/**
 * Toggles an entity in the selection. With the dimension tool active, this
 * routes through the store's resolveDimensionAtSelection: a selection that
 * resolves to a dimension kind (or the two-parallel-lines fallback) clears
 * itself and updates dimensionPending; the toolbar hint always reflects the
 * result. Placement (the second click that positions the label) happens
 * separately in onCanvasClick, once dimensionPending is set.
 *
 * A single line or arc/circle resolves immediately (see
 * resolveDimensionSelection), which normally clears selectedIds. If the
 * dimension tool is still waiting on a placement click (dimensionPending
 * set, selectedIds empty) and the user instead clicks a second entity, that
 * second click is meant to combine with the first into a two-entity
 * dimension (e.g. two non-parallel lines resolving to an angle), not to
 * discard the first pick. Re-seed selectedIds with the pending selection's
 * entity id so resolveDimensionAtSelection sees both entities together.
 */
function onEntityClick(entityId: string): void {
  if (
    activeTool.value === 'dimension' &&
    dimensionPending.value !== null &&
    editor.selectedIds.length === 0
  ) {
    const priorId = singleEntityIdOfPending(dimensionPending.value);
    dimensionPending.value = null;
    if (priorId !== null && priorId !== entityId) editor.selectedIds.push(priorId);
  }
  const at = editor.selectedIds.indexOf(entityId);
  if (at === -1) editor.selectedIds.push(entityId);
  else editor.selectedIds.splice(at, 1);
  if (activeTool.value === 'dimension') {
    toolHint.value = editor.resolveDimensionAtSelection();
  }
}

/** The single entity id a resolved-but-unplaced dimensionPending selection
 * came from, for onEntityClick to re-seed selectedIds when a second entity
 * click arrives before placement; null for the two-entity kinds, which have
 * nothing left to combine. */
function singleEntityIdOfPending(pending: DimensionSelectionKind): string | null {
  switch (pending.kind) {
    case 'length':
      return pending.lineId;
    case 'radiusOrDiameter':
      return pending.entityId;
    case 'distance':
    case 'angle':
    case 'pointLineDistance':
      return null;
    default:
      return assertNever(pending);
  }
}

/** Selects the constraint behind a clicked glyph. */
function onConstraintClick(constraintId: string): void {
  editor.selectConstraint(constraintId);
}

/** The hint line's text: the selected constraint's kind, in a complete
 * sentence, when a glyph is selected; otherwise the active tool's hint. */
const displayedHint = computed<string>(() => {
  if (editor.selectedConstraintId !== null) {
    const c = sketch.value.constraints.find((k) => k.id === editor.selectedConstraintId);
    if (c !== undefined) return constraintKindSentence(c);
  }
  return toolHint.value;
});

/** Whether the hint row's Driven/Driving toggle button applies: a dimension
 * constraint (not a geometric constraint) is currently selected. */
const showDrivenToggle = computed<boolean>(
  () => editor.selectedConstraintId !== null && editor.isDimensionConstraintId(editor.selectedConstraintId),
);

/** The toggle button's complete-sentence label/tooltip, naming the action it
 * performs (convention 7). */
const drivenToggleLabel = computed<string>(() => {
  if (editor.selectedConstraintId === null) return '';
  return editor.isDimensionDriven(editor.selectedConstraintId)
    ? 'This dimension is a reference dimension. Click to make it drive the geometry instead.'
    : 'This dimension drives the geometry. Click to make it a reference dimension instead.';
});

/** Flips the selected dimension's driven flag and reschedules the solve, so
 * a dimension turned driving again is re-enforced immediately, and one turned
 * driven stops constraining without waiting for another edit. */
function toggleSelectedDimensionDriven(): void {
  if (editor.selectedConstraintId === null) return;
  editor.toggleDimensionDriven(editor.selectedConstraintId);
  scheduleSolve();
}

/** Resolves the over-constrain offer by keeping the new dimension as a
 * reference dimension, then reschedules the solve so the now-driven
 * dimension stops fighting the rest of the sketch. */
function keepConflictingDimensionAsReference(): void {
  editor.keepDimensionConflictAsReference();
  scheduleSolve();
}

/** Resolves the over-constrain offer by removing the new dimension outright,
 * then reschedules the solve. */
function removeConflictingDimension(): void {
  editor.removeDimensionConflictOffer();
  scheduleSolve();
}

/** Applies a constraint to the current selection; each row names its need. */
function applyConstraint(kind: ApplicableConstraintKind): void {
  const picked = selectedEntities.value;
  const id = editor.nextId();
  switch (kind) {
    case 'horizontal':
    case 'vertical':
      if (picked.length === 1 && picked[0].kind === 'line') {
        editor.addConstraint({ kind, id, lineId: picked[0].id });
      } else {
        toolHint.value = 'Select one line first.';
        return;
      }
      break;
    case 'parallel':
    case 'perpendicular':
      if (picked.length === 2 && picked.every((e) => e.kind === 'line')) {
        editor.addConstraint({ kind, id, l1Id: picked[0].id, l2Id: picked[1].id });
      } else {
        toolHint.value = 'Select two lines first.';
        return;
      }
      break;
    case 'tangent':
      if (picked.length === 2) {
        editor.addConstraint({ kind: 'tangent', id, aId: picked[0].id, bId: picked[1].id });
      } else {
        toolHint.value = 'Select the two entities to make tangent first.';
        return;
      }
      break;
    case 'coincident':
      if (picked.length === 2 && picked.every((e) => e.kind === 'point')) {
        editor.addConstraint({ kind: 'coincident', id, p1Id: picked[0].id, p2Id: picked[1].id });
      } else {
        toolHint.value = 'Select two points first.';
        return;
      }
      break;
    case 'symmetric':
      if (
        picked.length === 3 &&
        picked.filter((e) => e.kind === 'point').length === 2 &&
        picked.filter((e) => e.kind === 'line').length === 1
      ) {
        const pts = picked.filter((e) => e.kind === 'point');
        const mirror = picked.find((e) => e.kind === 'line')!;
        editor.addConstraint({
          kind: 'symmetric',
          id,
          p1Id: pts[0].id,
          p2Id: pts[1].id,
          mirrorLineId: mirror.id,
        });
      } else {
        toolHint.value = 'Select two points and the mirror line first.';
        return;
      }
      break;
    default:
      assertNever(kind);
  }
  editor.selectedIds = [];
  scheduleSolve();
}

function toggleConstructionOnSelection(): void {
  for (const id of editor.selectedIds) editor.toggleConstruction(id);
  scheduleSolve();
}

/** The solver readout as labeled rows, not prose (convention 8). */
const statusRows = computed<{ label: string; value: string }[]>(() => {
  const state = solveState.value;
  switch (state.status) {
    case 'idle':
      return [{ label: 'Solver', value: 'not yet run' }];
    case 'solved':
      return [
        { label: 'Solver', value: state.dof === 0 ? 'fully constrained' : 'under-constrained' },
        { label: 'Degrees of freedom', value: String(state.dof) },
      ];
    case 'conflicting':
      return [
        { label: 'Solver', value: 'conflicting constraints' },
        ...state.conflictingConstraintIds.map((id) => ({ label: 'Conflicting constraint', value: id })),
      ];
    case 'failed':
      return [{ label: 'Solver', value: state.message }];
    default:
      return assertNever(state);
  }
});

/** Removes one conflicting constraint from its diagnostics row. */
function removeConflicting(constraintId: string): void {
  editor.removeConstraint(constraintId);
  scheduleSolve();
}

/** Object URLs created by onUnderlayFile that have not yet resolved (loaded
 * or errored): revoked on unmount so navigating away mid-load never leaks
 * one. Removed from the set as soon as its image settles either way. */
const pendingUnderlayUrls = new Set<string>();

/**
 * Loads the chosen file's pixel dimensions, then inserts it as a new
 * reference photo underlay centered in the current view, replicating
 * Fusion 360's Canvas insert (modest default size, aspect preserved, ~50%
 * opacity). Appends alongside any existing underlays rather than replacing
 * them: "Add a photo" can be used repeatedly to build up several reference
 * canvases.
 */
function onUnderlayFile(file: File | File[] | null): void {
  const picked = Array.isArray(file) ? (file[0] ?? null) : file;
  if (picked === null) return;
  const url = URL.createObjectURL(picked);
  pendingUnderlayUrls.add(url);
  const img = new Image();
  img.onload = () => {
    pendingUnderlayUrls.delete(url);
    const center = sketchCanvas.value?.viewCenterMm() ?? { x: 0, y: 0 };
    editor.insertUnderlay(url, img.naturalWidth, img.naturalHeight, center, picked.name || null);
  };
  img.onerror = () => {
    pendingUnderlayUrls.delete(url);
    URL.revokeObjectURL(url);
    toolHint.value = 'That file could not be read as an image.';
  };
  img.src = url;
}

onUnmounted(() => {
  for (const url of pendingUnderlayUrls) URL.revokeObjectURL(url);
  pendingUnderlayUrls.clear();
});

/** The underlay bound to the exact-entry fields and Calibrate/Remove: the
 * current selection, or null when no underlay is selected. */
const selectedUnderlay = computed(() =>
  editor.selectedUnderlayId === null
    ? null
    : editor.underlays.find((u) => u.id === editor.selectedUnderlayId) ?? null,
);

/** The menu row label for one underlay: its source file name, or "Photo N"
 * (1-based insertion order) when no file name is available. */
function underlayLabel(id: string): string {
  const index = editor.underlays.findIndex((u) => u.id === id);
  const u = index === -1 ? null : editor.underlays[index];
  if (u === null) return '';
  return u.fileName ?? `Photo ${index + 1}`;
}

/**
 * Exact-entry fields for the selected underlay's X/Y/rotation/scale. Each is
 * a getter/setter computed so the displayed text is derived from the
 * store's full-precision transform through the same rounding formatters as
 * the on-canvas dimension labels (convention 10 single source), instead of
 * a cached formatted string that could go stale after a manipulator drag.
 * Committing an unparseable value is a no-op: the getter re-reads the
 * unchanged store value on the next render, which reverts the field.
 */
const underlayXField = computed<number | string>({
  get: () => (selectedUnderlay.value === null ? 0 : formatMm(selectedUnderlay.value.xMm)),
  set: (text) => {
    const u = selectedUnderlay.value;
    if (u === null) return;
    const value = parseSignedValue(String(text));
    if (value === null) return;
    editor.setUnderlayPosition(u.id, value, u.yMm);
  },
});
const underlayYField = computed<number | string>({
  get: () => (selectedUnderlay.value === null ? 0 : formatMm(selectedUnderlay.value.yMm)),
  set: (text) => {
    const u = selectedUnderlay.value;
    if (u === null) return;
    const value = parseSignedValue(String(text));
    if (value === null) return;
    editor.setUnderlayPosition(u.id, u.xMm, value);
  },
});
const underlayRotationField = computed<number | string>({
  get: () => (selectedUnderlay.value === null ? 0 : formatDegrees(selectedUnderlay.value.rotationDeg)),
  set: (text) => {
    const u = selectedUnderlay.value;
    if (u === null) return;
    const value = parseSignedValue(String(text));
    if (value === null) return;
    editor.setUnderlayRotationDeg(u.id, value);
  },
});
const underlayScaleXField = computed<number | string>({
  get: () => (selectedUnderlay.value === null ? 0 : formatScale(selectedUnderlay.value.scaleX)),
  set: (text) => {
    const u = selectedUnderlay.value;
    if (u === null) return;
    const value = parseDimensionValue(String(text));
    if (value === null) return;
    editor.setUnderlayScale(u.id, value, u.scaleY);
  },
});
const underlayScaleYField = computed<number | string>({
  get: () => (selectedUnderlay.value === null ? 0 : formatScale(selectedUnderlay.value.scaleY)),
  set: (text) => {
    const u = selectedUnderlay.value;
    if (u === null) return;
    const value = parseDimensionValue(String(text));
    if (value === null) return;
    editor.setUnderlayScale(u.id, u.scaleX, value);
  },
});

function onCanvasClick(
  at: MmPoint,
  hitPointId: string | null,
  suppressAutoHV = false,
  isEntityHit = false,
): void {
  // A quick numeric entry is open (typed length/diameter, or the slot width
  // prompt): canvas clicks are ignored until it is committed or cancelled.
  if (quickEntryKind.value !== null) return;
  // The dimension inline input is open: a canvas click must not also start a
  // new placement underneath it.
  if (editor.dimensionDraft !== null) return;
  // The calibrate action's own inline input is open: same guard.
  if (editor.calibrateDraft !== null) return;
  if (editor.calibrating) {
    editor.clearPendingClicks();
    editor.addCalibrateClick(at);
    return;
  }
  switch (activeTool.value) {
    case 'select':
      break;
    case 'line': {
      if (hitPointId !== null && chainTailId.value !== null) {
        editor.closeChainTo(hitPointId);
      } else {
        editor.appendChainPoint(at, hitPointId ?? undefined, suppressAutoHV);
      }
      scheduleSolve();
      break;
    }
    case 'arcThreePoint': {
      pendingClicks.value.push(at);
      pendingHitPointIds.value.push(hitPointId);
      if (pendingClicks.value.length === 3) {
        const [start, end, through] = pendingClicks.value;
        const startHitId = pendingHitPointIds.value[0] ?? undefined;
        const endHitId = pendingHitPointIds.value[1] ?? undefined;
        const added = editor.addThreePointArc(start, end, through, false, endHitId, startHitId);
        if (!added) toolHint.value = 'Those three points are on one line; an arc needs a curve. Pick again.';
        pendingClicks.value = [];
        pendingHitPointIds.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'arcTangent': {
      // Tangent continuation: a three-point arc from the chain tail, with a
      // tangent constraint added between the chain's previous segment and
      // the new arc; the drawing click places the arc end and a through point.
      pendingClicks.value.push(at);
      pendingHitPointIds.value.push(hitPointId);
      if (pendingClicks.value.length === 2) {
        const [end, through] = pendingClicks.value;
        const endHitId = pendingHitPointIds.value[0] ?? undefined;
        const tail = sketch.value.entities.find((e) => e.id === chainTailId.value);
        if (tail !== undefined && tail.kind === 'point') {
          editor.addThreePointArc({ x: tail.x, y: tail.y }, end, through, true, endHitId);
        }
        pendingClicks.value = [];
        pendingHitPointIds.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'circle': {
      pendingClicks.value.push(at);
      pendingHitPointIds.value.push(hitPointId);
      if (pendingClicks.value.length === 2) {
        const [center, rim] = pendingClicks.value;
        const centerHitId = pendingHitPointIds.value[0] ?? undefined;
        editor.addCircle(center, Math.hypot(rim.x - center.x, rim.y - center.y), centerHitId);
        pendingClicks.value = [];
        pendingHitPointIds.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'rectangle': {
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 2) {
        const [a, b] = pendingClicks.value;
        editor.addRectangle(a, b);
        editor.clearPendingClicks();
        scheduleSolve();
      }
      break;
    }
    case 'slot': {
      // Defends against a stale pendingClicks: normally cancelQuickEntry
      // clears it when the width prompt is dismissed, but if a click ever
      // lands with both axis ends already picked, reopen the prompt instead
      // of appending a third point that the prompt would never consume.
      if (pendingClicks.value.length >= 2) {
        openQuickEntry('slotWidth', '');
        break;
      }
      pendingClicks.value.push(at);
      // The width prompt opens on its own once both axis ends are picked,
      // rather than waiting for a keypress like the line/circle quick entry;
      // pendingClicks stays populated until commitQuickEntry consumes it.
      if (pendingClicks.value.length === 2) {
        openQuickEntry('slotWidth', '');
      }
      break;
    }
    case 'mirror': {
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 2) {
        const [a, b] = pendingClicks.value;
        editor.addMirrorLine(a, b);
        editor.clearPendingClicks();
        scheduleSolve();
      }
      break;
    }
    case 'dimension': {
      // A pending resolved selection: this click places the label at the
      // cursor and opens the inline input (SketchCanvas renders it).
      if (dimensionPending.value !== null) {
        // A click that hits an existing sketch point is the start of
        // combining a second entity into the pending selection (a line then
        // a point resolves to a point-line distance, a point then a point to
        // a distance), routed through onEntityClick exactly like a
        // line/arc/circle click. Points have no separate entityClick emitter
        // (SketchCanvas only wires @click.stop on entity paths, not point
        // markers, and the select-tool-only pointerdown/up drag flow never
        // fires for the dimension tool), so this canvasClick is the only
        // place a point click reaches the combine path; without this branch
        // it was a dead click, since isEntityHit is true for a point hit too
        // and the fallback below would otherwise swallow it. A click that
        // hits a line/arc/circle instead (hitPointId null, isEntityHit true)
        // is still handled by that entity's own entityClick emitter, fired
        // separately after this pointerdown-driven canvasClick. Only a
        // genuine background click (neither a point nor another entity)
        // places the pending dimension's label.
        if (hitPointId !== null) {
          onEntityClick(hitPointId);
        } else if (!isEntityHit) {
          editor.placeDimensionDraft(at);
        }
        break;
      }
      // No pending selection yet: a click on an existing sketch point picks
      // it, the same way a line/arc/circle click does via entityClick (see
      // SketchCanvas's per-entity click handlers). A bare background click
      // does nothing.
      if (hitPointId !== null) onEntityClick(hitPointId);
      break;
    }
    default:
      assertNever(activeTool.value);
  }
}

/** True while a point drag is in progress, so the drag's history snapshot is
 * pushed exactly once, at the first move, not on every pointermove. */
const dragActive = ref(false);

function onPointDrag(pointId: string, at: MmPoint): void {
  if (!dragActive.value) {
    dragActive.value = true;
    editor.beginPointDrag();
  }
  void editor.solveNow({ pointId, xMm: at.x, yMm: at.y });
}

function onPointDragEnd(): void {
  if (dragActive.value) editor.endPointDrag();
  dragActive.value = false;
  void editor.solveNow();
}

/** Merges the dragged point onto the release target with a coincident
 * constraint, then re-solves so the merge takes effect immediately. The
 * coincident constraint is added while the drag's history scope is still
 * open (closed after), so the merge joins the drag's single undo step
 * instead of pushing a second one. */
function onPointDragMerge(draggedId: string, targetId: string): void {
  editor.addCoincidentIfAbsent(draggedId, targetId);
  if (dragActive.value) editor.endPointDrag();
  dragActive.value = false;
  void editor.solveNow();
}

/** Undoes the last sketch mutation, if any, and reschedules the solve. */
function undoAction(): void {
  editor.undo();
  scheduleSolve();
}

/** Re-applies the last undone mutation, if any, and reschedules the solve. */
function redoAction(): void {
  editor.redo();
  scheduleSolve();
}

/** Deletes the current selection, if any, and reschedules the solve. A
 * selected constraint (from clicking its glyph) takes priority, extending
 * the same delete path the entity selection uses. */
function deleteSelection(): void {
  if (editor.selectedConstraintId !== null) {
    editor.removeConstraint(editor.selectedConstraintId);
    scheduleSolve();
    return;
  }
  if (editor.selectedIds.length === 0) return;
  editor.deleteEntities([...editor.selectedIds]);
  scheduleSolve();
}

/** True while the keyboard focus is on a text input, so Delete and Escape do
 * not interrupt typing (a dimension value, the calibration length, and so on). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Delete and Backspace remove the current selection. Escape cancels an open
 * line/arc chain first; with no chain open it clears the selection instead.
 * Only one of the two Escape behaviors happens per press.
 */
/** A single digit, decimal point or minus sign: the first keystroke that
 * opens the typed-length/diameter quick entry. */
function isNumericStartKey(key: string): boolean {
  return /^[0-9.]$/.test(key);
}

function onWorkspaceKeydown(event: KeyboardEvent): void {
  if (isTypingTarget(event.target)) return;
  const withModifier = event.ctrlKey || event.metaKey;
  if (withModifier && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undoAction();
    return;
  }
  if (
    withModifier &&
    ((event.shiftKey && event.key.toLowerCase() === 'z') || event.key.toLowerCase() === 'y')
  ) {
    event.preventDefault();
    redoAction();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    deleteSelection();
    return;
  }
  if (event.key === 'Escape') {
    // The dimension inline input intercepts Escape itself via @keyup.esc
    // (isTypingTarget above returns before this handler runs while it has
    // focus); this branch only covers a pending resolved selection awaiting
    // its placement click, which has no input focused yet.
    if (dimensionPending.value !== null) {
      dimensionPending.value = null;
      editor.selectedIds = [];
      return;
    }
    // Clears the multi-click tool's pending picks first, so Escape during a
    // three-point arc or mirror line drops the partial pick instead of only
    // ending the line/arc chain (or doing nothing, for tools with no chain).
    if (pendingClicks.value.length > 0) {
      editor.clearPendingClicks();
    } else if (chainTailId.value !== null) {
      // Escape ends the chain tool's open chain (task F): return to select,
      // the same as closeChainTo does when the chain closes by clicking.
      editor.endChain();
      selectTool('select');
    } else if (editor.calibrating !== null || editor.calibrateDraft !== null) {
      editor.cancelCalibrateUnderlay();
    } else if (editor.selectedConstraintId !== null) {
      editor.selectedConstraintId = null;
    } else if (editor.selectedIds.length > 0) {
      editor.selectedIds = [];
    } else if (editor.selectedUnderlayId !== null) {
      editor.deselectUnderlay();
    } else if (activeTool.value === 'dimension') {
      // Nothing pending or selected: Escape exits the dimension tool to select.
      selectTool('select');
    }
    return;
  }
  if (quickEntryKind.value === null && quickEntryApplicable.value !== null && isNumericStartKey(event.key)) {
    openQuickEntry(quickEntryApplicable.value, event.key);
  }
}

onMounted(() => window.addEventListener('keydown', onWorkspaceKeydown));
onUnmounted(() => window.removeEventListener('keydown', onWorkspaceKeydown));
</script>

<template>
  <div class="sketch-workspace">
    <v-toolbar density="compact" class="tool-toolbar">
      <v-btn-toggle :model-value="activeTool" mandatory density="compact">
        <v-btn
          v-for="t in toolButtons"
          :key="t.tool"
          :value="t.tool"
          icon
          density="compact"
          @click="selectTool(t.tool)"
        >
          <v-icon v-if="t.icon">{{ t.icon }}</v-icon>
          <svg
            v-else
            class="tangent-arc-icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          >
            <path d="M3 17 L11 17 C 16 17 16 5 21 5" />
          </svg>
          <v-tooltip activator="parent" location="bottom">{{ t.label }}</v-tooltip>
        </v-btn>
      </v-btn-toggle>
      <v-spacer />
      <v-btn
        icon
        density="compact"
        variant="text"
        :disabled="editor.historyStack.length === 0"
        @click="undoAction"
      >
        <v-icon>mdi-undo</v-icon>
        <v-tooltip activator="parent" location="bottom">Undo</v-tooltip>
      </v-btn>
      <v-btn
        icon
        density="compact"
        variant="text"
        :disabled="editor.redoStack.length === 0"
        @click="redoAction"
      >
        <v-icon>mdi-redo</v-icon>
        <v-tooltip activator="parent" location="bottom">Redo</v-tooltip>
      </v-btn>
      <v-btn
        icon
        density="compact"
        variant="text"
        :disabled="editor.selectedIds.length === 0 && editor.selectedConstraintId === null"
        @click="deleteSelection"
      >
        <v-icon>mdi-delete-outline</v-icon>
        <v-tooltip activator="parent" location="bottom">Delete selection</v-tooltip>
      </v-btn>
      <v-btn
        icon
        density="compact"
        variant="text"
        @click="editor.glyphsVisible = !editor.glyphsVisible"
      >
        <v-icon>{{ editor.glyphsVisible ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}</v-icon>
        <v-tooltip activator="parent" location="bottom">
          {{ editor.glyphsVisible ? 'Hide constraint glyphs' : 'Show constraint glyphs' }}
        </v-tooltip>
      </v-btn>
      <v-btn
        icon
        density="compact"
        variant="text"
        :disabled="sketchCanvas === null || !sketchCanvas.canFit"
        @click="sketchCanvas?.fitToView()"
      >
        <v-icon>mdi-fit-to-page-outline</v-icon>
        <v-tooltip activator="parent" location="bottom">Fit the sketch in view.</v-tooltip>
      </v-btn>
      <v-menu :close-on-content-click="false" location="bottom end">
        <template #activator="{ props: menuProps }">
          <v-btn icon density="compact" variant="text" v-bind="menuProps">
            <v-icon>mdi-image-outline</v-icon>
            <v-tooltip activator="parent" location="bottom">Reference photo</v-tooltip>
          </v-btn>
        </template>
        <v-card class="photo-menu pa-3">
          <v-file-input
            label="Add a photo"
            density="compact"
            hide-details
            accept="image/*"
            @update:model-value="onUnderlayFile"
          />
          <div
            v-for="u in editor.underlays"
            :key="u.id"
            class="photo-menu-canvas mt-4"
            :class="{ 'photo-menu-canvas--selected': u.id === editor.selectedUnderlayId }"
            @click="editor.selectUnderlay(u.id)"
          >
            <p class="photo-menu-canvas-label">{{ underlayLabel(u.id) }}</p>
            <v-slider
              :model-value="u.opacityPct"
              min="0"
              max="100"
              step="5"
              hide-details
              label="Opacity"
              @update:model-value="(v: number) => editor.setUnderlayOpacityPct(u.id, v)"
            />
            <div class="photo-menu-row">
              <v-btn size="small" @click.stop="editor.flipUnderlayHorizontal(u.id)">Flip horizontal</v-btn>
              <v-btn size="small" @click.stop="editor.flipUnderlayVertical(u.id)">Flip vertical</v-btn>
            </div>
            <v-btn
              size="small"
              block
              class="mt-2"
              @click.stop="editor.selectUnderlay(u.id); editor.startCalibrateUnderlay(u.id)"
            >
              Calibrate
            </v-btn>
            <p v-if="editor.calibrating === u.id" class="tool-hint mt-1">
              Click the two ends of a known distance on the photo, then type its real length in mm.
            </p>
            <v-btn
              size="small"
              color="error"
              variant="text"
              block
              class="mt-2"
              @click.stop="editor.removeUnderlay(u.id)"
            >
              Remove photo
            </v-btn>
          </div>
          <template v-if="selectedUnderlay !== null">
            <div class="mt-4 photo-menu-fields">
              <v-text-field
                label="X (mm)"
                density="compact"
                hide-details
                type="number"
                :model-value="underlayXField"
                @change="(e: Event) => (underlayXField = (e.target as HTMLInputElement).value)"
              />
              <v-text-field
                label="Y (mm)"
                density="compact"
                hide-details
                type="number"
                :model-value="underlayYField"
                @change="(e: Event) => (underlayYField = (e.target as HTMLInputElement).value)"
              />
              <v-text-field
                label="Rotation (deg)"
                density="compact"
                hide-details
                type="number"
                :model-value="underlayRotationField"
                @change="(e: Event) => (underlayRotationField = (e.target as HTMLInputElement).value)"
              />
              <v-text-field
                label="Scale X"
                density="compact"
                hide-details
                type="number"
                :model-value="underlayScaleXField"
                @change="(e: Event) => (underlayScaleXField = (e.target as HTMLInputElement).value)"
              />
              <v-text-field
                label="Scale Y"
                density="compact"
                hide-details
                type="number"
                :model-value="underlayScaleYField"
                @change="(e: Event) => (underlayScaleYField = (e.target as HTMLInputElement).value)"
              />
            </div>
          </template>
        </v-card>
      </v-menu>
      <v-spacer />
      <v-btn variant="text" density="compact" @click="emit('cancel')">Back to sources</v-btn>
      <v-btn color="primary" density="compact" @click="emit('finish')">Use this shape</v-btn>
    </v-toolbar>
    <v-toolbar density="compact" class="constraint-toolbar">
      <div v-if="showConstraintRow" class="v-btn-toggle constraint-group">
        <v-btn
          v-for="kind in availableConstraintKinds"
          :key="kind"
          icon
          density="compact"
          variant="text"
          @click="applyConstraint(kind)"
        >
          <v-icon>{{ constraintButtons[kind].icon }}</v-icon>
          <v-tooltip activator="parent" location="bottom">{{ constraintButtons[kind].label }}</v-tooltip>
        </v-btn>
        <v-btn
          v-if="constructionApplicable"
          icon
          density="compact"
          variant="text"
          @click="toggleConstructionOnSelection"
        >
          <v-icon>mdi-vector-line-dashed</v-icon>
          <v-tooltip activator="parent" location="bottom">Construction</v-tooltip>
        </v-btn>
      </div>
      <template v-else>
        <p class="tool-hint">{{ displayedHint }}</p>
        <v-btn
          v-if="showDrivenToggle"
          size="small"
          density="compact"
          variant="text"
          @click="toggleSelectedDimensionDriven"
        >
          {{ editor.isDimensionDriven(editor.selectedConstraintId!) ? 'Make driving' : 'Make reference' }}
          <v-tooltip activator="parent" location="bottom">{{ drivenToggleLabel }}</v-tooltip>
        </v-btn>
      </template>
    </v-toolbar>
    <v-text-field
      v-if="quickEntryKind !== null"
      v-model="quickEntryText"
      :label="
        quickEntryKind === 'segmentLength'
          ? 'Segment length in mm'
          : quickEntryKind === 'diameter'
            ? 'Circle diameter in mm'
            : 'Slot width in mm'
      "
      density="compact"
      autofocus
      :error="quickEntryErrorText !== null"
      :error-messages="quickEntryErrorText ?? []"
      style="max-width: 200px"
      @keyup.enter="commitQuickEntry"
      @keyup.esc="cancelQuickEntry"
      @blur="onQuickEntryBlur"
    />
    <div class="canvas-holder">
      <SketchCanvas
        ref="sketchCanvas"
        @canvas-click="onCanvasClick"
        @point-drag="onPointDrag"
        @point-drag-end="onPointDragEnd"
        @point-drag-merge="onPointDragMerge"
        @entity-click="(id: string) => onEntityClick(id)"
        @constraint-click="(id: string) => onConstraintClick(id)"
        @request-solve="scheduleSolve"
      />
    </div>
    <div class="status-rows">
      <div
        v-for="(row, i) in statusRows"
        :key="i"
        class="status-row"
        @mouseenter="row.label === 'Conflicting constraint' && (editor.hoveredConstraintId = row.value)"
        @mouseleave="row.label === 'Conflicting constraint' && (editor.hoveredConstraintId = null)"
      >
        <span class="status-label">{{ row.label }}</span>
        <span class="status-value">{{ row.value }}</span>
        <v-btn
          v-if="row.label === 'Conflicting constraint'"
          size="x-small"
          variant="text"
          @click="removeConflicting(row.value)"
        >
          Remove
        </v-btn>
      </div>
      <div v-if="editor.dimensionConflictOffer !== null" class="conflict-offer">
        <p class="conflict-offer-text">This dimension would over-constrain the sketch.</p>
        <v-btn size="x-small" variant="text" @click="keepConflictingDimensionAsReference">
          Keep it as a reference dimension
        </v-btn>
        <v-btn size="x-small" variant="text" @click="removeConflictingDimension">
          Remove it
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sketch-workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.tool-toolbar,
.constraint-toolbar {
  flex-wrap: wrap;
  height: auto;
  padding-top: 4px;
  padding-bottom: 4px;
}
.constraint-toolbar {
  min-height: 48px;
  align-items: center;
}
.photo-menu {
  min-width: 260px;
}
.photo-menu-row {
  display: flex;
  gap: 8px;
}
.photo-menu-canvas {
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 4px;
  padding: 8px;
  cursor: pointer;
}
.photo-menu-canvas--selected {
  border-color: rgb(var(--v-theme-primary));
}
.photo-menu-canvas-label {
  font-weight: 600;
  margin-bottom: 4px;
}
.photo-menu-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tangent-arc-icon {
  display: block;
}
.canvas-holder {
  flex: 1;
  min-height: 320px;
}
.tool-hint {
  margin: 0 12px;
  font-size: 0.85rem;
  color: rgba(0, 0, 0, 0.6);
}
.status-rows {
  padding: 4px 12px;
  font-size: 0.85rem;
}
.status-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.status-label {
  color: rgba(0, 0, 0, 0.6);
  min-width: 170px;
}
.conflict-offer {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.conflict-offer-text {
  margin: 0;
}
</style>
