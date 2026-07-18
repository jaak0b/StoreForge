<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { segmentAt } from '../../visionClient';
import type { SamPoint, TracedOutline } from '../../engine/trace/types';

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
    let minX = Infinity;
    let minY = Infinity;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#c97a2e';
    ctx.fillStyle = '#c97a2e';
    ctx.lineWidth = 2;
    for (const loop of [ghost.outer, ...ghost.holes]) {
      ctx.beginPath();
      loop.forEach((p, i) => {
        const x = p.x / mmPerPixel;
        const y = p.y / mmPerPixel;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 0.1;
    ctx.beginPath();
    ghost.outer.forEach((p, i) => {
      const x = p.x / mmPerPixel;
      const y = p.y / mmPerPixel;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    // Numbered badge at the outline's bounding-box top-left corner, clamped
    // so it stays inside the canvas.
    const r = 11;
    const bx = Math.min(Math.max(minX, r + 2), el.width - r - 2);
    const by = Math.min(Math.max(minY, r + 2), el.height - r - 2);
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
    const result = await segmentAt(JSON.parse(JSON.stringify(points.value)) as SamPoint[]);
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

function onClick(event: MouseEvent, exclude: boolean): void {
  const el = canvas.value;
  if (!el || segmenting.value || !embedReady.value) return;
  const rect = el.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * el.width;
  const y = ((event.clientY - rect.top) / rect.height) * el.height;
  justSavedNumber.value = null;
  const label: 0 | 1 = exclude || event.shiftKey ? 0 : 1;
  points.value = [...points.value, { x, y, label }];
  void runSegment();
}

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

/**
 * Saves the traced outline as a tool (or replaces the re-traced tool's
 * outline). With finish the workspace returns to Layout mode; without it the
 * canvas clears for tracing the next tool.
 */
function acceptTool(finish: boolean): void {
  if (outline.value === null) return;
  const clicks = JSON.parse(JSON.stringify(points.value)) as SamPoint[];
  const sheetOutline = JSON.parse(JSON.stringify(outline.value)) as TracedOutline;
  let savedNumber: number;
  if (retraceToolId.value !== null) {
    const toolId = retraceToolId.value;
    store.replaceToolOutline(toolId, outline.value, clicks);
    ghostOutlines.set(toolId, sheetOutline);
    const index = tools.value.findIndex((t) => t.id === toolId);
    savedNumber = index >= 0 ? index + 1 : tools.value.length;
  } else {
    const tool = store.addTool(outline.value, undefined, clicks);
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
      @click="onClick($event, false)"
      @contextmenu.prevent="onClick($event, true)"
    />
    <div class="d-flex align-center flex-wrap ga-2 mt-2">
      <v-btn
        color="primary"
        variant="flat"
        :disabled="outline === null || segmenting"
        @click="acceptTool(false)"
      >
        {{ retraceToolId !== null ? 'Replace and continue' : 'Accept and trace next' }}
      </v-btn>
      <v-btn
        variant="outlined"
        :disabled="outline === null || segmenting"
        @click="acceptTool(true)"
      >
        {{ retraceToolId !== null ? 'Replace and finish' : 'Accept and finish' }}
      </v-btn>
      <v-btn variant="outlined" :disabled="points.length === 0" @click="clearClicks">
        Clear clicks
      </v-btn>
      <v-progress-circular v-if="segmenting" indeterminate size="20" width="2" />
    </div>
    <div v-if="iouScore !== null" class="text-caption text-medium-emphasis mt-2 readout">
      <div><span>Mask quality estimate</span><span>{{ iouScore!.toFixed(3) }}</span></div>
      <div><span>Decode time</span><span>{{ decodeMs!.toFixed(0) }} ms</span></div>
    </div>
    <v-alert v-if="errorMessage" type="error" density="compact" class="mt-2">
      {{ errorMessage }}
    </v-alert>
  </div>
</template>

<style scoped>
.trace-canvas {
  max-width: 100%;
  border-radius: 8px;
  cursor: crosshair;
}

.readout > div {
  display: flex;
  gap: 12px;
}

.readout span:first-child {
  min-width: 160px;
}
</style>
