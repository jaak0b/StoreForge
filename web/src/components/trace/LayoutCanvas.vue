<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { AUTO_SIZE_MARGIN_MM, useToolTrace } from '../../stores/toolTrace';
import { autoPocketGridSize } from '../../workerClient';
import { boundsOf, transformTool } from '../../engine/trace/edit';
import { binInteriorSizeMm, PITCH } from '../../engine/gridfinity/constants';
import type { MmPoint, TracedTool } from '../../engine/trace/types';

/**
 * The Layout mode of the trace-and-layout workspace: a top-down view of the
 * bin interior with draggable tools and dotted 42 mm cell boundaries. While
 * the rail's finger-hole mode is active, a click on a tool places a hole
 * instead. The footprint auto-sizes to the layout until the user types a
 * size in the rail.
 */

const store = useToolTrace();
const { tools, placements, selectedToolId, gridX, gridY, gridManual, fingerHoleMode } =
  storeToRefs(store);

const canvas = ref<HTMLCanvasElement | null>(null);
const errorMessage = ref<string | null>(null);

const CANVAS_WIDTH = 640;

// mm to canvas pixel mapping, bin centre at canvas centre.
function mmScale(): number {
  const interiorX = binInteriorSizeMm(gridX.value);
  const interiorY = binInteriorSizeMm(gridY.value);
  const pad = 20;
  return Math.min(
    (CANVAS_WIDTH - pad) / interiorX,
    ((CANVAS_WIDTH * interiorY) / interiorX - pad) / interiorY,
  );
}

