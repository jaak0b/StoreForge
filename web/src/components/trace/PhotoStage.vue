<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { detectPaper, embedImage, loadPhoto, rectifyPaper } from '../../visionClient';
import type { PaperCorners, PixelPoint } from '../../engine/trace/types';

/**
 * The Photo stage of the Tool trace tab. Before a photo is loaded it shows
 * only a large upload dropzone; once one loads, a docked toolbar strip
 * (paper size, re-detect, new photo, confirm) sits above the full-width
 * photo with the draggable sheet-corner overlay. While a corner is dragged
 * a magnifier loupe shows a zoomed crop of the full-resolution photo around
 * the corner. Confirming rectifies the sheet and prepares it for
 * click-to-segment.
 */

const store = useToolTrace();
const { photoUrl, photoSize, corners, paperKind, encodeMs } = storeToRefs(store);

const emit = defineEmits<{ confirmed: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const busyText = ref('');
const errorMessage = ref<string | null>(null);
const detectionNote = ref<string | null>(null);
const dragOver = ref(false);

/** Visual handle radius in CSS pixels. */
const HANDLE_RADIUS = 9;
/** Grab radius in CSS pixels around a handle: larger on touch. */
const GRAB_RADIUS_TOUCH = 22;
const GRAB_RADIUS_POINTER = 14;
/** Loupe diameter in CSS pixels and its zoom over the source photo. */
const LOUPE_SIZE = 140;
const LOUPE_ZOOM = 4;

/** On phones and tablets the file picker offers the camera directly. */
const coarsePointer =
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

let image: HTMLImageElement | null = null;
/** Canvas backing pixels per photo pixel; set by draw(). */
let scale = 1;
/** Canvas backing pixels per CSS pixel; set by draw(). */
let dpr = 1;

function cornerList(c: PaperCorners): Array<keyof PaperCorners> {
  void c;
  return ['tl', 'tr', 'br', 'bl'];
}

function draw(): void {
  const el = canvas.value;
  if (!el || !image || photoSize.value === null) return;
  const cssWidth = el.clientWidth;
  if (cssWidth === 0) return;
  dpr = window.devicePixelRatio || 1;
  el.width = Math.round(cssWidth * dpr);
  scale = el.width / photoSize.value.width;
  el.height = Math.round(photoSize.value.height * scale);
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(image, 0, 0, el.width, el.height);
  const c = corners.value;
  if (c === null) return;
  ctx.strokeStyle = '#42a5f5';
  ctx.lineWidth = 2 * dpr;
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
    ctx.arc(p.x * scale, p.y * scale, HANDLE_RADIUS * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(66, 165, 245, 0.35)';
    ctx.fill();
    ctx.strokeStyle = '#42a5f5';
    ctx.stroke();
  }
}

watch([corners, photoUrl], () => void nextTick(draw), { deep: true });

// The canvas fills the tab width, so it redraws whenever that width changes.
let resizeObserver: ResizeObserver | null = null;
watch(
  canvas,
  (el, previous) => {
    if (resizeObserver === null && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => draw());
    }
    if (previous && resizeObserver) resizeObserver.unobserve(previous);
    if (el && resizeObserver) resizeObserver.observe(el);
  },
  { immediate: true, flush: 'post' },
);
function onWindowResize(): void {
  draw();
}
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', onWindowResize);
});

