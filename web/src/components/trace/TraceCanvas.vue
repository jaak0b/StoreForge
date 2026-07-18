<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { segmentAt } from '../../visionClient';
import type { SamPoint, TracedOutline } from '../../engine/trace/types';

/**
 * The Trace mode of the trace-and-layout workspace: click a tool on the
 * rectified sheet to segment it, refine with include and exclude clicks,
 * then accept the traced outlines as tools. When the mask covers several
 * distinct shapes, accepting adds each one as its own tool. A re-trace
 * request from the tool rail preloads an existing tool's stored clicks;
 * accepting then replaces that tool's outline with the shape at the first
 * include click and adds any further shapes as new tools.
 */

const store = useToolTrace();
const { rectifiedPreview, calibration, embedReady } = storeToRefs(store);

const emit = defineEmits<{
  /** Fired after accept with the number of tools added and replaced. */
  accepted: [counts: { added: number; replaced: number }];
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const points = ref<SamPoint[]>([]);
const outlines = ref<TracedOutline[]>([]);
const iouScore = ref<number | null>(null);
const decodeMs = ref<number | null>(null);
const segmenting = ref(false);
const errorMessage = ref<string | null>(null);

let maskPreview: ImageData | null = null;

// Id of the existing tool being re-traced from its stored clicks.
const retraceToolId = ref<string | null>(null);

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
  if (outlines.value.length > 0 && cal !== null) {
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = 2;
    for (const loop of outlines.value.flatMap((o) => [o.outer, ...o.holes])) {
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

watch(rectifiedPreview, () => {
  clearClicks();
  void nextTick(draw);
});
onMounted(() => void nextTick(draw));

function clearClicks(): void {
  retraceToolId.value = null;
  points.value = [];
  outlines.value = [];
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
      outlines.value = [];
      maskPreview = null;
    } else {
      outlines.value = result.outlines;
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
  const label: 0 | 1 = exclude || event.shiftKey ? 0 : 1;
  points.value = [...points.value, { x, y, label }];
  void runSegment();
}

function acceptTool(): void {
  const traced = outlines.value;
  if (traced.length === 0) return;
  const clicks = JSON.parse(JSON.stringify(points.value)) as SamPoint[];
  let added = 0;
  let replaced = 0;
  let rest = traced;
  if (retraceToolId.value !== null) {
    // The first outline is the shape at the first include click; it replaces
    // the re-traced tool, and any further shapes become new tools.
    store.replaceToolOutline(retraceToolId.value, traced[0], clicks);
    replaced = 1;
    rest = traced.slice(1);
  }
  for (const outline of rest) {
    store.addTool(outline, undefined, clicks);
    added += 1;
  }
  clearClicks();
  emit('accepted', { added, replaced });
}
</script>

<template>
  <div>
    <p class="text-body-2 mb-2">
      <b>Click on a tool to trace it.</b> Shift-click or right-click marks a
      spot to exclude when the selection grabs too much.
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
        :disabled="outlines.length === 0 || segmenting"
        @click="acceptTool"
      >
        {{
          retraceToolId !== null
            ? 'Replace tool outline'
            : outlines.length > 1
              ? `Accept ${outlines.length} tools`
              : 'Accept tool'
        }}
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
