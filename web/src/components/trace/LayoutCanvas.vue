<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { boundsOf, transformTool } from '../../engine/trace/edit';
import { binInteriorSizeMm, PITCH } from '../../engine/gridfinity/constants';
import type { FingerHole, MmPoint, TracedTool } from '../../engine/trace/types';

/**
 * The Layout mode of the trace-and-layout workspace: a top-down view of the
 * bin interior with draggable tools and dotted 42 mm cell boundaries. While
 * the rail's finger-hole mode is active, a pointer drag on free tool area
 * draws a finger hole (a short drag places a circle, a longer one an
 * elongated slot); in either mode a drag on an existing hole moves it. All
 * layout mutations go through the store's layout-model wrappers; the mm
 * scale is frozen at drag start so the mapping under the pointer never
 * changes mid-drag, and a tool drop commits the footprint re-size.
 */

const store = useToolTrace();
const { tools, placements, selectedToolId, gridX, gridY, fingerHoleMode } = storeToRefs(store);

const canvas = ref<HTMLCanvasElement | null>(null);

const CANVAS_WIDTH = 640;

/** Drags shorter than this in mm commit a circular hole, not a slot. */
const SLOT_MIN_DRAG_MM = 3;

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

/** Traces a finger hole (circle or capsule) as the current canvas path. */
function holePath(
  ctx: CanvasRenderingContext2D,
  toPx: (p: MmPoint) => [number, number],
  s: number,
  hole: FingerHole,
): void {
  const [ax, ay] = toPx({ x: hole.x, y: hole.y });
  const [bx, by] = toPx({ x: hole.x2 ?? hole.x, y: hole.y2 ?? hole.y });
  const r = (hole.diameterMm / 2) * s;
  ctx.beginPath();
  if (Math.hypot(bx - ax, by - ay) < 1e-6) {
    ctx.arc(ax, ay, r, 0, 2 * Math.PI);
  } else {
    const theta = Math.atan2(by - ay, bx - ax);
    ctx.arc(bx, by, r, theta - Math.PI / 2, theta + Math.PI / 2);
    ctx.arc(ax, ay, r, theta + Math.PI / 2, theta + (3 * Math.PI) / 2);
    ctx.closePath();
  }
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
      holePath(
        ctx,
        toPx,
        s,
        {
          ...hole,
          x: hole.x + placement.xMm,
          y: hole.y + placement.yMm,
          ...(hole.x2 !== undefined && hole.y2 !== undefined
            ? { x2: hole.x2 + placement.xMm, y2: hole.y2 + placement.yMm }
            : {}),
        },
      );
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

// Pointer interaction. All three drags (move a tool, move a hole, stretch a
// new hole) advance by mm deltas from the last pointer position. The mm
// scale is captured at drag start and held until the drop, so even when a
// finger-hole edit re-sizes the footprint mid-drag the pointer mapping does
// not rescale under the pointer.
type DragKind = 'tool' | 'hole' | 'place';
let dragKind: DragKind | null = null;
let draggingToolId: string | null = null;
let draggingHole: FingerHole | null = null;
let lastMm: MmPoint | null = null;
let dragScale: number | null = null;

function clientToMm(clientX: number, clientY: number): MmPoint {
  const el = canvas.value!;
  const rect = el.getBoundingClientRect();
  const s = dragScale ?? mmScale();
  return {
    x: (((clientX - rect.left) / rect.width) * el.width - el.width / 2) / s,
    y: (((clientY - rect.top) / rect.height) * el.height - el.height / 2) / s,
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

/** Distance from a point to the segment between a and b. */
function segmentDistance(p: MmPoint, a: MmPoint, b: MmPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq < 1e-12
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The topmost finger hole (circle or capsule) under the point, with its tool. */
function holeAt(p: MmPoint): { tool: TracedTool; hole: FingerHole } | null {
  for (let i = tools.value.length - 1; i >= 0; i -= 1) {
    const tool = tools.value[i];
    const placement = store.placementOf(tool.id);
    if (placement === undefined) continue;
    for (const hole of tool.fingerHoles) {
      const a = { x: hole.x + placement.xMm, y: hole.y + placement.yMm };
      const b = {
        x: (hole.x2 ?? hole.x) + placement.xMm,
        y: (hole.y2 ?? hole.y) + placement.yMm,
      };
      if (segmentDistance(p, a, b) <= hole.diameterMm / 2) {
        return { tool, hole };
      }
    }
  }
  return null;
}

function onPointerDown(event: PointerEvent): void {
  dragScale = mmScale();
  const p = clientToMm(event.clientX, event.clientY);
  lastMm = p;
  // An existing hole under the pointer is dragged in either mode; in
  // finger-hole mode only a press on free tool area places a new hole.
  const holeHit = holeAt(p);
  if (holeHit !== null) {
    draggingHole = holeHit.hole;
    draggingToolId = holeHit.tool.id;
    dragKind = 'hole';
    selectedToolId.value = holeHit.tool.id;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    return;
  }
  if (fingerHoleMode.value) {
    const tool = toolAt(p);
    if (tool === null) return;
    const placement = store.placementOf(tool.id)!;
    // The store returns the pushed hole, reactive inside the store; drag the
    // reactive one so mutations redraw the canvas.
    draggingHole = store.addFingerHole(tool.id, {
      x: p.x - placement.xMm,
      y: p.y - placement.yMm,
      x2: p.x - placement.xMm,
      y2: p.y - placement.yMm,
      diameterMm: store.fingerHoleDiameterMm,
    });
    if (draggingHole === null) return;
    draggingToolId = tool.id;
    dragKind = 'place';
    selectedToolId.value = tool.id;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    return;
  }
  const tool = toolAt(p);
  if (tool === null) {
    selectedToolId.value = null;
    return;
  }
  selectedToolId.value = tool.id;
  draggingToolId = tool.id;
  dragKind = 'tool';
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}

/** Cursor over the canvas: grab over draggable holes and tools. */
const hoverCursor = ref('default');

function updateHoverCursor(p: MmPoint): void {
  if (holeAt(p) !== null) {
    hoverCursor.value = 'grab';
  } else if (fingerHoleMode.value) {
    hoverCursor.value = toolAt(p) !== null ? 'crosshair' : 'default';
  } else {
    hoverCursor.value = toolAt(p) !== null ? 'grab' : 'default';
  }
}

function onPointerMove(event: PointerEvent): void {
  if (dragKind === null || lastMm === null) {
    updateHoverCursor(clientToMm(event.clientX, event.clientY));
    return;
  }
  hoverCursor.value = 'grabbing';
  const p = clientToMm(event.clientX, event.clientY);
  const dx = p.x - lastMm.x;
  const dy = p.y - lastMm.y;
  lastMm = p;
  if (dragKind === 'tool') {
    const placement = draggingToolId !== null ? store.placementOf(draggingToolId) : undefined;
    if (placement === undefined) return;
    // A tool move never re-sizes; the drop commits the size-to-fit.
    store.moveTool(placement.toolId, placement.xMm + dx, placement.yMm + dy);
    return;
  }
  if (draggingHole === null) return;
  if (dragKind === 'hole') {
    store.moveFingerHole(draggingHole, dx, dy);
    return;
  }
  // 'place': the start stays put and the drag stretches the second endpoint.
  const placement = draggingToolId !== null ? store.placementOf(draggingToolId) : undefined;
  if (placement === undefined) return;
  store.stretchFingerHole(draggingHole, p.x - placement.xMm, p.y - placement.yMm);
}

function onPointerUp(): void {
  if (dragKind === 'place' && draggingHole !== null) {
    // A short drag collapses back to a circular hole.
    store.finishFingerHole(draggingHole, SLOT_MIN_DRAG_MM);
  }
  if (dragKind === 'tool') {
    // Moving a tool means size-to-fit: a manually typed footprint is
    // discarded and the drop applies the re-sized footprint and the minimal
    // fit-in shift.
    store.dropTool();
  }
  dragKind = null;
  draggingToolId = null;
  draggingHole = null;
  lastMm = null;
  dragScale = null;
}
</script>

<template>
  <div>
    <p class="text-body-2 mb-2">
      <b>Drag each tool to its place in the bin.</b> The bin sizes itself to
      the layout after every drag; a typed footprint holds until the next drag.
    </p>
    <p v-if="fingerHoleMode" class="text-body-2 mb-2">
      <b>Press on a tool to place a finger hole.</b> Drag before releasing to
      stretch it into a slot. Drag an existing hole to move it instead.
    </p>
    <canvas
      ref="canvas"
      class="layout-canvas"
      :style="{ cursor: hoverCursor }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
    <p v-if="tools.length === 0" class="text-body-2 text-medium-emphasis mt-2">
      Trace a tool in the Trace mode above, or add a basic shape from the
      panel beside the canvas.
    </p>
  </div>
</template>

<style scoped>
.layout-canvas {
  max-width: 100%;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  touch-action: none;
}
</style>
