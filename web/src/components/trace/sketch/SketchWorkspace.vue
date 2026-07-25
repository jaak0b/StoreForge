<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor, type SketchTool } from '../../../stores/sketchEditor';
import SketchCanvas from './SketchCanvas.vue';
import type { MmPoint } from '../../../engine/trace/types';
import type { SketchEntity } from '../../../engine/sketch/model';
import {
  applicableConstraintKinds,
  canToggleConstruction,
  type ApplicableConstraintKind,
} from '../../../engine/sketch/constraintApplicability';
import { constraintKindSentence } from '../../../engine/sketch/constraintGlyphs';
import { assertNever } from '../../../engine/plan/types';
import {
  measureLineLength,
  measureRadius,
  measurePointDistance,
  measureAngleBetweenLines,
} from '../../../engine/sketch/measure';

const emit = defineEmits<{
  (e: 'finish'): void;
  (e: 'cancel'): void;
}>();

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

function selectTool(tool: SketchTool): void {
  activeTool.value = tool;
  editor.clearPendingClicks();
  quickEntryKind.value = null;
  quickEntryText.value = '';
  editor.selectedConstraintId = null;
  editor.endChain();
  switch (tool) {
    case 'select':
      toolHint.value = 'Click an entity to select it, or drag a point to move the geometry.';
      break;
    case 'line':
      toolHint.value =
        'Click to place each corner. Click the first point again to close the outline. ' +
        'Type a number to set the next segment\'s length.';
      break;
    case 'arcThreePoint':
      toolHint.value = 'Click the arc start, then the arc end, then a point the arc passes through.';
      break;
    case 'arcTangent':
      toolHint.value = 'Click the end point of the arc; it continues tangent from the last chain point.';
      break;
    case 'circle':
      toolHint.value =
        'Click the circle center, then a point on the circle. Type a number to set the diameter.';
      break;
    case 'rectangle':
      toolHint.value = 'Click one corner, then the opposite corner.';
      break;
    case 'slot':
      toolHint.value = 'Click the two ends of the slot axis, then type the width.';
      break;
    case 'mirror':
      toolHint.value = 'Click the two ends of the mirror line.';
      break;
    case 'dimension':
      toolHint.value = 'Click one or two entities, then type the value.';
      break;
    default:
      assertNever(tool);
  }
}
selectTool('select');

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
}

/** Commits the quick numeric entry, applying the typed length/diameter/width
 * to the segment, circle or slot being placed, and adding the matching
 * dimension constraint. Silently ignores an unparseable value (the field
 * stays open for another attempt); Escape is the only way to abandon it. */
function commitQuickEntry(): void {
  const kind = quickEntryKind.value;
  if (kind === null) return;
  const value = Number(quickEntryText.value);
  if (!Number.isFinite(value) || value <= 0) return;
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
      editor.appendChainPoint(target);
      if (chainTailSegmentId.value !== null) {
        editor.addDimension({
          kind: 'length', id: editor.nextId(), lineId: chainTailSegmentId.value, mm: value,
        });
      }
      scheduleSolve();
      break;
    }
    case 'diameter': {
      if (pendingClicks.value.length !== 1) break;
      const center = pendingClicks.value[0];
      const centerHitId = pendingHitPointIds.value[0] ?? undefined;
      const circleId = editor.addCircle(center, value / 2, centerHitId);
      editor.addDimension({ kind: 'diameter', id: editor.nextId(), entityId: circleId, mm: value });
      editor.clearPendingClicks();
      scheduleSolve();
      break;
    }
    case 'slotWidth': {
      if (pendingClicks.value.length !== 2) break;
      const [a, b] = pendingClicks.value;
      editor.addSlot(a, b, value);
      editor.clearPendingClicks();
      scheduleSolve();
      break;
    }
    default:
      assertNever(kind);
  }
  quickEntryKind.value = null;
  quickEntryText.value = '';
}

/** Abandons the quick numeric entry without applying anything. */
function cancelQuickEntry(): void {
  quickEntryKind.value = null;
  quickEntryText.value = '';
}

/** Blur commits a parseable value, same as Enter; an unparseable value on
 * blur cancels instead of leaving the field stuck open. */
