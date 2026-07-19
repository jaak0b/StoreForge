<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { boundsOf, transformTool } from '../../engine/trace/edit';
import { PITCH } from '../../engine/gridfinity/constants';
import type { FingerHole, MmPoint, TracedTool } from '../../engine/trace/types';

/**
 * The Layout mode of the trace-and-layout workspace: a top-down view of the
 * world frame with draggable tools; the bin interior outline and its dotted
 * 42 mm cell boundaries are derived from the layout and move and resize
 * around the tools as they are dragged. While finger-hole mode is
 * active, a pointer drag anywhere in the view draws a finger hole (a short
 * drag places a circle, a longer one an elongated slot) on the tool under the
 * pointer or else on the selected tool; in either mode a drag on an existing
 * hole moves it, and a drag on one of its endpoint handles reshapes it. When
 * the grid is set manually the footprint is fixed, so holes are clamped to
 * the bin interior. All layout mutations go through the store's
 * layout-model wrappers; the view transform is frozen at drag start so the
 * mapping under the pointer never changes mid-drag, and between drags the
 * view is fitted to the bin plus some slack.
 */

const store = useToolTrace();
const { tools, placements, selectedToolId, gridX, gridY, gridManual, fingerHoleMode } =
  storeToRefs(store);

const canvas = ref<HTMLCanvasElement | null>(null);

/** Canvas pixel width, following the container width (full-bleed layout). */
const canvasWidth = ref(640);

/** The view never grows taller than this, however wide the container is. */
const MAX_HEIGHT_PX = 640;

/** Drags shorter than this in mm commit a circular hole, not a slot. */
const SLOT_MIN_DRAG_MM = 3;

/** World mm shown around the bin interior when fitting the view. */
const VIEW_SLACK_MM = 15;

/** The world-to-canvas mapping: scale plus the world point at canvas centre. */
interface ViewTransform {
  s: number;
  cxMm: number;
  cyMm: number;
  heightPx: number;
}

/** Fits the view to the derived bin plus slack on every side. */
function fitView(): ViewTransform {
  const bin = store.binPlacement;
  const w = bin.widthMm + 2 * VIEW_SLACK_MM;
  const h = bin.heightMm + 2 * VIEW_SLACK_MM;
  // Fill the container width, but never taller than the height cap; the
  // spare width just shows more world around the bin.
  const s = Math.min(canvasWidth.value / w, MAX_HEIGHT_PX / h);
  return {
    s,
    cxMm: bin.minX + bin.widthMm / 2,
    cyMm: bin.minY + bin.heightMm / 2,
    heightPx: Math.round(h * s),
  };
}

/** Frozen at pointerdown so the viewport never moves mid-drag. */
let frozenView: ViewTransform | null = null;

function currentView(): ViewTransform {
  return frozenView ?? fitView();
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
  const view = currentView();
  const bin = store.binPlacement;
  const s = view.s;
  el.width = canvasWidth.value;
  el.height = view.heightPx;
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, el.width, el.height);
  const toPx = (p: MmPoint): [number, number] => [
    el.width / 2 + (p.x - view.cxMm) * s,
    el.height / 2 + (p.y - view.cyMm) * s,
  ];
  // Interior outline, at the bin's derived world position.
  const [binX, binY] = toPx({ x: bin.minX, y: bin.minY });
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(binX, binY, bin.widthMm * s, bin.heightMm * s);
  // Dotted lines on the 42 mm cell boundaries, so it is visible which grid
  // cells the layout occupies and where to drag tools to shrink the bin.
  ctx.save();
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  const binCxMm = bin.minX + bin.widthMm / 2;
  const binCyMm = bin.minY + bin.heightMm / 2;
  for (let k = 1; k < bin.gridX; k++) {
    const [x] = toPx({ x: binCxMm + (k - bin.gridX / 2) * PITCH, y: 0 });
    ctx.beginPath();
    ctx.moveTo(x, binY);
    ctx.lineTo(x, binY + bin.heightMm * s);
    ctx.stroke();
  }
  for (let k = 1; k < bin.gridY; k++) {
    const [, y] = toPx({ x: 0, y: binCyMm + (k - bin.gridY / 2) * PITCH });
    ctx.beginPath();
    ctx.moveTo(binX, y);
    ctx.lineTo(binX + bin.widthMm * s, y);
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
      // Endpoint handles, on the selected tool's capsules only: they mark
      // where a press grabs one end and leaves the other one fixed.
      if (selected && hole.x2 !== undefined && hole.y2 !== undefined) {
        ctx.fillStyle = '#9c27b0';
        for (const end of [
          { x: hole.x, y: hole.y },
          { x: hole.x2, y: hole.y2 },
        ]) {
          const [hx, hy] = toPx({ x: end.x + placement.xMm, y: end.y + placement.yMm });
          ctx.beginPath();
          ctx.arc(hx, hy, 3, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }
  }
  // A dashed bounding box marks the selected tool, so the docked toolbar's
  // target stays clear on the canvas.
  const selected =
    selectedToolId.value !== null
      ? tools.value.find((t) => t.id === selectedToolId.value) ?? null
      : null;
  const selectedPlacement = selected !== null ? store.placementOf(selected.id) : undefined;
  if (selected !== null && selectedPlacement !== undefined) {
    const bounds = boundsOf(
      transformTool(selected.outline, selected.rotationDeg, selected.mirrored),
    );
    const [x0, y0] = toPx({
      x: bounds.minX + selectedPlacement.xMm,
      y: bounds.minY + selectedPlacement.yMm,
    });
    ctx.save();
    ctx.strokeStyle = '#42a5f5';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    const pad = 4;
    ctx.strokeRect(
      x0 - pad,
      y0 - pad,
      (bounds.maxX - bounds.minX) * s + 2 * pad,
      (bounds.maxY - bounds.minY) * s + 2 * pad,
    );
    ctx.restore();
  }
}

watch(
  [tools, placements, gridX, gridY, gridManual, selectedToolId, canvasWidth],
  () => void nextTick(draw),
  { deep: true },
);

// The canvas fills its container; a ResizeObserver keeps the pixel width in
// step with the layout (drawer opening and closing, window resizes).
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const parent = canvas.value?.parentElement;
  if (parent) {
    resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0].contentRect.width);
      if (width > 0) canvasWidth.value = Math.max(320, width);
    });
    resizeObserver.observe(parent);
  }
  void nextTick(draw);
});
onUnmounted(() => resizeObserver?.disconnect());

