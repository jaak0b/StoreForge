<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { detectPaper, embedImage, loadPhoto, rectifyPaper } from '../../visionClient';
import type { PaperCorners, PixelPoint } from '../../engine/trace/types';

/**
 * The Photo stage of the Tool trace tab: load a photo into the left canvas
 * pane, correct the detected sheet corners by dragging the four handles, and
 * confirm in the right rail to rectify the sheet and prepare it for
 * click-to-segment.
 */

const store = useToolTrace();
const { photoUrl, photoSize, corners, paperKind, encodeMs } = storeToRefs(store);

const emit = defineEmits<{ confirmed: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const busy = ref(false);
const busyText = ref('');
const errorMessage = ref<string | null>(null);
const detectionNote = ref<string | null>(null);
const dragOver = ref(false);

// Drawn canvas width in CSS pixels; photo pixels scale down to this.
const CANVAS_WIDTH = 640;
const HANDLE_RADIUS = 9;

let image: HTMLImageElement | null = null;
let scale = 1;

function cornerList(c: PaperCorners): Array<keyof PaperCorners> {
  void c;
  return ['tl', 'tr', 'br', 'bl'];
}

function draw(): void {
  const el = canvas.value;
  if (!el || !image || photoSize.value === null) return;
  scale = CANVAS_WIDTH / photoSize.value.width;
  el.width = CANVAS_WIDTH;
  el.height = Math.round(photoSize.value.height * scale);
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(image, 0, 0, el.width, el.height);
  const c = corners.value;
  if (c === null) return;
  ctx.strokeStyle = '#42a5f5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const order = cornerList(c);
  order.forEach((key, i) => {
    const p = c[key];
    if (i === 0) ctx.moveTo(p.x * scale, p.y * scale);
    else ctx.lineTo(p.x * scale, p.y * scale);
  });
  ctx.closePath();
  ctx.stroke();
  for (const key of order) {
    const p = c[key];
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, HANDLE_RADIUS, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(66, 165, 245, 0.35)';
    ctx.fill();
    ctx.strokeStyle = '#42a5f5';
    ctx.stroke();
  }
}

watch([corners, photoUrl], () => void nextTick(draw), { deep: true });
onMounted(() => {
  if (photoUrl.value !== null) {
    image = new Image();
    image.onload = draw;
    image.src = photoUrl.value;
  }
});

async function handleFile(file: File): Promise<void> {
  busy.value = true;
  busyText.value = 'Reading the photo.';
  errorMessage.value = null;
  detectionNote.value = null;
  try {
    const buffer = await file.arrayBuffer();
    const info = await loadPhoto(buffer);
    if (photoUrl.value !== null) URL.revokeObjectURL(photoUrl.value);
    photoUrl.value = URL.createObjectURL(file);
    // A freshly uploaded photo replaces any stored one on save, so it gets a
    // new photo-store id then; keep the bytes for that save.
    store.photoBlob = file;
    store.sourceId = null;
    photoSize.value = info;
    store.rectifiedPreview = null;
    store.embedReady = false;
    image = new Image();
    image.onload = draw;
    image.src = photoUrl.value;
    busyText.value = 'Looking for the sheet.';
    await runDetection();
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Loading the photo failed.';
  } finally {
    busy.value = false;
    busyText.value = '';
  }
}

/** Runs sheet detection; on failure falls back to a draggable inset quad. */
async function runDetection(): Promise<void> {
  const info = photoSize.value;
  if (info === null) return;
  const detection = await detectPaper();
  if (detection.ok) {
    corners.value = detection.corners;
    detectionNote.value = null;
  } else {
    const inset = 0.15;
    const w = info.width;
    const h = info.height;
    corners.value = {
      tl: { x: w * inset, y: h * inset },
      tr: { x: w * (1 - inset), y: h * inset },
      br: { x: w * (1 - inset), y: h * (1 - inset) },
      bl: { x: w * inset, y: h * (1 - inset) },
    };
    detectionNote.value = detection.error;
  }
}

/** Re-runs corner detection on the loaded photo, discarding manual drags. */
async function redetect(): Promise<void> {
  busy.value = true;
  busyText.value = 'Looking for the sheet.';
  errorMessage.value = null;
  try {
    await runDetection();
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Detecting the sheet failed.';
  } finally {
    busy.value = false;
    busyText.value = '';
  }
}

function onFileInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file !== undefined) void handleFile(file);
  input.value = '';
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file !== undefined) void handleFile(file);
}

// Corner dragging on the canvas.
let draggingCorner: keyof PaperCorners | null = null;

function canvasPoint(event: PointerEvent): PixelPoint {
  const el = canvas.value!;
  const rect = el.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * el.width / scale,
    y: ((event.clientY - rect.top) / rect.height) * el.height / scale,
  };
}

