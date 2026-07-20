<script setup lang="ts">
import { ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../../stores/binDesigner';
import {
  segmentDistance,
  useTopDownCanvas,
  type DrawContext,
} from '../../composables/useTopDownCanvas';
import { binInteriorSizeMm, DIVIDER_THICKNESS } from '../../engine/gridfinity/constants';
import { wallLength, type DividerWall } from '../../engine/gridfinity/dividerModel';
import type { MmPoint } from '../../engine/trace/types';

/**
 * The top-down divider wall editor: a plan view of the bin interior with each
 * divider wall drawn at its printed thickness. A press on a wall selects it
 * and drags it; a press on an endpoint handle of the selected wall reshapes
 * it, changing its length and its angle freely; a drag starting on empty
 * interior draws a new wall from the press point to the release point.
 * Pressing Delete removes the selected wall. Every mutation goes through the
 * designer store's divider-model wrappers, so no geometry or clamping math
 * lives here; the view math comes from the shared top-down canvas.
 */

const store = useBinDesigner();
const { walls, gridX, gridY, selectedWallIndex } = storeToRefs(store);

/** How far outside a wall's own thickness a press still picks it. */
const PICK_SLACK_MM = 1.5;

/** Grab radius of an endpoint handle, in mm. */
const HANDLE_MM = 2.5;

/** Radius an endpoint handle is drawn at, in pixels. */
const HANDLE_PX = 4;

/**
 * How near a snap target an edit must come, in css pixels, before the target
 * attracts it. A screen-space affordance rather than a geometric figure: it is
 * how close the user's hand has to be, so it is fixed on screen and the mm
 * equivalent the model works in is derived from it through the view scale in
 * force. Twice the drawn endpoint handle, the smallest radius that still feels
 * like a comfortable pointer target, so the freely positionable gap between
 * targets stays as wide as possible.
 */
const SNAP_PULL_PX = 2 * HANDLE_PX;

const hoveredIndex = ref<number | null>(null);

const {
  setCanvas,
  canvasWidth,
  hoverCursor,
  scheduleDraw,
  currentView,
  clientToMm,
  freezeView,
  releaseView,
} = useTopDownCanvas({
    bin: () => {
      // The wall model is bin-local with the bin centred on the origin, so
      // the interior rectangle is the footprint's interior about the origin.
      const widthMm = binInteriorSizeMm(gridX.value);
      const heightMm = binInteriorSizeMm(gridY.value);
      return {
        gridX: gridX.value,
        gridY: gridY.value,
        minX: -widthMm / 2,
        minY: -heightMm / 2,
        widthMm,
        heightMm,
      };
    },
    drawContent,
    // The editor sits inside a form column, not a full workspace, so it gets
    // a shorter height cap than the trace layout view.
    maxHeightPx: 320,
  });

function drawContent({ ctx, view, toPx }: DrawContext): void {
  ctx.lineCap = 'butt';
  walls.value.forEach((wall, index) => {
    const [ax, ay] = toPx({ x: wall.x1, y: wall.y1 });
    const [bx, by] = toPx({ x: wall.x2, y: wall.y2 });
    const selected = index === selectedWallIndex.value;
    const hovered = index === hoveredIndex.value;
    // Walls render at their printed thickness, so the compartments on the
    // canvas are the compartments the bin will actually have.
    ctx.lineWidth = Math.max(1, DIVIDER_THICKNESS * view.s);
    ctx.strokeStyle = selected
      ? '#42a5f5'
      : hovered
        ? 'rgba(255, 152, 0, 1)'
        : 'rgba(255, 152, 0, 0.75)';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // Endpoint handles mark where a press grabs one end and leaves the other
    // one fixed; only the selected wall offers them.
    if (selected) {
      ctx.fillStyle = '#42a5f5';
      for (const [hx, hy] of [
        [ax, ay],
        [bx, by],
      ]) {
        ctx.beginPath();
        ctx.arc(hx, hy, HANDLE_PX, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  });
}

watch([walls, gridX, gridY, selectedWallIndex, hoveredIndex, canvasWidth], scheduleDraw, {
  deep: true,
});

/** The topmost wall under the point, or null. Last drawn wins. */
function wallAt(p: MmPoint): number | null {
  for (let i = walls.value.length - 1; i >= 0; i -= 1) {
    const wall = walls.value[i];
    const distance = segmentDistance(
      p,
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    );
    if (distance <= DIVIDER_THICKNESS / 2 + PICK_SLACK_MM) return i;
  }
  return null;
}

/** Which endpoint of the selected wall the point grabs, or null. */
function endpointAt(p: MmPoint): 1 | 2 | null {
  const wall = store.selectedWall;
  if (wall === null) return null;
  // The second endpoint wins where the two zones overlap, matching a fresh
  // press-and-drag, which always grows the second end.
  if (Math.hypot(p.x - wall.x2, p.y - wall.y2) <= HANDLE_MM) return 2;
  if (Math.hypot(p.x - wall.x1, p.y - wall.y1) <= HANDLE_MM) return 1;
  return null;
}

type DragKind = 'body' | 'endpoint' | 'draw';
let dragKind: DragKind | null = null;
let dragIndex: number | null = null;
let dragEndpoint: 1 | 2 = 2;
/**
 * Where the pointer went down, with the dragged wall as it stood then. A body
 * drag is applied as the total delta from this origin rather than as the
 * increment since the last move, because snapping quantizes the result and a
 * mouse emits many increments smaller than one lattice step; each would round
 * back to zero on its own. The frozen view keeps the mm frame fixed for the
 * gesture, so the origin stays comparable throughout.
 */
let dragStartMm: MmPoint | null = null;
let dragOriginWall: DividerWall | null = null;
/** Where a drag-to-draw started; the new wall's first endpoint. */
let drawStart: MmPoint | null = null;

function onPointerDown(event: PointerEvent): void {
  freezeView();
  // The view is frozen for the gesture, so the pull radius converts once here
  // and stays the same distance on screen for every move that follows.
  store.setSnapToleranceMm(SNAP_PULL_PX / currentView().s);
  const p = clientToMm(event.clientX, event.clientY);
  dragStartMm = p;
  dragOriginWall = null;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  const endpoint = endpointAt(p);
  if (endpoint !== null) {
    dragKind = 'endpoint';
    dragIndex = selectedWallIndex.value;
    dragEndpoint = endpoint;
    return;
  }
  const index = wallAt(p);
  if (index !== null) {
    store.selectWall(index);
    dragKind = 'body';
    dragIndex = index;
    dragOriginWall = { ...walls.value[index] };
    return;
  }
  // Empty interior: the drag draws a new wall. The wall is only created once
  // the drag is long enough to be a wall at all, so a plain click just
  // clears the selection.
  store.selectWall(null);
  dragKind = 'draw';
  drawStart = p;
}

function updateHoverCursor(p: MmPoint): void {
  if (endpointAt(p) !== null) {
    hoverCursor.value = 'crosshair';
    hoveredIndex.value = selectedWallIndex.value;
    return;
  }
  const index = wallAt(p);
  hoveredIndex.value = index;
  hoverCursor.value = index !== null ? 'grab' : 'crosshair';
}

function onPointerMove(event: PointerEvent): void {
  const p = clientToMm(event.clientX, event.clientY);
  if (dragKind === null || dragStartMm === null) {
    updateHoverCursor(p);
    return;
  }
  const dx = p.x - dragStartMm.x;
  const dy = p.y - dragStartMm.y;
  if (dragKind === 'draw') {
    if (drawStart === null) return;
    // Below the minimum wall length there is nothing worth creating yet.
    if (wallLength({ x1: drawStart.x, y1: drawStart.y, x2: p.x, y2: p.y }) < DIVIDER_THICKNESS) {
      return;
    }
    dragIndex = store.addWall({ x1: drawStart.x, y1: drawStart.y, x2: p.x, y2: p.y });
    // The rest of the drag stretches the new wall's second endpoint.
    dragKind = 'endpoint';
    dragEndpoint = 2;
    drawStart = null;
    hoverCursor.value = 'crosshair';
    return;
  }
  if (dragIndex === null) return;
  if (dragKind === 'body') {
    hoverCursor.value = 'grabbing';
    store.moveWall(dragIndex, dx, dy, dragOriginWall ?? undefined);
    return;
  }
  hoverCursor.value = 'crosshair';
  store.moveWallEndpoint(dragIndex, dragEndpoint, p.x, p.y);
}

function onPointerUp(): void {
  dragKind = null;
  dragIndex = null;
  dragStartMm = null;
  dragOriginWall = null;
  drawStart = null;
  releaseView();
}

function onDelete(): void {
  if (selectedWallIndex.value === null) return;
  store.deleteWall(selectedWallIndex.value);
}
</script>

<template>
  <canvas
    :ref="setCanvas"
    class="divider-canvas"
    tabindex="0"
    :style="{ cursor: hoverCursor }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown.delete.prevent="onDelete"
  />
</template>

<style scoped>
.divider-canvas {
  display: block;
  max-width: 100%;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  touch-action: none;
}
</style>