function onQuickEntryBlur(): void {
  const value = Number(quickEntryText.value);
  if (Number.isFinite(value) && value > 0) {
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

/**
 * The dimension entry field: which constraint is being typed, and its text.
 * isNew marks a placeholder dimension inserted by beginDimensionFromSelection
 * (mm: 10) that cancelDimensionDraft removes if abandoned without a commit.
 */
const dimensionDraft = ref<{ constraintId: string | null; text: string; isNew: boolean } | null>(
  null,
);

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
 * With the dimension tool active, a selection of one or two entities decides
 * the dimension kind: one line is a length, one arc or circle is a radius
 * (Shift for diameter is deliberately not offered; a diameter is typed by
 * picking Diameter in the field's kind menu), two points are a distance, two
 * lines are an angle.
 */
function beginDimensionFromSelection(): void {
  const picked = selectedEntities.value;
  let created: string | null = null;
  let measured = 10;
  if (picked.length === 1 && picked[0].kind === 'line') {
    const id = editor.nextId();
    measured = measureLineLength(sketch.value, picked[0].id);
    editor.addDimension({ kind: 'length', id, lineId: picked[0].id, mm: measured });
    created = id;
  } else if (picked.length === 1 && (picked[0].kind === 'arc' || picked[0].kind === 'circle')) {
    const id = editor.nextId();
    measured = measureRadius(sketch.value, picked[0].id);
    editor.addDimension({ kind: 'radius', id, entityId: picked[0].id, mm: measured });
    created = id;
  } else if (picked.length === 2 && picked.every((e) => e.kind === 'point')) {
    const id = editor.nextId();
    measured = measurePointDistance(sketch.value, picked[0].id, picked[1].id);
    editor.addDimension({ kind: 'distance', id, p1Id: picked[0].id, p2Id: picked[1].id, mm: measured });
    created = id;
  } else if (picked.length === 2 && picked.every((e) => e.kind === 'line')) {
    const id = editor.nextId();
    measured = measureAngleBetweenLines(sketch.value, picked[0].id, picked[1].id);
    editor.addDimension({
      kind: 'angle',
      id,
      l1Id: picked[0].id,
      l2Id: picked[1].id,
      degrees: measured,
    });
    created = id;
  } else {
    toolHint.value =
      'Select one line for a length, an arc or circle for a radius, two points for a distance, or two lines for an angle.';
    return;
  }
  // Pre-filled with the measured current value: Enter without editing locks
  // the dimension at the size it already is, instead of the solver yanking
  // the geometry to an arbitrary placeholder.
  dimensionDraft.value = { constraintId: created, text: String(measured), isNew: true };
  editor.selectedIds = [];
}

function commitDimensionDraft(): void {
  if (dimensionDraft.value === null || dimensionDraft.value.constraintId === null) return;
  const value = Number(dimensionDraft.value.text);
  if (!Number.isFinite(value) || value <= 0) {
    toolHint.value = 'The dimension value must be a number above 0.';
    return;
  }
  editor.setDimensionValue(dimensionDraft.value.constraintId, value);
  dimensionDraft.value = null;
  scheduleSolve();
}

/**
 * Abandons the dimension entry field (Escape only). A freshly inserted
 * placeholder dimension (never committed) is removed so it does not linger
 * in the sketch; editing an existing dimension's value just closes the field.
 */
function cancelDimensionDraft(): void {
  const draft = dimensionDraft.value;
  if (draft !== null && draft.isNew && draft.constraintId !== null) {
    editor.removeConstraint(draft.constraintId);
    scheduleSolve();
  }
  dimensionDraft.value = null;
}

/**
 * Blur commits a parseable value, same as Enter; only an unparseable value on
 * blur falls back to canceling (Escape is the deliberate cancel gesture).
 * This stops the solver seeing a placeholder mid-entry: losing focus with a
 * typed, valid number now locks the dimension at that value.
 */
function onDimensionBlur(): void {
  if (dimensionDraft.value === null) return;
  const value = Number(dimensionDraft.value.text);
  if (Number.isFinite(value) && value > 0) {
    commitDimensionDraft();
  } else {
    cancelDimensionDraft();
  }
}

/** Click-to-edit on an existing on-canvas dimension label. */
function onDimensionClick(constraintId: string): void {
  const c = sketch.value.constraints.find((k) => k.id === constraintId);
  if (c === undefined) return;
  const current = c.kind === 'angle' ? c.degrees : 'mm' in c ? c.mm : null;
  dimensionDraft.value = { constraintId, text: current === null ? '' : String(current), isNew: false };
}

/** Toggles an entity in the selection; with the dimension tool active, a
 * selection that suffices immediately opens the dimension entry field. */
function onEntityClick(entityId: string): void {
  const at = editor.selectedIds.indexOf(entityId);
  if (at === -1) editor.selectedIds.push(entityId);
  else editor.selectedIds.splice(at, 1);
  if (activeTool.value === 'dimension' && editor.selectedIds.length > 0) {
    beginDimensionFromSelection();
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

/** The two clicked ends of the calibration line over the underlay, in current display mm. */
const calibrationClicks = ref<MmPoint[]>([]);
const calibrationLengthText = ref('');
const calibrating = ref(false);

function onUnderlayFile(file: File | null): void {
  if (editor.underlayUrl !== null) URL.revokeObjectURL(editor.underlayUrl);
  editor.underlayUrl = file === null ? null : URL.createObjectURL(file);
  editor.underlayMmPerPixel = file === null ? null : 1;
  calibrationClicks.value = [];
}

/**
 * One-line scale calibration: the user draws one line over the photo and
 * types its real length. Display only; the figure scales the underlay image
 * and never enters the sketch geometry.
 */
function commitCalibration(): void {
  const lengthMm = Number(calibrationLengthText.value);
  if (calibrationClicks.value.length !== 2 || !Number.isFinite(lengthMm) || lengthMm <= 0) {
    toolHint.value = 'Click the two ends of a known distance on the photo, then type its length in mm.';
    return;
  }
  const [a, b] = calibrationClicks.value;
  const drawnMm = Math.hypot(b.x - a.x, b.y - a.y);
  const currentScale = editor.underlayMmPerPixel ?? 1;
  // The clicks are in current display mm; rescale so the drawn span reads lengthMm.
  editor.underlayMmPerPixel = (currentScale * lengthMm) / drawnMm;
  calibrating.value = false;
  calibrationClicks.value = [];
}

function onCanvasClick(at: MmPoint, hitPointId: string | null, suppressAutoHV = false): void {
  // A quick numeric entry is open (typed length/diameter, or the slot width
  // prompt): canvas clicks are ignored until it is committed or cancelled.
  if (quickEntryKind.value !== null) return;
  if (calibrating.value) {
    editor.clearPendingClicks();
    calibrationClicks.value.push(at);
    if (calibrationClicks.value.length > 2) calibrationClicks.value = [at];
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
    case 'dimension':
      // Entity clicks drive dimensioning (Task 9); a bare canvas click does nothing.
      break;
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
    // Clears the multi-click tool's pending picks first, so Escape during a
    // three-point arc or mirror line drops the partial pick instead of only
    // ending the line/arc chain (or doing nothing, for tools with no chain).
    if (pendingClicks.value.length > 0) {
      editor.clearPendingClicks();
    } else if (chainTailId.value !== null) {
      editor.endChain();
    } else if (editor.selectedConstraintId !== null) {
      editor.selectedConstraintId = null;
    } else if (editor.selectedIds.length > 0) {
      editor.selectedIds = [];
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
      <v-menu :close-on-content-click="false" location="bottom end">
        <template #activator="{ props: menuProps }">
          <v-btn icon density="compact" variant="text" v-bind="menuProps">
            <v-icon>mdi-image-outline</v-icon>
            <v-tooltip activator="parent" location="bottom">Reference photo</v-tooltip>
          </v-btn>
        </template>
        <v-card class="photo-menu pa-3">
          <v-file-input
            label="Upload photo"
            density="compact"
            hide-details
            accept="image/*"
            @update:model-value="(f: File | File[] | null) => onUnderlayFile(Array.isArray(f) ? (f[0] ?? null) : f)"
          />
          <v-slider
            v-if="editor.underlayUrl !== null"
            v-model="editor.underlayOpacityPct"
            min="0"
            max="100"
            step="5"
            hide-details
            label="Opacity"
            class="mt-4"
          />
          <v-btn
            v-if="editor.underlayUrl !== null"
            size="small"
            block
            class="mt-4"
            @click="calibrating = true; calibrationClicks = []"
          >
            Set photo scale
          </v-btn>
          <v-text-field
            v-if="calibrating"
            v-model="calibrationLengthText"
            label="Line length in mm"
            density="compact"
            hide-details
            class="mt-4"
            @keyup.enter="commitCalibration"
          />
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
      <p v-else class="tool-hint">{{ displayedHint }}</p>
    </v-toolbar>
    <v-text-field
      v-if="dimensionDraft !== null"
      v-model="dimensionDraft.text"
      label="Dimension value"
      density="compact"
      autofocus
      style="max-width: 200px"
      @keyup.enter="commitDimensionDraft"
      @keyup.esc="cancelDimensionDraft"
      @blur="onDimensionBlur"
    />
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
      style="max-width: 200px"
      @keyup.enter="commitQuickEntry"
      @keyup.esc="cancelQuickEntry"
      @blur="onQuickEntryBlur"
    />
    <div class="canvas-holder">
      <SketchCanvas
        @canvas-click="onCanvasClick"
        @point-drag="onPointDrag"
        @point-drag-end="onPointDragEnd"
        @point-drag-merge="onPointDragMerge"
        @entity-click="(id: string) => onEntityClick(id)"
        @dimension-click="(id: string) => onDimensionClick(id)"
        @constraint-click="(id: string) => onConstraintClick(id)"
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
  min-width: 240px;
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
</style>