// Pointer interaction. All three drags (move a tool, move a hole, stretch a
// new hole) advance by mm deltas from the last pointer position. The view
// transform is captured at drag start and held until the drop, so even
// while the derived bin resizes mid-drag the pointer mapping does not move
// under the pointer.
type DragKind = 'tool' | 'hole' | 'place' | 'endpoint';
let dragKind: DragKind | null = null;
let draggingToolId: string | null = null;
let draggingHole: FingerHole | null = null;
/** Which endpoint of draggingHole an 'endpoint' drag moves. */
let draggingEnd: 'start' | 'end' = 'end';
let lastMm: MmPoint | null = null;

function clientToMm(clientX: number, clientY: number): MmPoint {
  const el = canvas.value!;
  const rect = el.getBoundingClientRect();
  const view = currentView();
  return {
    x: view.cxMm + (((clientX - rect.left) / rect.width) * el.width - el.width / 2) / view.s,
    y: view.cyMm + (((clientY - rect.top) / rect.height) * el.height - el.height / 2) / view.s,
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

/**
 * An endpoint handle of a placed hole under the point, with its tool. A
 * capsule offers both of its endpoints; a plain circle offers its centre as
 * the anchor of a stretch, but only in finger-hole mode, so that outside that
 * mode a press on a circle still moves it. The handle zone is the hole's own
 * radius, so it scales with the hole. The end endpoint wins over the start
 * one where the two zones overlap, matching a fresh press-and-drag.
 */
function endpointAt(
  p: MmPoint,
): { tool: TracedTool; hole: FingerHole; end: 'start' | 'end' } | null {
  for (let i = tools.value.length - 1; i >= 0; i -= 1) {
    const tool = tools.value[i];
    const placement = store.placementOf(tool.id);
    if (placement === undefined) continue;
    for (const hole of tool.fingerHoles) {
      const r = hole.diameterMm / 2;
      const a = { x: hole.x + placement.xMm, y: hole.y + placement.yMm };
      if (hole.x2 === undefined || hole.y2 === undefined) {
        if (fingerHoleMode.value && Math.hypot(p.x - a.x, p.y - a.y) <= r) {
          // The circle's centre stays put and the drag grows the second end.
          return { tool, hole, end: 'end' };
        }
        continue;
      }
      const b = { x: hole.x2 + placement.xMm, y: hole.y2 + placement.yMm };
      if (Math.hypot(p.x - b.x, p.y - b.y) <= r) return { tool, hole, end: 'end' };
      if (Math.hypot(p.x - a.x, p.y - a.y) <= r) return { tool, hole, end: 'start' };
    }
  }
  return null;
}

/**
 * Keeps a hole's disc inside the bin interior. Only a manual grid has a fixed
 * footprint; while the footprint auto-refits the bin grows to contain the
 * hole, so the point is left alone.
 */
function clampToBin(p: MmPoint, diameterMm: number): MmPoint {
  if (!gridManual.value) return p;
  const bin = store.binPlacement;
  const r = diameterMm / 2;
  const clampAxis = (v: number, min: number, extent: number): number => {
    const lo = min + r;
    const hi = min + extent - r;
    // A hole wider than the interior has no valid span; centre it instead.
    if (hi < lo) return min + extent / 2;
    return Math.min(Math.max(v, lo), hi);
  };
  return {
    x: clampAxis(p.x, bin.minX, bin.widthMm),
    y: clampAxis(p.y, bin.minY, bin.heightMm),
  };
}

/**
 * The part of a move delta that keeps every endpoint's disc inside the bin
 * interior, using the same clamp as the placement and stretch paths.
 */
function clampMove(hole: FingerHole, placement: { xMm: number; yMm: number }, d: MmPoint): MmPoint {
  const ends = [{ x: hole.x, y: hole.y }];
  if (hole.x2 !== undefined && hole.y2 !== undefined) ends.push({ x: hole.x2, y: hole.y2 });
  let dx = d.x;
  let dy = d.y;
  for (const end of ends) {
    const target = { x: end.x + placement.xMm + d.x, y: end.y + placement.yMm + d.y };
    const clamped = clampToBin(target, hole.diameterMm);
    // Keep the most restrictive shift per axis, so the hole stays rigid.
    const ex = clamped.x - (end.x + placement.xMm);
    const ey = clamped.y - (end.y + placement.yMm);
    if (Math.abs(ex) < Math.abs(dx)) dx = ex;
    if (Math.abs(ey) < Math.abs(dy)) dy = ey;
  }
  return { x: dx, y: dy };
}

/** The tool a new hole belongs to: the one under the pointer, else the selected one. */
function owningTool(p: MmPoint): TracedTool | null {
  const under = toolAt(p);
  if (under !== null) return under;
  if (selectedToolId.value === null) return null;
  return tools.value.find((t) => t.id === selectedToolId.value) ?? null;
}

function onPointerDown(event: PointerEvent): void {
  frozenView = fitView();
  const p = clientToMm(event.clientX, event.clientY);
  lastMm = p;
  // An endpoint handle of a placed hole reshapes that hole, and takes
  // priority over moving it or placing a new one.
  const endHit = endpointAt(p);
  if (endHit !== null) {
    draggingHole = endHit.hole;
    draggingToolId = endHit.tool.id;
    draggingEnd = endHit.end;
    dragKind = 'endpoint';
    selectedToolId.value = endHit.tool.id;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    return;
  }
  // An existing hole under the pointer is dragged in either mode; in
  // finger-hole mode a press anywhere in the view places a new hole.
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
    // A hole may sit anywhere in the bin interior; it belongs to the tool
    // under the pointer, or to the selected tool when there is none.
    const tool = owningTool(p);
    if (tool === null) return;
    const placement = store.placementOf(tool.id);
    if (placement === undefined) return;
    const start = clampToBin(p, store.fingerHoleDiameterMm);
    // The store returns the pushed hole, reactive inside the store; drag the
    // reactive one so mutations redraw the canvas.
    draggingHole = store.addFingerHole(tool.id, {
      x: start.x - placement.xMm,
      y: start.y - placement.yMm,
      x2: start.x - placement.xMm,
      y2: start.y - placement.yMm,
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
  if (endpointAt(p) !== null) {
    // Same cursor as stretching a hole out, which is what this drag does.
    hoverCursor.value = 'crosshair';
  } else if (holeAt(p) !== null) {
    hoverCursor.value = 'grab';
  } else if (fingerHoleMode.value) {
    hoverCursor.value = owningTool(p) !== null ? 'crosshair' : 'default';
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
  const placement = draggingToolId !== null ? store.placementOf(draggingToolId) : undefined;
  if (placement === undefined) return;
  if (dragKind === 'hole') {
    const d = clampMove(draggingHole, placement, { x: dx, y: dy });
    store.moveFingerHole(draggingHole, d.x, d.y);
    return;
  }
  // 'place' and 'endpoint': one end stays put and the drag moves the other.
  const target = clampToBin(p, draggingHole.diameterMm);
  const xMm = target.x - placement.xMm;
  const yMm = target.y - placement.yMm;
  if (dragKind === 'endpoint' && draggingEnd === 'start') {
    store.stretchFingerHoleStart(draggingHole, xMm, yMm);
    return;
  }
  store.stretchFingerHole(draggingHole, xMm, yMm);
}

function onPointerUp(): void {
  if ((dragKind === 'place' || dragKind === 'endpoint') && draggingHole !== null) {
    // A short drag, or an endpoint dropped on its partner, collapses back to
    // a circular hole.
    store.finishFingerHole(draggingHole, SLOT_MIN_DRAG_MM);
  }
  dragKind = null;
  draggingToolId = null;
  draggingHole = null;
  lastMm = null;
  // Unfreeze and refit the view to wherever the bin ended up.
  frozenView = null;
  draw();
}
</script>

<template>
  <canvas
    ref="canvas"
    class="layout-canvas"
    :style="{ cursor: hoverCursor }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  />
</template>

<style scoped>
.layout-canvas {
  display: block;
  max-width: 100%;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  touch-action: none;
}
</style>
