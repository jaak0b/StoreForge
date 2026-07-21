<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useToolTrace } from '../../stores/toolTrace';
import { segmentAt } from '../../visionClient';
import type { BrushStroke, MmPoint, SamPoint, TracedOutline } from '../../engine/trace/types';
import { centroidOf, pointInPolygon } from '../../engine/trace/edit';
import {
  MIN_ZOOM,
  clampPan,
  screenToImage,
  zoomToCursor,
  type ViewTransform,
} from './viewTransform';

/**
 * The Trace mode of the trace-and-layout workspace: click a tool on the
 * rectified sheet to segment it, refine with include and exclude clicks,
 * then accept the traced outline as a tool. A re-trace request from the tool
 * rail preloads an existing tool's stored clicks; accepting then replaces
 * that tool's outline instead of adding a duplicate.
 */

const store = useToolTrace();
const { rectifiedPreview, calibration, embedReady, tools, removeShadows } = storeToRefs(store);

const emit = defineEmits<{ accepted: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const points = ref<SamPoint[]>([]);
const outline = ref<TracedOutline | null>(null);
const iouScore = ref<number | null>(null);
const decodeMs = ref<number | null>(null);
const segmenting = ref(false);
const errorMessage = ref<string | null>(null);
// True when the worker reports that an add-brush stroke painted area that falls
// outside the traced region, so accepting would silently lose that paint. The
// accept and replace actions are blocked while this holds.
const paintedAreaDropped = ref(false);

// Brush strokes painted onto the mask (rectified-image pixels), the painting
// mode, and the brush radius in mm. brushSizeMm ranges 1..20.
const strokes = ref<BrushStroke[]>([]);
const brushMode = ref<'off' | 'add' | 'erase' | 'smooth'>('off');
const brushSizeMm = ref(4);
// The stroke being painted between pointer down and up; null when not painting.
let activeStroke: BrushStroke | null = null;
// The pointer position in canvas pixels while a paint mode is on, for the ring
// cursor; null when the pointer is off the canvas.
const cursorPx = ref<{ x: number; y: number } | null>(null);

let maskPreview: ImageData | null = null;

// View transform: zoom in [1, 8] and a pan offset in canvas pixels, applied to
// every drawn layer so the whole view scales together. At zoom 1 the pan is
// pinned to (0, 0) and the view matches the untransformed canvas.
const zoom = ref(MIN_ZOOM);
const panX = ref(0);
const panY = ref(0);

// True while the space bar is held; it turns a left-drag into a pan, taking
// priority over the paint modes.
const spaceHeld = ref(false);
// True while Tab is held, and the eye button's own toggle; either one hides the
// mask-derived layers so the raw rectified photo shows through. Click points and
// brush aiming stay visible.
const tabHeld = ref(false);
const maskHiddenButton = ref(false);
const maskHidden = computed(() => tabHeld.value || maskHiddenButton.value);
// Whether the canvas shortcut help popover is open.
const shortcutHelpOpen = ref(false);
// The in-progress pan drag: the canvas-pixel pointer position and the pan
// offset captured when the drag began; null when not panning.
let panDrag: { startX: number; startY: number; panX: number; panY: number } | null = null;
// Set true when a left-button pan drag ends so the click event it produces is
// swallowed instead of segmenting.
let panConsumedClick = false;

// Cached offscreen canvases so the base photo and the mask overlay draw through
// the view transform without rebuilding their ImageData every frame. The base
// is rebuilt when a new rectified photo arrives; the mask when a new preview
// arrives (tracked by reference identity).
let baseCanvas: OffscreenCanvas | null = null;
let cachedBasePreview: ImageData | null = null;
let maskCanvas: OffscreenCanvas | null = null;
let cachedMaskPreview: ImageData | null = null;

function currentTransform(): ViewTransform {
  return { zoom: zoom.value, panX: panX.value, panY: panY.value };
}

/**
 * Returns the cached base-photo offscreen canvas, rebuilding it only when a new
 * rectified preview arrives so drawImage can render it through the transform.
 */
function ensureBaseCanvas(preview: ImageData): OffscreenCanvas {
  if (baseCanvas === null || cachedBasePreview !== preview) {
    baseCanvas = new OffscreenCanvas(preview.width, preview.height);
    const bctx = baseCanvas.getContext('2d');
    if (bctx) bctx.putImageData(preview, 0, 0);
    cachedBasePreview = preview;
  }
  return baseCanvas;
}

/**
 * Returns the cached mask-overlay offscreen canvas, rebuilding it only when a
 * new mask preview arrives so drawImage renders it through the transform.
 */
function ensureMaskCanvas(mask: ImageData): OffscreenCanvas {
  if (maskCanvas === null || cachedMaskPreview !== mask) {
    maskCanvas = new OffscreenCanvas(mask.width, mask.height);
    const mctx = maskCanvas.getContext('2d');
    if (mctx) mctx.putImageData(mask, 0, 0);
    cachedMaskPreview = mask;
  }
  return maskCanvas;
}

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
  // Clear in identity space, then apply the view transform so every layer
  // below (photo, mask, ghosts, outline, points, brush ring) scales together.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.width, el.height);
  ctx.setTransform(zoom.value, 0, 0, zoom.value, panX.value, panY.value);
  ctx.drawImage(ensureBaseCanvas(preview), 0, 0);
  const hideMask = maskHidden.value;
  if (maskPreview !== null && !hideMask) {
    // The mask overlay carries alpha, so it composites over the sheet.
    ctx.drawImage(ensureMaskCanvas(maskPreview), 0, 0);
  }
  const cal = calibration.value;
  if (cal !== null && !hideMask) drawGhosts(ctx, el, cal.mmPerPixel);
  if (outline.value !== null && cal !== null && !hideMask) {
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
  if (!hideMask) {
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
      ctx.strokeStyle = BRUSH_RING_COLORS[brushMode.value];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

/**
 * Paint colour per brush mode, one entry for the translucent provisional stroke
 * and one for the opaque ring cursor: blue for add, red for erase, neutral grey
 * for smooth (which neither adds nor removes area, so it takes neither the add
 * nor the erase colour and stays clear of the orange outline and ghosts).
 */
const BRUSH_STROKE_COLORS: Record<BrushStroke['mode'], string> = {
  add: 'rgba(66, 133, 244, 0.5)',
  erase: 'rgba(244, 67, 54, 0.5)',
  smooth: 'rgba(224, 224, 224, 0.5)',
};
const BRUSH_RING_COLORS: Record<BrushStroke['mode'] | 'off', string> = {
  off: '#4285f4',
  add: '#4285f4',
  erase: '#f44336',
  smooth: '#e0e0e0',
};

/**
 * Draws a provisional brush stroke on the 2D context as filled vertex discs and
 * thick connecting segments, matching the swept-disc region the mask rasterizer
 * will union, subtract or median-filter.
 */
function drawProvisionalStroke(
  ctx: CanvasRenderingContext2D,
  stroke: BrushStroke,
  radiusPx: number,
): void {
  ctx.save();
  const color = BRUSH_STROKE_COLORS[stroke.mode];
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
  zoom.value = MIN_ZOOM;
  panX.value = 0;
  panY.value = 0;
  clearClicks();
  void nextTick(draw);
});
// Tools can change from Layout mode (removal, re-trace) while this canvas
// stays mounted; redraw so the ghost overlays track the store.
watch(tools, () => draw(), { deep: true });
// Hiding or showing the mask layers redraws the canvas.
watch(maskHidden, () => draw());

/** True when focus sits in a field where the shortcut keys are ordinary input. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Brush shortcuts, active only while the trace stage is mounted: B, E and S
 * pick the paint modes, V and Escape turn painting off, the bracket keys step the
 * brush size, and Ctrl+Z (or Cmd+Z) undoes the last stroke. The shortcuts do
 * nothing until a mask exists, and never fire while focus is in a field.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (isEditableTarget(event.target)) return;
  // Tab held hides the mask-derived layers so the raw photo shows through;
  // preventDefault stops focus from traversing away. Auto-repeat is ignored.
  if (event.key === 'Tab') {
    if (!event.repeat) tabHeld.value = true;
    event.preventDefault();
    return;
  }
  // Shift+/ ("?") toggles the shortcut help popover.
  if (event.key === '?') {
    shortcutHelpOpen.value = !shortcutHelpOpen.value;
    event.preventDefault();
    return;
  }
  // Zoom and pan work whether or not an outline is pending.
  if (event.key === '0' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    resetZoom();
    event.preventDefault();
    return;
  }
  if (event.key === ' ' || event.code === 'Space') {
    if (!spaceHeld.value) spaceHeld.value = true;
    // Stop the page from scrolling while space is used for panning.
    event.preventDefault();
    return;
  }
  if (outline.value === null) return;
  const key = event.key;
  if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'Z')) {
    // Only claim the undo shortcut when there is a stroke to undo in a paint
    // mode; otherwise let the browser's own undo run.
    if (brushMode.value !== 'off' && strokes.value.length > 0 && !segmenting.value) {
      event.preventDefault();
      undoStroke();
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  switch (key) {
    case 'b':
    case 'B':
      brushMode.value = 'add';
      break;
    case 'e':
    case 'E':
      brushMode.value = 'erase';
      break;
    case 's':
    case 'S':
      brushMode.value = 'smooth';
      break;
    case 'v':
    case 'V':
    case 'Escape':
      brushMode.value = 'off';
      break;
    case '[':
      brushSizeMm.value = Math.max(1, brushSizeMm.value - 1);
      break;
    case ']':
      brushSizeMm.value = Math.min(20, brushSizeMm.value + 1);
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === ' ' || event.code === 'Space') spaceHeld.value = false;
  if (event.key === 'Tab') {
    tabHeld.value = false;
    if (!isEditableTarget(event.target)) event.preventDefault();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  void nextTick(draw);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
});

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
  paintedAreaDropped.value = false;
  draw();
}

async function runSegment(): Promise<void> {
  segmenting.value = true;
  errorMessage.value = null;
  try {
    const result = await segmentAt(points.value, strokes.value, {
      removeShadows: removeShadows.value,
    });
    if (!result.ok) {
      errorMessage.value = result.error;
      outline.value = null;
      maskPreview = null;
      paintedAreaDropped.value = false;
    } else {
      outline.value = result.outline;
      iouScore.value = result.iouScore;
      decodeMs.value = result.decodeMs;
      maskPreview = result.maskPreview;
      paintedAreaDropped.value = result.paintedAreaDropped;
    }
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Segmenting the tool failed.';
  } finally {
    segmenting.value = false;
    draw();
  }
}

/**
 * Re-runs the segmentation after the shadow option changed, so the outline on
 * screen always matches the current setting. With no clicks yet there is
 * nothing to segment and the new setting simply applies to the next click.
 */
function onRemoveShadowsChanged(): void {
  if (points.value.length === 0) return;
  void runSegment();
}

/**
 * Converts a pointer event to canvas backing-store pixels (before the view
 * transform), accounting for the canvas being displayed at a CSS size that may
 * differ from its pixel resolution. Null when the canvas is gone.
 */
function eventToCanvasPx(event: MouseEvent): { x: number; y: number } | null {
  const el = canvas.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * el.width,
    y: ((event.clientY - rect.top) / rect.height) * el.height,
  };
}

/**
 * Converts a pointer event to rectified-image pixels, inverting the view
 * transform so clicks and brush strokes land at the correct image coordinate at
 * any zoom. Null when the canvas is gone.
 */
function toCanvasPixel(event: MouseEvent): { x: number; y: number } | null {
  const canvasPx = eventToCanvasPx(event);
  if (canvasPx === null) return null;
  return screenToImage(canvasPx, currentTransform());
}

/** Applies a pan offset clamped so the image stays within the viewport. */
function setPan(nextPanX: number, nextPanY: number): void {
  const el = canvas.value;
  if (!el) return;
  const clamped = clampPan(
    { zoom: zoom.value, panX: nextPanX, panY: nextPanY },
    el.width,
    el.height,
  );
  panX.value = clamped.panX;
  panY.value = clamped.panY;
}

/** Resets the view to fit (zoom 1, centred). Bound to the toolbar and key 0. */
function resetZoom(): void {
  zoom.value = MIN_ZOOM;
  panX.value = 0;
  panY.value = 0;
  draw();
}

/** Wheel zoom centred on the pointer, clamped to [1, 8]; never scrolls the page. */
function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const el = canvas.value;
  if (!el || rectifiedPreview.value === null) return;
  const anchor = eventToCanvasPx(event);
  if (anchor === null) return;
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  const next = zoomToCursor(
    currentTransform(),
    zoom.value * factor,
    anchor,
    el.width,
    el.height,
  );
  zoom.value = next.zoom;
  panX.value = next.panX;
  panY.value = next.panY;
  draw();
}

