<script setup lang="ts">
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor, type SketchTool } from '../../../stores/sketchEditor';
import SketchCanvas from './SketchCanvas.vue';
import type { MmPoint } from '../../../engine/trace/types';
import { assertNever } from '../../../engine/plan/types';

const emit = defineEmits<{
  (e: 'finish'): void;
  (e: 'cancel'): void;
}>();

const editor = useSketchEditor();
const { activeTool, sketch, chainTailId } = storeToRefs(editor);

/** Multi-click tool buffers: picked mm points awaiting the tool's next click. */
const pendingClicks = ref<MmPoint[]>([]);
/** A one-line hint under the toolbar naming the tool's next expected click. */
const toolHint = ref('');

function selectTool(tool: SketchTool): void {
  activeTool.value = tool;
  pendingClicks.value = [];
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

function onCanvasClick(at: MmPoint, hitPointId: string | null): void {
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
      if (pendingClicks.value.length === 3) {
        const [start, end, through] = pendingClicks.value;
        const added = editor.addThreePointArc(start, end, through);
        if (!added) toolHint.value = 'Those three points are on one line; an arc needs a curve. Pick again.';
        pendingClicks.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'arcTangent': {
      // Tangent continuation: a three-point arc from the chain tail whose
      // tangency is then enforced by a tangent constraint added in Task 9's
      // constraint toolbar; the drawing click places start and end.
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 2) {
        const [end, through] = pendingClicks.value;
        const tail = sketch.value.entities.find((e) => e.id === chainTailId.value);
        if (tail !== undefined && tail.kind === 'point') {
          editor.addThreePointArc({ x: tail.x, y: tail.y }, end, through);
        }
        pendingClicks.value = [];
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
    <p class="tool-hint">{{ toolHint }}</p>
    <div class="canvas-holder">
      <SketchCanvas
        @canvas-click="onCanvasClick"
        @point-drag="onPointDrag"
        @point-drag-end="onPointDragEnd"
        @entity-click="(id: string) => editor.selectedIds.push(id)"
        @dimension-click="() => {}"
      />
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
</style>