onMounted(() => {
  window.addEventListener('resize', onWindowResize);
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

const loupeCanvas = ref<HTMLCanvasElement | null>(null);
const loupeVisible = ref(false);
const loupeStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' });

function canvasPoint(event: PointerEvent): PixelPoint {
  const el = canvas.value!;
  const rect = el.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * el.width / scale,
    y: ((event.clientY - rect.top) / rect.height) * el.height / scale,
  };
}

/**
 * Renders the loupe: a zoomed crop of the full-resolution photo centred on
 * the dragged corner, with the quad edges and a crosshair, and positions it
 * near the pointer while keeping it inside the canvas.
 */
function updateLoupe(event: PointerEvent): void {
  const el = canvas.value;
  const lc = loupeCanvas.value;
  if (!el || !lc || !image || draggingCorner === null || corners.value === null) return;
  const corner = corners.value[draggingCorner];
  const rect = el.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const margin = 20;
  // Above and to the right of the pointer; flip when that leaves the canvas
  // so the loupe never sits under the finger or off screen.
  let left = px + margin;
  let top = py - LOUPE_SIZE - margin;
  if (left + LOUPE_SIZE > rect.width) left = px - LOUPE_SIZE - margin;
  if (top < 0) top = py + margin;
  left = Math.min(Math.max(0, left), Math.max(0, rect.width - LOUPE_SIZE));
  top = Math.min(Math.max(0, top), Math.max(0, rect.height - LOUPE_SIZE));
  loupeStyle.value = { left: `${left}px`, top: `${top}px` };

  const backing = Math.round(LOUPE_SIZE * (window.devicePixelRatio || 1));
  lc.width = backing;
  lc.height = backing;
  const ctx = lc.getContext('2d');
  if (!ctx) return;
  const s = backing / LOUPE_SIZE;
  const half = backing / 2;
  // Photo pixels shown across the loupe, at LOUPE_ZOOM over the source.
  const srcSize = LOUPE_SIZE / LOUPE_ZOOM;
  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half, 0, 2 * Math.PI);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, backing, backing);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    image,
    corner.x - srcSize / 2,
    corner.y - srcSize / 2,
    srcSize,
    srcSize,
    0,
    0,
    backing,
    backing,
  );
  // The current quad edges through the crop, photo pixels to loupe pixels.
  const zoom = backing / srcSize;
  ctx.strokeStyle = '#42a5f5';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  cornerList(corners.value).forEach((key, i) => {
    const p = corners.value![key];
    const lx = (p.x - corner.x) * zoom + half;
    const ly = (p.y - corner.y) * zoom + half;
    if (i === 0) ctx.moveTo(lx, ly);
    else ctx.lineTo(lx, ly);
  });
  ctx.closePath();
  ctx.stroke();
  // Crosshair marking the exact corner point at the centre.
  const arm = 14 * s;
  const gap = 4 * s;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(half - arm, half);
  ctx.lineTo(half - gap, half);
  ctx.moveTo(half + gap, half);
  ctx.lineTo(half + arm, half);
  ctx.moveTo(half, half - arm);
  ctx.lineTo(half, half - gap);
  ctx.moveTo(half, half + gap);
  ctx.lineTo(half, half + arm);
  ctx.stroke();
  ctx.restore();
}