function onPointerDown(event: PointerEvent): void {
  const c = corners.value;
  if (c === null) return;
  const p = canvasPoint(event);
  const grabRadius = (HANDLE_RADIUS * 2) / scale;
  for (const key of cornerList(c)) {
    const corner = c[key];
    if (Math.hypot(corner.x - p.x, corner.y - p.y) <= grabRadius) {
      draggingCorner = key;
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      return;
    }
  }
}

function onPointerMove(event: PointerEvent): void {
  if (draggingCorner === null || corners.value === null || photoSize.value === null) return;
  const p = canvasPoint(event);
  corners.value = {
    ...corners.value,
    [draggingCorner]: {
      x: Math.min(Math.max(0, p.x), photoSize.value.width),
      y: Math.min(Math.max(0, p.y), photoSize.value.height),
    },
  };
}

function onPointerUp(): void {
  draggingCorner = null;
}

async function confirm(): Promise<void> {
  if (corners.value === null) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    busyText.value = 'Rectifying the sheet.';
    const result = await rectifyPaper(
      JSON.parse(JSON.stringify(corners.value)) as PaperCorners,
      paperKind.value,
    );
    store.calibration = result.calibration;
    store.rectifiedPreview = result.preview;
    store.embedReady = false;
    busyText.value =
      'Preparing the sheet for tracing. The first run downloads about 45 MB of segmentation model data.';
    const embed = await embedImage();
    store.encodeMs = embed.encodeMs;
    store.embedReady = true;
    emit('confirmed');
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Preparing the sheet failed.';
  } finally {
    busy.value = false;
    busyText.value = '';
  }
}
</script>

<template>
  <div class="stage-panes">
    <div class="canvas-pane">
      <template v-if="photoUrl !== null">
        <p class="text-body-2 mb-2">
          <b>Drag the four handles onto the sheet corners.</b> The trace scale
          comes from these corners.
        </p>
        <canvas
          ref="canvas"
          class="photo-canvas"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
      </template>
      <div
        v-else
        class="canvas-placeholder d-flex flex-column align-center justify-center text-center pa-8"
      >
        <v-icon icon="mdi-camera-outline" size="56" class="mb-3 text-medium-emphasis" />
        <p class="text-body-2 text-medium-emphasis">
          The photo appears here once it is loaded.
        </p>
      </div>
    </div>

    <div class="rail">
      <p class="text-body-2 text-medium-emphasis">
        Photograph the tools from directly above, laid out on one Letter or A4
        sheet. Shoot from a distance and zoom in; that reduces perspective
        error at the sheet edges.
      </p>
      <div
        class="drop-zone pa-3"
        :class="{ over: dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="onDrop"
      >
        <input type="file" accept="image/*" @change="onFileInput" />
        <div class="text-caption text-medium-emphasis mt-1">
          You can also drop an image file here.
        </div>
      </div>
      <v-alert
        v-if="detectionNote !== null"
        type="info"
        variant="tonal"
        density="compact"
      >
        {{ detectionNote }}
      </v-alert>
      <template v-if="photoUrl !== null">
        <div class="text-caption text-medium-emphasis">Sheet size</div>
        <v-btn-toggle v-model="paperKind" mandatory density="comfortable" variant="outlined">
          <v-btn value="a4">A4</v-btn>
          <v-btn value="letter">Letter</v-btn>
        </v-btn-toggle>
        <v-btn
          variant="outlined"
          :disabled="busy"
          prepend-icon="mdi-crop-free"
          @click="redetect"
        >
          Detect corners again
        </v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" @click="confirm">
          Confirm sheet
        </v-btn>
      </template>
      <p v-if="busyText !== ''" class="text-body-2 text-medium-emphasis mb-0">
        {{ busyText }}
      </p>
      <v-progress-linear v-if="busy" indeterminate />
      <v-alert v-if="errorMessage" type="error" density="compact">
        {{ errorMessage }}
      </v-alert>
      <div v-if="encodeMs !== null" class="text-caption text-medium-emphasis readout">
        <div><span>Sheet encoding time</span><span>{{ encodeMs === 0 ? 'reused cached embedding' : `${encodeMs.toFixed(0)} ms` }}</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stage-panes {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.canvas-pane {
  flex: 1 1 auto;
  min-width: 0;
}

.rail {
  flex: 0 0 360px;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

@media (max-width: 959px) {
  .stage-panes {
    flex-direction: column;
  }

  .rail {
    flex: 1 1 auto;
    max-width: none;
    width: 100%;
  }
}

.canvas-placeholder {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 8px;
  min-height: 260px;
}

.drop-zone {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 8px;
}

.drop-zone.over {
  border-color: rgb(var(--v-theme-primary));
}

.photo-canvas {
  max-width: 100%;
  border-radius: 8px;
  touch-action: none;
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
