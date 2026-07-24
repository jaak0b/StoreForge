<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor, type SketchTool } from '../../../stores/sketchEditor';
import SketchCanvas from './SketchCanvas.vue';
import type { MmPoint } from '../../../engine/trace/types';
import type { SketchEntity } from '../../../engine/sketch/model';
import { assertNever } from '../../../engine/plan/types';

const emit = defineEmits<{
  (e: 'finish'): void;
  (e: 'cancel'): void;
}>();

const editor = useSketchEditor();
const { activeTool, sketch, chainTailId, solveState } = storeToRefs(editor);

/** Multi-click tool buffers: picked mm points awaiting the tool's next click. */
const pendingClicks = ref<MmPoint[]>([]);
/** Hit-tested existing point id for each entry in pendingClicks, or null. */
const pendingHitPointIds = ref<(string | null)[]>([]);
/** A one-line hint under the toolbar naming the tool's next expected click. */
const toolHint = ref('');

function selectTool(tool: SketchTool): void {
  activeTool.value = tool;
  pendingClicks.value = [];
  pendingHitPointIds.value = [];
  editor.endChain();
  switch (tool) {
    case 'select':
      toolHint.value = 'Click an entity to select it, or drag a point to move the geometry.';
      break;
    case 'line':
      toolHint.value = 'Click to place each corner. Click the first point again to close the outline.';
      break;
    case 'arcThreePoint':
      toolHint.value = 'Click the arc start, then the arc end, then a point the arc passes through.';
      break;
    case 'arcTangent':
      toolHint.value = 'Click the end point of the arc; it continues tangent from the last chain point.';
      break;
    case 'circle':
      toolHint.value = 'Click the circle center, then a point on the circle.';
      break;
    case 'mirror':
      toolHint.value = 'Click the two ends of the mirror line, then the two points to keep symmetric.';
      break;
    case 'dimension':
      toolHint.value = 'Click one or two entities, then type the value.';
      break;
    default:
      assertNever(tool);
  }
}
selectTool('select');

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

/**
 * With the dimension tool active, a selection of one or two entities decides
 * the dimension kind: one line is a length, one arc or circle is a radius
 * (Shift for diameter is deliberately not offered; a diameter is typed by
 * picking Diameter in the field's kind menu), two points are a distance, two
 * lines are an angle.
 */
