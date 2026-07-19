<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { segmentAt } from '../../visionClient';
import type { BrushStroke, MmPoint, SamPoint, TracedOutline } from '../../engine/trace/types';
import { centroidOf, pointInPolygon } from '../../engine/trace/edit';

/**
 * The Trace mode of the trace-and-layout workspace: click a tool on the
 * rectified sheet to segment it, refine with include and exclude clicks,
 * then accept the traced outline as a tool. A re-trace request from the tool
 * rail preloads an existing tool's stored clicks; accepting then replaces
 * that tool's outline instead of adding a duplicate.
 */

const store = useToolTrace();
const { rectifiedPreview, calibration, embedReady, tools } = storeToRefs(store);

const emit = defineEmits<{ accepted: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const points = ref<SamPoint[]>([]);
const outline = ref<TracedOutline | null>(null);
const iouScore = ref<number | null>(null);
const decodeMs = ref<number | null>(null);
const segmenting = ref(false);
const errorMessage = ref<string | null>(null);

// Brush strokes painted onto the mask (rectified-image pixels), the painting
// mode, and the brush radius in mm. brushSizeMm ranges 1..20.
const strokes = ref<BrushStroke[]>([]);
const brushMode = ref<'off' | 'add' | 'erase'>('off');
const brushSizeMm = ref(4);
// The stroke being painted between pointer down and up; null when not painting.
let activeStroke: BrushStroke | null = null;
// The pointer position in canvas pixels while a paint mode is on, for the ring
// cursor; null when the pointer is off the canvas.
const cursorPx = ref<{ x: number; y: number } | null>(null);

let maskPreview: ImageData | null = null;

// Id of the existing tool being re-traced from its stored clicks.
const retraceToolId = ref<string | null>(null);

// The 1-based number of the tool saved by "Accept and trace next", shown in
// the helper caption until the next click starts the following tool.
const justSavedNumber = ref<number | null>(null);

// Sheet-frame outlines of tools accepted on the current photo, keyed by tool
// id. The store recentres each accepted outline to tool-local mm, discarding
// its sheet position, so the position is kept here for the ghost overlays.
// Tools rehydrated from a saved plan entry have no known sheet position and
// get no ghost until they are re-traced.
const ghostOutlines = new Map<string, TracedOutline>();

// The rail's re-trace button posts the tool id into the store; consume it
// here (also on mount, since the canvas may mount after the request).
watch(
  () => store.retraceRequestId,
  (toolId) => {
    if (toolId === null || segmenting.value) return;
    const tool = store.tools.find((t) => t.id === toolId);
    store.retraceRequestId = null;
    if (tool === undefined || tool.clicks.length === 0) return;
    points.value = JSON.parse(JSON.stringify(tool.clicks)) as SamPoint[];
    strokes.value = tool.brushStrokes
      ? (JSON.parse(JSON.stringify(tool.brushStrokes)) as BrushStroke[])
      : [];
    retraceToolId.value = tool.id;
    void runSegment();
  },
  { immediate: true },
);

function draw(): void {
  const el = canvas.value;
  const preview = rectifiedPreview.value;
  if (!el || preview === null) return;
  el.width = preview.width;
  el.height = preview.height;
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.putImageData(preview, 0, 0);
  if (maskPreview !== null) {
    // The mask overlay carries alpha, so it composites over the sheet.
    const overlay = new OffscreenCanvas(maskPreview.width, maskPreview.height);
    const octx = overlay.getContext('2d');
    if (octx) {
      octx.putImageData(maskPreview, 0, 0);
      ctx.drawImage(overlay, 0, 0);
    }
  }
  const cal = calibration.value;
  if (cal !== null) drawGhosts(ctx, el, cal.mmPerPixel);
  if (outline.value !== null && cal !== null) {
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = 3;
    for (const loop of [outline.value.outer, ...outline.value.holes]) {
      ctx.beginPath();
      loop.forEach((p, i) => {
        const x = p.x / cal.mmPerPixel;
        const y = p.y / cal.mmPerPixel;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }
  for (const point of points.value) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = point.label === 1 ? '#4caf50' : '#f44336';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (cal !== null && brushMode.value !== 'off') {
    // The canvas is drawn at the rectified resolution, so a brush radius in mm
    // converts to canvas pixels with the same mm-per-pixel figure the mask uses.
    const radiusPx = brushSizeMm.value / cal.mmPerPixel;
    if (activeStroke !== null) {
      drawProvisionalStroke(ctx, activeStroke, radiusPx);
    }
    if (cursorPx.value !== null) {
      // Ring cursor showing where the next stroke lands and how wide it is.
      ctx.beginPath();
      ctx.arc(cursorPx.value.x, cursorPx.value.y, radiusPx, 0, 2 * Math.PI);
      ctx.strokeStyle = brushMode.value === 'add' ? '#4285f4' : '#f44336';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

/**
 * Draws a provisional brush stroke on the 2D context as filled vertex discs and
 * thick connecting segments, matching the swept-disc region the mask rasterizer
 * will union or subtract. add is translucent blue, erase translucent red.
 */
function drawProvisionalStroke(
  ctx: CanvasRenderingContext2D,
  stroke: BrushStroke,
  radiusPx: number,
): void {
  ctx.save();
  const color = stroke.mode === 'add' ? 'rgba(66, 133, 244, 0.5)' : 'rgba(244, 67, 54, 0.5)';
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * radiusPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const point of stroke.points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radiusPx, 0, 2 * Math.PI);
    ctx.fill();
  }
  if (stroke.points.length > 1) {
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Where a ghost's number badge sits, in sheet mm: the outer loop's area
 * centroid, or the nearest outer-loop point when the centroid lies inside a
 * through-hole.
 */
function badgeAnchor(ghost: TracedOutline): MmPoint {
  const c = centroidOf(ghost.outer);
  if (!ghost.holes.some((hole) => pointInPolygon(c, hole))) return c;
  let best = ghost.outer[0];
  let bestDist = Infinity;
  for (const p of ghost.outer) {
    const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/** Strokes each accepted tool's outline in muted orange with a numbered badge. */
function drawGhosts(
  ctx: CanvasRenderingContext2D,
  el: HTMLCanvasElement,
  mmPerPixel: number,
): void {
  tools.value.forEach((tool, index) => {
    // A tool being re-traced is not ghosted; its outline is being replaced.
    if (tool.id === retraceToolId.value) return;
    const ghost = ghostOutlines.get(tool.id);
    if (ghost === undefined) return;
    ctx.save();
    // Translucent orange fill in the layout canvas's tool colour, with the
    // holes cut out by an EvenOdd fill of outer plus holes.
    const path = new Path2D();
    for (const loop of [ghost.outer, ...ghost.holes]) {
      loop.forEach((p, i) => {
        const x = p.x / mmPerPixel;
        const y = p.y / mmPerPixel;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    }
    ctx.fillStyle = 'rgba(255, 152, 0, 0.3)';
    ctx.fill(path, 'evenodd');
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#c97a2e';
    ctx.fillStyle = '#c97a2e';
    ctx.lineWidth = 2;
    ctx.stroke(path);
    // Numbered badge on the tool itself: at the outer loop's area centroid,
    // moved to the nearest outer-loop point when the centroid falls inside a
    // through-hole, and clamped inside the canvas.
    const anchor = badgeAnchor(ghost);
    const r = 11;
    const bx = Math.min(Math.max(anchor.x / mmPerPixel, r + 2), el.width - r - 2);
    const by = Math.min(Math.max(anchor.y / mmPerPixel, r + 2), el.height - r - 2);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), bx, by);
    ctx.restore();
  });
}

watch(rectifiedPreview, () => {
  ghostOutlines.clear();
  clearClicks();
  void nextTick(draw);
});
// Tools can change from Layout mode (removal, re-trace) while this canvas
// stays mounted; redraw so the ghost overlays track the store.
watch(tools, () => draw(), { deep: true });
onMounted(() => void nextTick(draw));

function clearClicks(): void {
  retraceToolId.value = null;
  justSavedNumber.value = null;
  points.value = [];
  strokes.value = [];
  brushMode.value = 'off';
  activeStroke = null;
  cursorPx.value = null;
  outline.value = null;
  iouScore.value = null;
  decodeMs.value = null;
  maskPreview = null;
  errorMessage.value = null;
  draw();
}

async function runSegment(): Promise<void> {
  segmenting.value = true;
  errorMessage.value = null;
  try {
    const result = await segmentAt(
      JSON.parse(JSON.stringify(points.value)) as SamPoint[],
      JSON.parse(JSON.stringify(strokes.value)) as BrushStroke[],
    );
    if (!result.ok) {
      errorMessage.value = result.error;
      outline.value = null;
      maskPreview = null;
    } else {
      outline.value = result.outline;
      iouScore.value = result.iouScore;
      decodeMs.value = result.decodeMs;
      maskPreview = result.maskPreview;
    }
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Segmenting the tool failed.';
  } finally {
    segmenting.value = false;
    draw();
  }
}

/** Converts a pointer event to canvas pixels, or null when the canvas is gone. */
function toCanvasPixel(event: MouseEvent): { x: number; y: number } | null {
  const el = canvas.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * el.width,
    y: ((event.clientY - rect.top) / rect.height) * el.height,
  };
}

function onClick(event: MouseEvent, exclude: boolean): void {
  if (brushMode.value !== 'off') return;
  if (segmenting.value || !embedReady.value) return;
  const pt = toCanvasPixel(event);
  if (pt === null) return;
  justSavedNumber.value = null;
  const label: 0 | 1 = exclude || event.shiftKey ? 0 : 1;
  points.value = [...points.value, { x: pt.x, y: pt.y, label }];
  void runSegment();
}

// Undo and clear re-run the SAM decode with the updated strokes, the same cost
// as adding or removing a click.
function undoStroke(): void {
  if (strokes.value.length === 0 || segmenting.value) return;
  strokes.value = strokes.value.slice(0, -1);
  void runSegment();
}

function clearStrokes(): void {
  if (strokes.value.length === 0 || segmenting.value) return;
  strokes.value = [];
  void runSegment();
}

function onPointerDown(event: PointerEvent): void {
  if (brushMode.value === 'off') return;
  if (segmenting.value || !embedReady.value) return;
  const pt = toCanvasPixel(event);
  if (pt === null) return;
  const el = canvas.value;
  if (el) el.setPointerCapture(event.pointerId);
  justSavedNumber.value = null;
  activeStroke = { mode: brushMode.value, radiusMm: brushSizeMm.value, points: [pt] };
  cursorPx.value = pt;
  draw();
}

function onPointerMove(event: PointerEvent): void {
  if (brushMode.value === 'off') return;
  const pt = toCanvasPixel(event);
  if (pt === null) return;
  cursorPx.value = pt;
  if (activeStroke !== null) {
    activeStroke.points.push(pt);
  }
  draw();
}

/** Commits the active stroke and re-segments; a single-vertex stroke is a dot. */
function commitStroke(event: PointerEvent): void {
  if (activeStroke === null) return;
  const el = canvas.value;
  if (el) {
    try {
      el.releasePointerCapture(event.pointerId);
    } catch {
      // No capture to release (the pointer left before capture); nothing to do.
    }
  }
  strokes.value = [
    ...strokes.value,
    JSON.parse(JSON.stringify(activeStroke)) as BrushStroke,
  ];
  activeStroke = null;
  void runSegment();
}

function onPointerUp(event: PointerEvent): void {
  if (brushMode.value === 'off') return;
  commitStroke(event);
}

function onPointerLeave(event: PointerEvent): void {
  cursorPx.value = null;
  if (activeStroke !== null) {
    commitStroke(event);
  } else {
    draw();
  }
}

/** CSS cursor class: the ring cursor replaces the pointer in paint modes. */
const canvasCursorClass = computed(() =>
  brushMode.value === 'off' ? 'cursor-crosshair' : 'cursor-none',
);

/** The 1-based number of the tool the canvas is currently tracing. */
const activeToolNumber = computed(() => {
  if (retraceToolId.value !== null) {
    const index = tools.value.findIndex((t) => t.id === retraceToolId.value);
    if (index >= 0) return index + 1;
  }
  return tools.value.length + 1;
});

/** The state-dependent instruction line above the canvas. */
const helperText = computed(() => {
  if (outline.value !== null) {
    return retraceToolId.value !== null
      ? 'Add more clicks to refine the outline, or replace the saved outline for this tool.'
      : 'Add more clicks to refine the outline, or accept it to save this tool.';
  }
  if (justSavedNumber.value !== null) {
    return (
      `Tool ${justSavedNumber.value} was saved. ` +
      `Click the next tool in the photo to start Tool ${justSavedNumber.value + 1}.`
    );
  }
  if (tools.value.length === 0) return 'Click a tool in the photo to start tracing it.';
  return `Click the next tool in the photo to start Tool ${tools.value.length + 1}.`;
});

/** The label of the finish button, which accepts only when an outline is pending. */
const finishLabel = computed(() => {
  if (outline.value === null) return 'Finish';
  return retraceToolId.value !== null ? 'Replace and finish' : 'Accept and finish';
});

/**
 * Accepts the pending outline and returns to Layout mode; with no pending
 * outline it just leaves, discarding any pending re-trace selection.
 */
function finishTracing(): void {
  if (outline.value !== null) {
    acceptTool(true);
    return;
  }
  clearClicks();
  emit('accepted');
}

/**
 * Saves the traced outline as a tool (or replaces the re-traced tool's
 * outline). With finish the workspace returns to Layout mode; without it the
 * canvas clears for tracing the next tool.
 */
function acceptTool(finish: boolean): void {
  if (outline.value === null) return;
  const clicks = JSON.parse(JSON.stringify(points.value)) as SamPoint[];
  const brushStrokes = JSON.parse(JSON.stringify(strokes.value)) as BrushStroke[];
  const sheetOutline = JSON.parse(JSON.stringify(outline.value)) as TracedOutline;
  let savedNumber: number;
  if (retraceToolId.value !== null) {
    const toolId = retraceToolId.value;
    store.replaceToolOutline(toolId, outline.value, clicks, brushStrokes);
    ghostOutlines.set(toolId, sheetOutline);
    const index = tools.value.findIndex((t) => t.id === toolId);
    savedNumber = index >= 0 ? index + 1 : tools.value.length;
  } else {
    const tool = store.addTool(outline.value, undefined, clicks, true, brushStrokes);
    ghostOutlines.set(tool.id, sheetOutline);
    savedNumber = tools.value.length;
  }
  clearClicks();
  if (finish) {
    emit('accepted');
  } else {
    justSavedNumber.value = savedNumber;
    draw();
  }
}
</script>

<template>
  <div>
    <div class="d-flex align-center flex-wrap ga-1 mb-2">
      <template v-for="(tool, i) in tools" :key="tool.id">
        <v-chip
          v-if="tool.id !== retraceToolId"
          size="small"
          label
          variant="tonal"
          prepend-icon="mdi-check"
          class="text-medium-emphasis"
        >
          Tool {{ i + 1 }}
        </v-chip>
      </template>
      <v-chip size="small" label variant="flat" color="primary">
        Tool {{ activeToolNumber }}
      </v-chip>
    </div>
    <p class="text-body-2 mb-1">{{ helperText }}</p>
    <p class="text-caption text-medium-emphasis mb-2">
      Shift-click or right-click a point to exclude it from the outline.
    </p>
    <canvas
      ref="canvas"
      class="trace-canvas"
      :class="canvasCursorClass"
      @click="onClick($event, false)"
      @contextmenu.prevent="onClick($event, true)"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave"
    />
    <div class="action-island">
      <div class="d-flex align-center flex-wrap ga-2">
        <v-btn
          color="primary"
          variant="flat"
          :disabled="outline === null || segmenting"
          @click="acceptTool(false)"
        >
          {{ retraceToolId !== null ? 'Replace and continue' : 'Accept and trace next' }}
        </v-btn>
        <v-btn variant="outlined" :disabled="segmenting" @click="finishTracing">
          {{ finishLabel }}
        </v-btn>
        <v-btn variant="outlined" :disabled="points.length === 0" @click="clearClicks">
          Clear clicks
        </v-btn>
        <v-progress-circular v-if="segmenting" indeterminate size="20" width="2" />
      </div>
      <div class="d-flex align-center flex-wrap ga-2 mt-2">
        <v-btn-toggle v-model="brushMode" mandatory density="compact" variant="outlined">
          <v-btn value="off" size="small">Off</v-btn>
          <v-btn value="add" size="small">Paint add</v-btn>
          <v-btn value="erase" size="small">Paint erase</v-btn>
        </v-btn-toggle>
        <v-slider
          v-model="brushSizeMm"
          :min="1"
          :max="20"
          :step="1"
          hide-details
          density="compact"
          class="brush-slider"
          :label="`Brush ${brushSizeMm} mm`"
        />
        <v-btn
          variant="outlined"
          size="small"
          :disabled="strokes.length === 0 || segmenting"
          @click="undoStroke"
        >
          Undo stroke
        </v-btn>
        <v-btn
          variant="outlined"
          size="small"
          :disabled="strokes.length === 0 || segmenting"
          @click="clearStrokes"
        >
          Clear strokes
        </v-btn>
      </div>
      <p class="text-caption text-medium-emphasis mt-1 mb-0">
        Paint on the mask to add or erase; each stroke can be undone.
      </p>
      <div v-if="iouScore !== null" class="text-caption text-medium-emphasis mt-2 readout">
        <div><span>Mask quality estimate</span><span>{{ iouScore!.toFixed(3) }}</span></div>
        <div><span>Decode time</span><span>{{ decodeMs!.toFixed(0) }} ms</span></div>
      </div>
      <v-alert v-if="errorMessage" type="error" density="compact" class="mt-2">
        {{ errorMessage }}
      </v-alert>
    </div>
  </div>
</template>

<style scoped>
.trace-canvas {
  max-width: 100%;
  border-radius: 8px;
  display: block;
}

.cursor-crosshair {
  cursor: crosshair;
}

/* The ring drawn on the canvas replaces the pointer while a paint mode is on. */
.cursor-none {
  cursor: none;
}

.brush-slider {
  min-width: 150px;
  max-width: 220px;
}

/*
 * The action buttons and readouts float in an island pinned to the bottom of
 * the visible viewport while the trace area is scrolled, so the primary
 * action stays reachable on photos taller than the screen. It stays inside
 * the card because sticky positioning is bounded by the component's box.
 */
.action-island {
  position: sticky;
  bottom: 12px;
  z-index: 2;
  width: fit-content;
  max-width: calc(100% - 16px);
  margin: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

.readout > div {
  display: flex;
  gap: 12px;
}

.readout span:first-child {
  min-width: 160px;
}
</style>