function draw(): void {
  const el = canvas.value;
  if (!el) return;
  const interiorX = binInteriorSizeMm(gridX.value);
  const interiorY = binInteriorSizeMm(gridY.value);
  const s = mmScale();
  el.width = CANVAS_WIDTH;
  el.height = Math.round((CANVAS_WIDTH * interiorY) / interiorX);
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, el.width, el.height);
  const cx = el.width / 2;
  const cy = el.height / 2;
  const toPx = (p: MmPoint): [number, number] => [cx + p.x * s, cy + p.y * s];
  // Interior outline.
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - (interiorX / 2) * s, cy - (interiorY / 2) * s, interiorX * s, interiorY * s);
  // Dotted lines on the 42 mm cell boundaries, so it is visible which grid
  // cells the layout occupies and where to drag tools to shrink the bin.
  ctx.save();
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (let k = 1; k < gridX.value; k++) {
    const x = cx + (k - gridX.value / 2) * PITCH * s;
    ctx.beginPath();
    ctx.moveTo(x, cy - (interiorY / 2) * s);
    ctx.lineTo(x, cy + (interiorY / 2) * s);
    ctx.stroke();
  }
  for (let k = 1; k < gridY.value; k++) {
    const y = cy + (k - gridY.value / 2) * PITCH * s;
    ctx.beginPath();
    ctx.moveTo(cx - (interiorX / 2) * s, y);
    ctx.lineTo(cx + (interiorX / 2) * s, y);
    ctx.stroke();
  }
  ctx.restore();
  // Tools.
  for (const tool of tools.value) {
    const placement = store.placementOf(tool.id);
    if (placement === undefined) continue;
    const outline = transformTool(tool.outline, tool.rotationDeg, tool.mirrored);
    const selected = tool.id === selectedToolId.value;
    ctx.strokeStyle = selected ? '#42a5f5' : 'rgba(255, 152, 0, 0.9)';
    ctx.fillStyle = selected ? 'rgba(66, 165, 245, 0.18)' : 'rgba(255, 152, 0, 0.12)';
    ctx.lineWidth = selected ? 2.5 : 1.5;
    for (const loop of [outline.outer, ...outline.holes]) {
      ctx.beginPath();
      loop.forEach((p, i) => {
        const [x, y] = toPx({ x: p.x + placement.xMm, y: p.y + placement.yMm });
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.beginPath();
    outline.outer.forEach((p, i) => {
      const [x, y] = toPx({ x: p.x + placement.xMm, y: p.y + placement.yMm });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    for (const hole of tool.fingerHoles) {
      const [x, y] = toPx({ x: hole.x + placement.xMm, y: hole.y + placement.yMm });
      ctx.beginPath();
      ctx.arc(x, y, (hole.diameterMm / 2) * s, 0, 2 * Math.PI);
      ctx.strokeStyle = '#9c27b0';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

watch(
  [tools, placements, gridX, gridY, selectedToolId],
  () => void nextTick(draw),
  { deep: true },
);
onMounted(() => void nextTick(draw));

// Auto footprint sizing, debounced, disabled once the user typed a size.
let autoSizeHandle: ReturnType<typeof setTimeout> | null = null;
watch(
  [tools, placements, gridManual],
  () => {
    if (gridManual.value || placements.value.length === 0) return;
    if (autoSizeHandle !== null) clearTimeout(autoSizeHandle);
    autoSizeHandle = setTimeout(async () => {
      autoSizeHandle = null;
      try {
        const size = await autoPocketGridSize(
          tools.value,
          placements.value,
          AUTO_SIZE_MARGIN_MM,
        );
        errorMessage.value = null;
        gridX.value = size.gridX;
        gridY.value = size.gridY;
      } catch (error) {
        errorMessage.value =
          error instanceof Error ? error.message : 'Sizing the bin failed.';
      }
    }, 300);
  },
  { deep: true, immediate: true },
);

// Dragging tools on the canvas.
let draggingToolId: string | null = null;
let dragStart: MmPoint | null = null;
let dragOrigin: MmPoint | null = null;

function canvasMm(event: PointerEvent | MouseEvent): MmPoint {
  const el = canvas.value!;
  const rect = el.getBoundingClientRect();
  const s = mmScale();
  return {
    x: (((event.clientX - rect.left) / rect.width) * el.width - el.width / 2) / s,
    y: (((event.clientY - rect.top) / rect.height) * el.height - el.height / 2) / s,
  };
}

function toolAt(p: MmPoint): TracedTool | null {
  // Last drawn wins, so iterate back to front.
  for (let i = tools.value.length - 1; i >= 0; i -= 1) {
    const tool = tools.value[i];
    const placement = store.placementOf(tool.id);
    if (placement === undefined) continue;
    const bounds = boundsOf(transformTool(tool.outline, tool.rotationDeg, tool.mirrored));
    if (
      p.x >= bounds.minX + placement.xMm &&
      p.x <= bounds.maxX + placement.xMm &&
      p.y >= bounds.minY + placement.yMm &&
      p.y <= bounds.maxY + placement.yMm
    ) {
      return tool;
    }
  }
  return null;
}

function onPointerDown(event: PointerEvent): void {
  const p = canvasMm(event);
  const tool = toolAt(p);
  if (fingerHoleMode.value) {
    if (tool !== null) {
      const placement = store.placementOf(tool.id)!;
      tool.fingerHoles.push({
        x: p.x - placement.xMm,
        y: p.y - placement.yMm,
        diameterMm: store.fingerHoleDiameterMm,
      });
      selectedToolId.value = tool.id;
    }
    return;
  }
  if (tool === null) {
    selectedToolId.value = null;
    return;
  }
  selectedToolId.value = tool.id;
  const placement = store.placementOf(tool.id)!;
  draggingToolId = tool.id;
  dragStart = p;
  dragOrigin = { x: placement.xMm, y: placement.yMm };
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (draggingToolId === null || dragStart === null || dragOrigin === null) return;
  const p = canvasMm(event);
  const placement = store.placementOf(draggingToolId);
  if (placement === undefined) return;
  placement.xMm = dragOrigin.x + (p.x - dragStart.x);
  placement.yMm = dragOrigin.y + (p.y - dragStart.y);
}

function onPointerUp(): void {
  draggingToolId = null;
  dragStart = null;
  dragOrigin = null;
}
</script>

<template>
  <div>
    <p class="text-body-2 mb-2">
      <b>Drag each tool to its place in the bin.</b> The footprint grows
      automatically until you type a size yourself.
    </p>
    <canvas
      ref="canvas"
      class="layout-canvas"
      :class="{ 'finger-mode': fingerHoleMode }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
    <p v-if="tools.length === 0" class="text-body-2 text-medium-emphasis mt-2">
      Trace a tool in the Trace mode above, or add a basic shape from the
      panel beside the canvas.
    </p>
    <v-alert v-if="errorMessage" type="error" density="compact" class="mt-2">
      {{ errorMessage }}
    </v-alert>
  </div>
</template>

<style scoped>
.layout-canvas {
  max-width: 100%;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  touch-action: none;
  cursor: grab;
}

.layout-canvas.finger-mode {
  cursor: crosshair;
}
</style>