function beginDimensionFromSelection(): void {
  const picked = editor.selectedIds.map(entityById).filter((e): e is SketchEntity => e !== undefined);
  let created: string | null = null;
  if (picked.length === 1 && picked[0].kind === 'line') {
    const id = editor.nextId();
    editor.addDimension({ kind: 'length', id, lineId: picked[0].id, mm: 10 });
    created = id;
  } else if (picked.length === 1 && (picked[0].kind === 'arc' || picked[0].kind === 'circle')) {
    const id = editor.nextId();
    editor.addDimension({ kind: 'radius', id, entityId: picked[0].id, mm: 10 });
    created = id;
  } else if (picked.length === 2 && picked.every((e) => e.kind === 'point')) {
    const id = editor.nextId();
    editor.addDimension({ kind: 'distance', id, p1Id: picked[0].id, p2Id: picked[1].id, mm: 10 });
    created = id;
  } else if (picked.length === 2 && picked.every((e) => e.kind === 'line')) {
    const id = editor.nextId();
    editor.addDimension({
      kind: 'angle',
      id,
      l1Id: picked[0].id,
      l2Id: picked[1].id,
      degrees: 90,
    });
    created = id;
  } else {
    toolHint.value =
      'Select one line for a length, an arc or circle for a radius, two points for a distance, or two lines for an angle.';
    return;
  }
  dimensionDraft.value = { constraintId: created, text: '', isNew: true };
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
 * Abandons the dimension entry field. A freshly inserted placeholder
 * dimension (mm: 10, never committed) is removed so it does not linger in
 * the sketch; editing an existing dimension's value just closes the field.
 */
function cancelDimensionDraft(): void {
  const draft = dimensionDraft.value;
  if (draft !== null && draft.isNew && draft.constraintId !== null) {
    editor.removeConstraint(draft.constraintId);
    scheduleSolve();
  }
  dimensionDraft.value = null;
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

/** Applies a constraint to the current selection; each row names its need. */
function applyConstraint(
  kind:
    | 'horizontal'
    | 'vertical'
    | 'parallel'
    | 'perpendicular'
    | 'tangent'
    | 'coincident'
    | 'symmetric',
): void {
  const picked = editor.selectedIds.map(entityById).filter((e): e is SketchEntity => e !== undefined);
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

function onCanvasClick(at: MmPoint, hitPointId: string | null): void {
  if (calibrating.value) {
    pendingClicks.value = [];
    pendingHitPointIds.value = [];
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
        editor.appendChainPoint(at);
      }
      scheduleSolve();
      break;
    }
    case 'arcThreePoint': {
      pendingClicks.value.push(at);
      pendingHitPointIds.value.push(hitPointId);
      if (pendingClicks.value.length === 3) {
        const [start, end, through] = pendingClicks.value;
        const endHitId = pendingHitPointIds.value[1] ?? undefined;
        const added = editor.addThreePointArc(start, end, through, false, endHitId);
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
      if (pendingClicks.value.length === 2) {
        const [center, rim] = pendingClicks.value;
        editor.addCircle(center, Math.hypot(rim.x - center.x, rim.y - center.y));
        pendingClicks.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'mirror': {
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 2) {
        const [a, b] = pendingClicks.value;
        editor.addMirrorLine(a, b);
        pendingClicks.value = [];
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

function onPointDrag(pointId: string, at: MmPoint): void {
  void editor.solveNow({ pointId, xMm: at.x, yMm: at.y });
}

function onPointDragEnd(): void {
  void editor.solveNow();
}
</script>

<template>
  <div class="sketch-workspace">
    <v-toolbar density="compact">
      <v-btn-toggle :model-value="activeTool" mandatory>
        <v-btn value="select" @click="selectTool('select')">Select</v-btn>
        <v-btn value="line" @click="selectTool('line')">Line</v-btn>
        <v-btn value="arcThreePoint" @click="selectTool('arcThreePoint')">Arc</v-btn>
        <v-btn value="arcTangent" @click="selectTool('arcTangent')">Tangent arc</v-btn>
        <v-btn value="circle" @click="selectTool('circle')">Circle</v-btn>
        <v-btn value="mirror" @click="selectTool('mirror')">Mirror line</v-btn>
        <v-btn value="dimension" @click="selectTool('dimension')">Dimension</v-btn>
      </v-btn-toggle>
      <v-spacer />
      <v-btn variant="text" @click="emit('cancel')">Cancel</v-btn>
      <v-btn color="primary" @click="emit('finish')">Use this shape</v-btn>
    </v-toolbar>
    <v-toolbar density="compact">
      <v-btn size="small" @click="applyConstraint('horizontal')">Horizontal</v-btn>
      <v-btn size="small" @click="applyConstraint('vertical')">Vertical</v-btn>
      <v-btn size="small" @click="applyConstraint('parallel')">Parallel</v-btn>
      <v-btn size="small" @click="applyConstraint('perpendicular')">Perpendicular</v-btn>
      <v-btn size="small" @click="applyConstraint('tangent')">Tangent</v-btn>
      <v-btn size="small" @click="applyConstraint('coincident')">Coincident</v-btn>
      <v-btn size="small" @click="applyConstraint('symmetric')">Symmetric</v-btn>
      <v-btn size="small" @click="toggleConstructionOnSelection">Construction</v-btn>
      <v-spacer />
      <v-file-input
        label="Reference photo"
        density="compact"
        hide-details
        style="max-width: 220px"
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
        style="max-width: 140px"
        label="Opacity"
      />
      <v-btn v-if="editor.underlayUrl !== null" size="small" @click="calibrating = true; calibrationClicks = []">
        Set photo scale
      </v-btn>
      <v-text-field
        v-if="calibrating"
        v-model="calibrationLengthText"
        label="Line length in mm"
        density="compact"
        hide-details
        style="max-width: 150px"
        @keyup.enter="commitCalibration"
      />
    </v-toolbar>
    <p class="tool-hint">{{ toolHint }}</p>
    <v-text-field
      v-if="dimensionDraft !== null"
      v-model="dimensionDraft.text"
      label="Dimension value"
      density="compact"
      autofocus
      style="max-width: 200px"
      @keyup.enter="commitDimensionDraft"
      @keyup.esc="cancelDimensionDraft"
      @blur="cancelDimensionDraft"
    />
    <div class="canvas-holder">
      <SketchCanvas
        @canvas-click="onCanvasClick"
        @point-drag="onPointDrag"
        @point-drag-end="onPointDragEnd"
        @entity-click="(id: string) => onEntityClick(id)"
        @dimension-click="(id: string) => onDimensionClick(id)"
      />
    </div>
    <div class="status-rows">
      <div v-for="(row, i) in statusRows" :key="i" class="status-row">
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
.canvas-holder {
  flex: 1;
  min-height: 320px;
}
.tool-hint {
  margin: 4px 12px;
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