/**
 * Begins a pan drag on middle-mouse-down, or on left-down while space is held.
 * Returns true when the event started a pan so the caller skips paint or click
 * handling.
 */
function maybeStartPan(event: PointerEvent): boolean {
  const isMiddle = event.button === 1;
  const isSpaceLeft = event.button === 0 && spaceHeld.value;
  if (zoom.value <= MIN_ZOOM || (!isMiddle && !isSpaceLeft)) return false;
  const canvasPx = eventToCanvasPx(event);
  if (canvasPx === null) return false;
  const el = canvas.value;
  if (el) el.setPointerCapture(event.pointerId);
  panDrag = { startX: canvasPx.x, startY: canvasPx.y, panX: panX.value, panY: panY.value };
  event.preventDefault();
  return true;
}

function onClick(event: MouseEvent, exclude: boolean): void {
  if (panConsumedClick) {
    // Swallow the click synthesized by the end of a space-pan drag.
    panConsumedClick = false;
    return;
  }
  if (spaceHeld.value) return;
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
  if (maybeStartPan(event)) return;
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
  if (panDrag !== null) {
    const canvasPx = eventToCanvasPx(event);
    if (canvasPx === null) return;
    setPan(
      panDrag.panX + (canvasPx.x - panDrag.startX),
      panDrag.panY + (canvasPx.y - panDrag.startY),
    );
    draw();
    return;
  }
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

/** Ends a pan drag, releasing capture; returns true when a pan was active. */
function endPan(event: PointerEvent): boolean {
  if (panDrag === null) return false;
  panDrag = null;
  // A left-button pan (space held) is followed by a click event; swallow it.
  if (event.button === 0) panConsumedClick = true;
  const el = canvas.value;
  if (el) {
    try {
      el.releasePointerCapture(event.pointerId);
    } catch {
      // No capture to release; nothing to do.
    }
  }
  return true;
}

function onPointerUp(event: PointerEvent): void {
  if (endPan(event)) return;
  if (brushMode.value === 'off') return;
  commitStroke(event);
}

function onPointerLeave(event: PointerEvent): void {
  cursorPx.value = null;
  if (endPan(event)) return;
  if (activeStroke !== null) {
    commitStroke(event);
  } else {
    draw();
  }
}

/**
 * CSS cursor class: the grab cursor while space-panning takes priority, then
 * the ring cursor replaces the pointer in paint modes.
 */
const canvasCursorClass = computed(() => {
  if (spaceHeld.value) return 'cursor-grab';
  return brushMode.value === 'off' ? 'cursor-crosshair' : 'cursor-none';
});

/** The zoom factor formatted for the readout, one decimal (e.g. "2.5x"). */
const zoomLabel = computed(() => `${zoom.value.toFixed(1)}x`);

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

/** The canvas shortcuts listed in the help popover, in one place so future
 * shortcuts extend the array rather than the template. */
const shortcutRows: { action: string; keys: string }[] = [
  { action: 'Add include point', keys: 'Click' },
  { action: 'Add exclude point', keys: 'Shift click or right click' },
  { action: 'Paint add', keys: 'B' },
  { action: 'Paint erase', keys: 'E' },
  { action: 'Smooth edge', keys: 'S' },
  { action: 'Pointer mode', keys: 'V or Escape' },
  { action: 'Brush size', keys: '[ and ]' },
  { action: 'Undo stroke', keys: 'Ctrl+Z' },
  { action: 'Zoom', keys: 'Mouse wheel' },
  { action: 'Pan', keys: 'Space drag or middle drag' },
  { action: 'Reset zoom', keys: '0' },
  { action: 'Hide mask and points', keys: 'Hold Tab or eye button' },
];

/** Tooltip shown on the blocked accept and replace actions. */
const paintDroppedMessage =
  'Part of your painted area is not connected to the traced shape and would be lost. Erase the stray paint or connect it to the tool with a brush stroke.';

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
      @wheel.prevent="onWheel"
    />
    <div class="action-island">
      <div class="d-flex align-center flex-wrap ga-2">
        <v-tooltip location="top" :disabled="!paintedAreaDropped" :text="paintDroppedMessage">
          <template #activator="{ props }">
            <span v-bind="props">
              <v-btn
                color="primary"
                variant="flat"
                :disabled="outline === null || segmenting || paintedAreaDropped"
                @click="acceptTool(false)"
              >
                {{ retraceToolId !== null ? 'Replace and continue' : 'Accept and trace next' }}
              </v-btn>
            </span>
          </template>
        </v-tooltip>
        <v-tooltip
          location="top"
          :disabled="!(paintedAreaDropped && outline !== null)"
          :text="paintDroppedMessage"
        >
          <template #activator="{ props }">
            <span v-bind="props">
              <v-btn
                variant="outlined"
                :disabled="segmenting || (paintedAreaDropped && outline !== null)"
                @click="finishTracing"
              >
                {{ finishLabel }}
              </v-btn>
            </span>
          </template>
        </v-tooltip>
        <v-btn variant="outlined" :disabled="points.length === 0" @click="clearClicks">
          Clear clicks
        </v-btn>
        <v-progress-circular v-if="segmenting" indeterminate size="20" width="2" />
        <div v-if="zoom > 1" class="d-flex align-center ga-1 ml-auto">
          <span class="text-caption text-medium-emphasis zoom-readout">{{ zoomLabel }}</span>
          <v-btn icon size="small" variant="text" @click="resetZoom">
            <v-icon icon="mdi-fit-to-screen" size="20" />
            <v-tooltip activator="parent" location="bottom">Reset zoom (0)</v-tooltip>
          </v-btn>
        </div>
        <div class="d-flex align-center ga-1" :class="{ 'ml-auto': zoom <= 1 }">
          <v-btn
            icon
            size="small"
            variant="text"
            :color="maskHidden ? 'primary' : undefined"
            @click="maskHiddenButton = !maskHiddenButton"
          >
            <v-icon :icon="maskHidden ? 'mdi-eye-off' : 'mdi-eye'" size="20" />
            <v-tooltip activator="parent" location="bottom">Hide mask and points (hold Tab)</v-tooltip>
          </v-btn>
          <v-menu v-model="shortcutHelpOpen" location="top end" :close-on-content-click="false">
            <template #activator="{ props }">
              <v-btn icon size="small" variant="text" v-bind="props">
                <v-icon icon="mdi-help-circle-outline" size="20" />
                <v-tooltip activator="parent" location="bottom">Canvas shortcuts</v-tooltip>
              </v-btn>
            </template>
            <v-card min-width="280" class="pa-2">
              <div
                v-for="row in shortcutRows"
                :key="row.action"
                class="d-flex align-center justify-space-between ga-4 px-2 py-1 shortcut-row"
              >
                <span class="text-body-2">{{ row.action }}</span>
                <span class="text-caption text-medium-emphasis">{{ row.keys }}</span>
              </div>
            </v-card>
          </v-menu>
        </div>
      </div>
      <div v-if="outline !== null" class="d-flex align-center flex-wrap ga-2 mt-2">
        <v-btn-toggle v-model="brushMode" mandatory density="compact" variant="text">
          <v-btn value="off" icon size="small" :color="brushMode === 'off' ? 'primary' : undefined">
            <v-icon icon="mdi-cursor-default-click" size="20" />
            <v-tooltip activator="parent" location="bottom">Click to segment</v-tooltip>
          </v-btn>
          <v-btn value="add" icon size="small" :color="brushMode === 'add' ? 'info' : undefined">
            <v-icon icon="mdi-brush" size="20" />
            <v-tooltip activator="parent" location="bottom">Paint add (B)</v-tooltip>
          </v-btn>
          <v-btn value="erase" icon size="small" :color="brushMode === 'erase' ? 'error' : undefined">
            <v-icon icon="mdi-eraser" size="20" />
            <v-tooltip activator="parent" location="bottom">Paint erase (E)</v-tooltip>
          </v-btn>
          <v-btn
            value="smooth"
            icon
            size="small"
            :color="brushMode === 'smooth' ? 'secondary' : undefined"
          >
            <v-icon icon="mdi-blur" size="20" />
            <v-tooltip activator="parent" location="bottom">Smooth edge (S)</v-tooltip>
          </v-btn>
        </v-btn-toggle>
        <div class="brush-size d-flex align-center ga-2">
          <v-slider
            v-model="brushSizeMm"
            :min="1"
            :max="20"
            :step="1"
            hide-details
            density="compact"
            class="brush-slider"
          />
          <span class="text-caption text-medium-emphasis brush-readout">{{ brushSizeMm }} mm</span>
          <v-tooltip activator="parent" location="bottom">Brush size ([ and ] to change)</v-tooltip>
        </div>
        <v-btn
          icon
          size="small"
          variant="text"
          :disabled="strokes.length === 0 || segmenting"
          @click="undoStroke"
        >
          <v-icon icon="mdi-undo" size="20" />
          <v-tooltip activator="parent" location="bottom">Undo stroke (Ctrl+Z)</v-tooltip>
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          :disabled="strokes.length === 0 || segmenting"
          @click="clearStrokes"
        >
          <v-icon icon="mdi-delete-sweep" size="20" />
          <v-tooltip activator="parent" location="bottom">Clear strokes</v-tooltip>
        </v-btn>
      </div>
      <v-checkbox
        v-model="removeShadows"
        label="Photo has strong shadows around the tools"
        density="compact"
        hide-details
        :disabled="segmenting"
        class="shadow-option"
        @update:model-value="onRemoveShadowsChanged"
      />
      <p class="text-caption text-medium-emphasis shadow-option-hint">
        Removes grey shadow edges that would otherwise be traced as part of a tool. Leave this
        off if any tool is bare metal or chrome.
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

/* Space is held to pan; show the grab cursor over the canvas. */
.cursor-grab {
  cursor: grab;
}

.zoom-readout {
  min-width: 34px;
  text-align: right;
  white-space: nowrap;
}

.brush-slider {
  min-width: 120px;
  max-width: 180px;
}

.brush-readout {
  min-width: 42px;
  white-space: nowrap;
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

/* The mask option sits with the brush controls, tightened so the island stays compact. */
.shadow-option {
  margin-top: 4px;
}

.shadow-option-hint {
  margin-left: 40px;
}

.readout > div {
  display: flex;
  gap: 12px;
}

.readout span:first-child {
  min-width: 160px;
}
</style>