function onPointerDown(event: PointerEvent): void {
  const c = corners.value;
  if (c === null) return;
  const el = canvas.value;
  if (el === null) return;
  const p = canvasPoint(event);
  const rect = el.getBoundingClientRect();
  // CSS pixels per photo pixel on screen, from the same mapping canvasPoint uses.
  const cssPerPhoto = (rect.width / el.width) * scale;
  const grabCss =
    event.pointerType === 'touch' ? GRAB_RADIUS_TOUCH : GRAB_RADIUS_POINTER;
  const grabRadius = grabCss / cssPerPhoto;
  for (const key of cornerList(c)) {
    const corner = c[key];
    if (Math.hypot(corner.x - p.x, corner.y - p.y) <= grabRadius) {
      draggingCorner = key;
      loupeVisible.value = true;
      void nextTick(() => updateLoupe(event));
      try {
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // Without pointer capture the drag still works while the pointer
        // stays over the canvas; losing capture only ends the drag earlier.
      }
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
  updateLoupe(event);
}

function onPointerUp(): void {
  draggingCorner = null;
  loupeVisible.value = false;
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
  <div class="d-flex flex-column ga-3">
    <div
      v-if="photoUrl === null"
      class="drop-zone d-flex flex-column align-center justify-center text-center pa-8"
      :class="{ over: dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <v-icon icon="mdi-camera-outline" size="56" class="mb-3 text-medium-emphasis" />
      <p class="text-body-2 text-medium-emphasis guidance">
        Photograph the tools from directly above, laid out on one Letter or A4
        sheet. Shoot from a distance and zoom in; that reduces perspective
        error at the sheet edges.
      </p>
      <v-btn
        color="primary"
        variant="flat"
        prepend-icon="mdi-image-plus"
        class="mt-4"
        :loading="busy"
        @click="fileInput?.click()"
      >
        Choose a photo
      </v-btn>
      <div class="text-caption text-medium-emphasis mt-2">
        You can also drop an image file here.
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        :capture="coarsePointer ? 'environment' : undefined"
        class="d-none"
        @change="onFileInput"
      />
    </div>

    <template v-else>
      <div class="toolbar-host">
        <div class="photo-toolbar">
          <v-btn-toggle
            v-model="paperKind"
            mandatory
            density="comfortable"
            variant="outlined"
            class="paper-toggle"
          >
            <v-btn value="a4">A4</v-btn>
            <v-btn value="letter">Letter</v-btn>
          </v-btn-toggle>
          <v-btn variant="text" :disabled="busy" @click="redetect">
            <v-icon icon="mdi-scan-helper" size="20" :start="true" />
            <span class="btn-label">Re-detect</span>
            <v-tooltip activator="parent" location="bottom">
              Re-run corner detection on the loaded photo, discarding any manual drags.
            </v-tooltip>
          </v-btn>
          <v-btn variant="text" :disabled="busy" @click="fileInput?.click()">
            <v-icon icon="mdi-image-refresh-outline" size="20" :start="true" />
            <span class="btn-label">New photo</span>
            <v-tooltip activator="parent" location="bottom">
              Choose a different photo.
            </v-tooltip>
          </v-btn>
          <div class="flex-spacer" />
          <v-btn
            color="primary"
            variant="flat"
            :loading="busy"
            @click="confirm"
          >
            Confirm sheet
          </v-btn>
        </div>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        :capture="coarsePointer ? 'environment' : undefined"
        class="d-none"
        @change="onFileInput"
      />

      <p v-if="busyText !== ''" class="text-body-2 text-medium-emphasis mb-0">
        {{ busyText }}
      </p>
      <v-progress-linear v-if="busy" indeterminate />
      <v-alert
        v-if="detectionNote !== null"
        type="info"
        variant="tonal"
        density="compact"
      >
        {{ detectionNote }}
      </v-alert>
      <v-alert v-if="errorMessage" type="error" density="compact">
        {{ errorMessage }}
      </v-alert>

      <div class="photo-canvas-wrap">
        <canvas
          ref="canvas"
          class="photo-canvas"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <canvas
          v-show="loupeVisible"
          ref="loupeCanvas"
          class="loupe"
          :style="loupeStyle"
        />
      </div>

      <p class="text-caption text-medium-emphasis mb-0">
        Drag the corners onto the sheet edges.
      </p>

      <v-expansion-panels v-if="encodeMs !== null" class="details-panels">
        <v-expansion-panel elevation="0">
          <v-expansion-panel-title class="text-caption details-title">
            Details
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="readout-row text-caption">
              <span class="text-medium-emphasis">Sheet encoding time</span>
              <span class="readout-value">
                {{ encodeMs === 0 ? 'reused cached embedding' : `${encodeMs.toFixed(0)} ms` }}
              </span>
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </template>
  </div>
</template>

<style scoped>
.drop-zone {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 8px;
  min-height: 320px;
}

.drop-zone.over {
  border-color: rgb(var(--v-theme-primary));
}

.guidance {
  max-width: 480px;
}

.toolbar-host {
  container-type: inline-size;
}

.photo-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-on-surface), 0.16);
}

.flex-spacer {
  flex: 1 1 auto;
}

/* Narrow bar: the text buttons drop to icons and everything centers. */
@container (max-width: 480px) {
  .btn-label {
    display: none;
  }

  .photo-toolbar {
    justify-content: center;
  }

  .flex-spacer {
    display: none;
  }
}

.photo-canvas-wrap {
  position: relative;
  width: 100%;
}

.photo-canvas {
  width: 100%;
  border-radius: 8px;
  touch-action: none;
  cursor: crosshair;
  display: block;
}

.loupe {
  position: absolute;
  width: 140px;
  height: 140px;
  border-radius: 50%;
  border: 2px solid #42a5f5;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.details-panels {
  max-width: 480px;
}

.details-panels .v-expansion-panel {
  background: transparent;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.16);
  border-radius: 8px;
}

.details-title {
  min-height: 36px;
}

.readout-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.readout-value {
  font-family: monospace;
}
</style>
