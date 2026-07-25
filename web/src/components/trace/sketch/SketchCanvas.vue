<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor } from '../../../stores/sketchEditor';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampPan,
  imageToScreen,
  zoomToCursor,
  type Vec2,
  type ViewTransform,
  type ZoomRange,
} from '../viewTransform';
import { assertNever } from '../../../engine/plan/types';
import type { MmPoint } from '../../../engine/trace/types';
import type { SketchEntity } from '../../../engine/sketch/model';
import {
  arcFromThreePoints,
  arcTangentToPoint,
  tangentDirectionAtPoint,
} from '../../../engine/sketch/model';
import { constraintGlyphs } from '../../../engine/sketch/constraintGlyphs';
import { inferHVConstraint } from '../../../engine/sketch/autoInfer';
import { formatMm, formatDegrees } from '../../../engine/sketch/measure';

const emit = defineEmits<{
  /** A canvas click in mm, for the active drawing tool. altKey is the Alt
   * modifier at click time, which suppresses auto H/V inference. */
  (e: 'canvasClick', at: MmPoint, hitPointId: string | null, altKey: boolean): void;
  /** A drag of an existing point to a new mm position (driven point). */
  (e: 'pointDrag', pointId: string, at: MmPoint): void;
  (e: 'pointDragEnd'): void;
  /** A dragged point released within snap range of another point; the
   * workspace merges them with a coincident constraint. */
  (e: 'pointDragMerge', draggedPointId: string, targetPointId: string): void;
  /** A click on a dimension label, for click-to-edit. */
  (e: 'dimensionClick', constraintId: string, at: MmPoint): void;
  (e: 'entityClick', entityId: string): void;
  /** A click on a constraint glyph, for the constraint selection. */
  (e: 'constraintClick', constraintId: string): void;
}>();

const editor = useSketchEditor();
const {
  sketch,
  solveState,
  selectedIds,
  selectedConstraintId,
  glyphsVisible,
  underlayUrl,
  underlayOpacityPct,
  underlayMmPerPixel,
  activeTool,
  chainTailId,
  chainTailSegmentId,
  regionFaces,
  selectedRegionId,
  cursorMm,
  hoveredConstraintId,
  hoveredEntityIds,
  pendingClicks,
} = storeToRefs(editor);

/** Region the pointer currently hovers, for the raised-opacity hover cue;
 * display state only, never selection. */
const hoveredRegionId = ref<string | null>(null);

/** One face's outer boundary plus holes as a single SVG path, evenodd fill
 * so the holes cut out of the outer fill. */
function loopToPathD(loop: MmPoint[]): string {
  if (loop.length === 0) return '';
  return `M ${loop[0].x} ${loop[0].y} ${loop
    .slice(1)
    .map((p) => `L ${p.x} ${p.y}`)
    .join(' ')} Z`;
}

const regionPaths = computed(() =>
  regionFaces.value.map((face) => ({
    id: face.id,
    d: [loopToPathD(face.outer), ...face.holes.map(loopToPathD)].join(' '),
  })),
);

/** Region shading: light CAD blue, hover raises opacity, selected reads
 * distinct and slightly stronger (spec's "UI" section). */
function regionFill(regionId: string): string {
  return regionId === selectedRegionId.value ? '#1565c0' : '#1e88e5';
}
function regionOpacity(regionId: string): number {
  if (regionId === selectedRegionId.value) return 0.35;
  if (regionId === hoveredRegionId.value) return 0.22;
  return 0.12;
}

const svgEl = ref<SVGSVGElement | null>(null);
/** Pan/zoom over a fixed 200 mm design window; same math as the trace canvas. */
const WINDOW_MM = 200;
const view = ref<ViewTransform>({ zoom: 1, panX: 0, panY: 0 });
/**
 * The sketch canvas is an unbounded design space (unlike the photo trace
 * canvas, which is bounded to the photo's pixels), so it keeps the same
 * zoom-in cap as the trace canvas but allows zooming out much further: at
 * least 10x the trace canvas's [1, 8] range. clampZoom/zoomToCursor accept
 * this range instead of duplicating the clamp math locally (convention 10).
 */
const SKETCH_ZOOM_RANGE: ZoomRange = { min: MIN_ZOOM / 10, max: MAX_ZOOM };

const viewBox = computed(() => {
  const size = WINDOW_MM / view.value.zoom;
  const minX = -view.value.panX / view.value.zoom - size / 4;
  const minY = -view.value.panY / view.value.zoom - size / 4;
  return `${minX} ${minY} ${size} ${size}`;
});

/** Grid lines every 10 mm across the visible window. */
const gridLines = computed(() => {
  const size = WINDOW_MM / view.value.zoom;
  const minX = -view.value.panX / view.value.zoom - size / 4;
  const minY = -view.value.panY / view.value.zoom - size / 4;
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const start = (v: number) => Math.floor(v / 10) * 10;
  for (let x = start(minX); x <= minX + size; x += 10) {
    lines.push({ x1: x, y1: minY, x2: x, y2: minY + size });
  }
  for (let y = start(minY); y <= minY + size; y += 10) {
    lines.push({ x1: minX, y1: y, x2: minX + size, y2: y });
  }
  return lines;
});

function clientToMm(event: PointerEvent | WheelEvent): MmPoint {
  const svg = svgEl.value!;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const mm = point.matrixTransform(svg.getScreenCTM()!.inverse());
  return { x: mm.x, y: mm.y };
}

/**
 * Millimeters per screen pixel from the SVG's current screen transform, so a
 * screen-pixel pick radius (point dragging, point snapping) tracks the
 * current zoom instead of a value fitted to one zoom level.
 */
function mmPerScreenPixel(): number {
  const svg = svgEl.value;
  const ctm = svg?.getScreenCTM() ?? null;
  if (ctm === null || ctm.a === 0) return 1 / view.value.zoom;
  return 1 / ctm.a;
}

/** The snap pick radius in mm: 8 screen pixels converted at the current zoom. */
const SNAP_RADIUS_PX = 8;
function snapRadiusMm(): number {
  return mmPerScreenPixel() * SNAP_RADIUS_PX;
}

/** True when the pointerdown/click target is a rendered entity or point,
 * as opposed to empty canvas background (grid, underlay, or the SVG itself). */
function isEntityTarget(target: EventTarget | null): boolean {
  return (
    target instanceof SVGPathElement ||
    target instanceof SVGCircleElement ||
    target instanceof SVGTextElement
  );
}

/**
 * Converts a pointer/wheel event's client position to the "screen" pixel
 * space zoomToCursor and clampPan operate in: a virtual WINDOW_MM square,
 * pan/zoom-invariant by construction since it is the inverse of the same
 * view.value transform the viewBox is built from (imageToScreen and
 * screenToImage, via clientToMm, are exact inverses of each other).
 */
function eventToVirtualPx(event: PointerEvent | WheelEvent): Vec2 {
  return imageToScreen(clientToMm(event), view.value);
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
  const anchor = eventToVirtualPx(event);
  view.value = zoomToCursor(view.value, view.value.zoom * factor, anchor, WINDOW_MM, WINDOW_MM, SKETCH_ZOOM_RANGE);
}

/** Applies a pan offset clamped so the design window stays reachable. */
function setPan(nextPanX: number, nextPanY: number): void {
  const clamped = clampPan({ zoom: view.value.zoom, panX: nextPanX, panY: nextPanY }, WINDOW_MM, WINDOW_MM);
  view.value = { zoom: view.value.zoom, panX: clamped.panX, panY: clamped.panY };
}

/** True while the space bar is held; turns a left-drag into a pan, matching
 * TraceCanvas's convention (grab/grabbing cursor, click swallowed on release). */
const spaceHeld = ref(false);
/** The in-progress pan drag: the virtual-px pointer position and the pan
 * offset captured when the drag began; null when not panning. */
let panDrag: { startX: number; startY: number; panX: number; panY: number } | null = null;
/** Reactive flag mirroring the panDrag closure variable, for the cursor class. */
const panDragActive = ref(false);

/**
 * Begins a pan drag on middle-mouse-down, or on left-down while space is
 * held. Returns true when the event started a pan so the caller skips
 * selection, dragging or tool-click handling entirely (this canvas places
 * points and selects directly from pointerdown rather than a separate click
 * event, so gating here is the mirror of TraceCanvas's panConsumedClick
 * guard: the pan swallows the gesture before any placement logic runs).
 */
function maybeStartPan(event: PointerEvent): boolean {
  const isMiddle = event.button === 1;
  const isSpaceLeft = event.button === 0 && spaceHeld.value;
  if (!isMiddle && !isSpaceLeft) return false;
  const vpx = eventToVirtualPx(event);
  svgEl.value?.setPointerCapture(event.pointerId);
  panDrag = { startX: vpx.x, startY: vpx.y, panX: view.value.panX, panY: view.value.panY };
  panDragActive.value = true;
  event.preventDefault();
  return true;
}

/** Ends a pan drag, releasing capture; returns true when a pan was active. */
function endPan(event: PointerEvent): boolean {
  if (panDrag === null) return false;
  panDrag = null;
  panDragActive.value = false;
  try {
    svgEl.value?.releasePointerCapture(event.pointerId);
  } catch {
    // No capture to release; nothing to do.
  }
  return true;
}

/** True when focus sits in a field where Space is ordinary input. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}
function onSpaceKeyDown(event: KeyboardEvent): void {
  if (event.key !== ' ' && event.code !== 'Space') return;
  if (isEditableTarget(event.target)) return;
  if (!spaceHeld.value) spaceHeld.value = true;
  event.preventDefault();
}
function onSpaceKeyUp(event: KeyboardEvent): void {
  if (event.key === ' ' || event.code === 'Space') spaceHeld.value = false;
}
onMounted(() => {
  window.addEventListener('keydown', onSpaceKeyDown);
  window.addEventListener('keyup', onSpaceKeyUp);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onSpaceKeyDown);
  window.removeEventListener('keyup', onSpaceKeyUp);
});

/** CSS cursor: grab while space-panning, grabbing mid-pan, else the default. */
const canvasCursorClass = computed(() => {
  if (panDragActive.value) return 'cursor-grabbing';
  return spaceHeld.value ? 'cursor-grab' : '';
});

/** Sketch entity/underlay bounds in mm, or null when the sketch is empty. */
function sketchBoundsMm(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.value.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points.value) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const underlayImage = svgEl.value?.querySelector('image') ?? null;
  if (underlayImage !== null && underlayMmPerPixel.value !== null) {
    try {
      const bbox = (underlayImage as SVGImageElement).getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        const scale = underlayMmPerPixel.value;
        minX = Math.min(minX, bbox.x * scale);
        minY = Math.min(minY, bbox.y * scale);
        maxX = Math.max(maxX, (bbox.x + bbox.width) * scale);
        maxY = Math.max(maxY, (bbox.y + bbox.height) * scale);
      }
    } catch {
      // The underlay image has not finished loading; frame the sketch alone.
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Frames the sketch (and the visible underlay, when present) in view with a
 * margin, using the same viewBox convention the rest of this component relies on:
 * center = -panX/zoom + size/4, so panX = WINDOW_MM/4 - zoom*centerX.
 */
const FIT_MARGIN_MM = 10;
function fitToView(): void {
  const bounds = sketchBoundsMm();
  if (bounds === null) return;
  const width = bounds.maxX - bounds.minX + FIT_MARGIN_MM * 2;
  const height = bounds.maxY - bounds.minY + FIT_MARGIN_MM * 2;
  const span = Math.max(width, height, 1e-6);
  const zoom = Math.min(Math.max(WINDOW_MM / span, SKETCH_ZOOM_RANGE.min), SKETCH_ZOOM_RANGE.max);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  view.value = {
    zoom,
    panX: WINDOW_MM / 4 - zoom * centerX,
    panY: WINDOW_MM / 4 - zoom * centerY,
  };
}
/** Whether the Fit button is usable: there must be something to frame. */
const canFit = computed(() => points.value.length > 0);

defineExpose({ fitToView, canFit });

const points = computed(() =>
  sketch.value.entities.filter((e): e is Extract<SketchEntity, { kind: 'point' }> => e.kind === 'point'),
);
const pointById = computed(() => new Map(points.value.map((p) => [p.id, p])));

/** SVG path data of every non-point entity, keyed by entity id. */
const entityPaths = computed(() =>
  sketch.value.entities
    .filter((e) => e.kind !== 'point')
    .map((entity) => {
      switch (entity.kind) {
        case 'line': {
          const a = pointById.value.get(entity.p1Id)!;
          const b = pointById.value.get(entity.p2Id)!;
          return { entity, d: `M ${a.x} ${a.y} L ${b.x} ${b.y}` };
        }
        case 'arc': {
          const c = pointById.value.get(entity.centerId)!;
          const s = pointById.value.get(entity.startId)!;
          const e2 = pointById.value.get(entity.endId)!;
          const r = Math.hypot(s.x - c.x, s.y - c.y);
          const a0 = Math.atan2(s.y - c.y, s.x - c.x);
          let a1 = Math.atan2(e2.y - c.y, e2.x - c.x);
          if (a1 <= a0) a1 += 2 * Math.PI;
          const largeArc = a1 - a0 > Math.PI ? 1 : 0;
          return { entity, d: `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e2.x} ${e2.y}` };
        }
        case 'circle': {
          const c = pointById.value.get(entity.centerId)!;
          return {
            entity,
            d:
              `M ${c.x + entity.radiusMm} ${c.y} ` +
              `A ${entity.radiusMm} ${entity.radiusMm} 0 1 1 ${c.x - entity.radiusMm} ${c.y} ` +
              `A ${entity.radiusMm} ${entity.radiusMm} 0 1 1 ${c.x + entity.radiusMm} ${c.y}`,
          };
        }
        default:
          return assertNever(entity);
      }
    }),
);

/**
 * Stroke color by solver state: fully constrained geometry green, movable
 * (under-constrained) geometry blue, conflicting sketches red. The solver
 * reports dof for the whole sketch, so the color applies sketch-wide.
 */
function strokeOf(entity: SketchEntity): string {
  if (selectedIds.value.includes(entity.id) || hoveredEntityIds.value.includes(entity.id)) {
    return '#ff9800';
  }
  if (entity.kind !== 'point' && entity.construction) return '#9e9e9e';
  const state = solveState.value;
  if (state.status === 'conflicting' || state.status === 'failed') return '#e53935';
  if (state.status === 'solved' && state.dof === 0) return '#2e7d32';
  return '#1e88e5';
}

const draggingPointId = ref<string | null>(null);
/** While dragging a point, another existing point within snap range of the
 * cursor, or null; drives the drop-to-merge snap ring and the merge on
 * release. Never the dragged point itself. */
const dragSnapTargetId = ref<string | null>(null);

/** A pointerdown landed on a point with the select tool, but movement has not
 * yet exceeded the click/drag threshold; holds the point id and the down
 * screen position until either the threshold is crossed (drag starts) or
 * pointerup arrives first (a click, emitted as entityClick). */
const pendingPointId = ref<string | null>(null);
const pendingDownScreen = ref<{ x: number; y: number } | null>(null);

/** Screen-pixel movement beyond which a pointerdown-on-point becomes a drag
 * instead of a click, converted to mm at the current zoom. */
const DRAG_THRESHOLD_PX = 4;
function dragThresholdMm(): number {
  return mmPerScreenPixel() * DRAG_THRESHOLD_PX;
}

function onPointerDown(event: PointerEvent): void {
  if (maybeStartPan(event)) return;
  const at = clientToMm(event);
  const hit = hitPoint(at);
  if (editor.activeTool === 'select' && hit !== null) {
    pendingPointId.value = hit;
    pendingDownScreen.value = { x: event.clientX, y: event.clientY };
    dragSnapTargetId.value = null;
    // Capture on the SVG root, not event.target: the point's rendered circle
    // (r = 0.9 mm) is visually smaller than the generous 8-screen-pixel pick
    // radius hitPoint() uses, so a pointerdown within the pick radius but off
    // the circle's painted pixels lands on a sibling element (an entity's
    // invisible hit-path, or the background). Capturing on that element still
    // works for a point drag that stays over the canvas, but ties correctness
    // to which element happened to be under the cursor; capturing on the
    // stable svg root removes that dependency entirely.
    svgEl.value!.setPointerCapture(event.pointerId);
    return;
  }
  if (editor.activeTool === 'select' && hit === null && !isEntityTarget(event.target)) {
    selectedIds.value = [];
    selectedConstraintId.value = null;
  }
  emit('canvasClick', at, hit, event.altKey);
}

function onPointerMove(event: PointerEvent): void {
  if (panDrag !== null) {
    const vpx = eventToVirtualPx(event);
    setPan(panDrag.panX + (vpx.x - panDrag.startX), panDrag.panY + (vpx.y - panDrag.startY));
    return;
  }
  cursorMm.value = clientToMm(event);
  altHeld.value = event.altKey;
  if (pendingPointId.value !== null && pendingDownScreen.value !== null) {
    const dx = event.clientX - pendingDownScreen.value.x;
    const dy = event.clientY - pendingDownScreen.value.y;
    const movedScreenPx = Math.hypot(dx, dy);
    if (movedScreenPx * mmPerScreenPixel() <= dragThresholdMm()) return;
    draggingPointId.value = pendingPointId.value;
    pendingPointId.value = null;
    pendingDownScreen.value = null;
  }
  if (draggingPointId.value === null) return;
  emit('pointDrag', draggingPointId.value, cursorMm.value);
  const target = hitPoint(cursorMm.value);
  dragSnapTargetId.value = target !== null && target !== draggingPointId.value ? target : null;
}

function onPointerUp(event: PointerEvent): void {
  if (endPan(event)) return;
  if (pendingPointId.value !== null) {
    const clickedId = pendingPointId.value;
    pendingPointId.value = null;
    pendingDownScreen.value = null;
    emit('entityClick', clickedId);
    return;
  }
  if (draggingPointId.value !== null) {
    const draggedId = draggingPointId.value;
    const targetId = dragSnapTargetId.value;
    draggingPointId.value = null;
    dragSnapTargetId.value = null;
    if (targetId !== null && targetId !== draggedId) {
      emit('pointDragMerge', draggedId, targetId);
    }
    emit('pointDragEnd');
  }
}

function onPointerLeave(event: PointerEvent): void {
  cursorMm.value = null;
  endPan(event);
}

/**
 * A browser-initiated pointer cancel (e.g. a touch gesture claimed by the
 * browser, or a stylus losing contact) mid-drag. Funnels through the same
 * exit path as pointerup, but never merges: a cancel is treated as a plain
 * drag end, since the pointer position at cancel time is not a deliberate
 * release the user aimed at another point. Without this, draggingPointId and
 * the store's beginPointDrag recording scope would stay open forever,
 * silently suppressing every later undo snapshot.
 */
function onPointerCancel(event: PointerEvent): void {
  if (endPan(event)) return;
  if (pendingPointId.value !== null) {
    pendingPointId.value = null;
    pendingDownScreen.value = null;
    return;
  }
  if (draggingPointId.value !== null) {
    draggingPointId.value = null;
    dragSnapTargetId.value = null;
    emit('pointDragEnd');
  }
}

/** The point id within the screen-pixel snap radius, or null. */
function hitPoint(at: MmPoint): string | null {
  const radius = snapRadiusMm();
  for (const p of points.value) {
    if (Math.hypot(p.x - at.x, p.y - at.y) <= radius) return p.id;
  }
  return null;
}

/** Tools that place points by clicking, where an existing point should be
 * snapped to and shown a hover ring instead of creating a duplicate. */
const snapTargetTools = new Set(['line', 'arcThreePoint', 'arcTangent', 'circle']);

/** The point the cursor currently hovers within snap range of, for the
 * snap-indicator ring; null when the active tool does not place points. */
const hoverSnapPointId = computed<string | null>(() => {
  if (cursorMm.value === null || !snapTargetTools.has(activeTool.value)) return null;
  return hitPoint(cursorMm.value);
});
const hoverSnapPoint = computed(() =>
  hoverSnapPointId.value === null ? null : pointById.value.get(hoverSnapPointId.value) ?? null,
);

/** The point behind the snap-indicator ring: either the placement-tool hover
 * snap, or (while dragging a point with the select tool) the merge target
 * within snap range, whichever applies. */
const activeSnapPoint = computed(() => {
  if (hoverSnapPoint.value !== null) return hoverSnapPoint.value;
  return dragSnapTargetId.value === null ? null : pointById.value.get(dragSnapTargetId.value) ?? null;
});

/** The open chain's tail point, for the highlighted-tail and rubber-band cue. */
const chainTailPoint = computed(() =>
  chainTailId.value === null ? null : pointById.value.get(chainTailId.value) ?? null,
);

/** The dashed rubber-band line from the open chain's tail to the cursor,
 * shown only while the line tool is active (the multi-click tools' own
 * ghost preview below covers arcThreePoint and arcTangent). */
const rubberBand = computed(() => {
  if (chainTailPoint.value === null || cursorMm.value === null) return null;
  if (activeTool.value !== 'line') return null;
  return { x1: chainTailPoint.value.x, y1: chainTailPoint.value.y, x2: cursorMm.value.x, y2: cursorMm.value.y };
});

/** SVG path data for the arc from `start` to `end` about `center`, in the
 * same convention entityPaths uses for a stored (always-ccw) arc: the sweep
 * flag mirrors ccw so a clockwise-derived preview arc still bulges the
 * right way. */
function arcPreviewPathD(center: MmPoint, start: MmPoint, end: MmPoint, ccw: boolean): string {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let a1 = Math.atan2(end.y - center.y, end.x - center.x);
  if (ccw) {
    if (a1 <= a0) a1 += 2 * Math.PI;
  } else if (a1 >= a0) {
    a1 -= 2 * Math.PI;
  }
  const largeArc = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} ${ccw ? 1 : 0} ${end.x} ${end.y}`;
}

/** SVG path data for a thin stadium (capsule) outline along the axis from
 * `a` to `b`, half-width `r`: two straight sides and two semicircle caps. */
function capsulePreviewPathD(a: MmPoint, b: MmPoint, r: number): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const topA = { x: a.x + nx * r, y: a.y + ny * r };
  const botA = { x: a.x - nx * r, y: a.y - ny * r };
  const topB = { x: b.x + nx * r, y: b.y + ny * r };
  const botB = { x: b.x - nx * r, y: b.y - ny * r };
  return (
    `M ${topA.x} ${topA.y} L ${topB.x} ${topB.y} ` +
    `A ${r} ${r} 0 1 1 ${botB.x} ${botB.y} L ${botA.x} ${botA.y} ` +
    `A ${r} ${r} 0 1 1 ${topA.x} ${topA.y} Z`
  );
}

/** Half-width of the slot tool's ghost preview before a width is typed: a
 * thin capsule just wide enough to read as a capsule rather than a line. */
const SLOT_PREVIEW_HALF_WIDTH_MM = 1;

type GhostPreview =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'path'; d: string };

/**
 * The dashed, display-only preview of a multi-click tool's in-progress
 * shape, following the cursor after each committed click. One exhaustive
 * switch over every sketch tool (assertNever guards a tool added later
 * without a preview case). Each branch reuses the same construction math the
 * tool's commit path uses (arcFromThreePoints, arcTangentToPoint via
 * tangentDirectionAtPoint), so the preview never promises a shape the commit
 * would not actually produce (convention 10). Never touches the sketch
 * model; cleared automatically whenever pendingClicks is cleared, since every
 * branch below reads it.
 */
const ghostPreview = computed<GhostPreview | null>(() => {
  const cursor = cursorMm.value;
  if (cursor === null) return null;
  const clicks = pendingClicks.value;
  switch (activeTool.value) {
    case 'select':
    case 'dimension':
      return null;
    case 'line':
      // The rubber band above already covers the line tool.
      return null;
    case 'circle': {
      if (clicks.length !== 1) return null;
      const center = clicks[0];
      return { kind: 'circle', cx: center.x, cy: center.y, r: Math.hypot(cursor.x - center.x, cursor.y - center.y) };
    }
    case 'rectangle': {
      if (clicks.length !== 1) return null;
      const c1 = clicks[0];
      const x1 = Math.min(c1.x, cursor.x);
      const y1 = Math.min(c1.y, cursor.y);
      const x2 = Math.max(c1.x, cursor.x);
      const y2 = Math.max(c1.y, cursor.y);
      return { kind: 'path', d: `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2} L ${x1} ${y2} Z` };
    }
    case 'arcThreePoint': {
      if (clicks.length === 0) {
        return chainTailPoint.value === null
          ? null
          : { kind: 'line', x1: chainTailPoint.value.x, y1: chainTailPoint.value.y, x2: cursor.x, y2: cursor.y };
      }
      if (clicks.length === 1) {
        return { kind: 'line', x1: clicks[0].x, y1: clicks[0].y, x2: cursor.x, y2: cursor.y };
      }
      const [start, end] = clicks;
      const derived = arcFromThreePoints(start, cursor, end);
      if (derived === null) return { kind: 'line', x1: start.x, y1: start.y, x2: cursor.x, y2: cursor.y };
      return { kind: 'path', d: arcPreviewPathD(derived.center, start, end, derived.ccw) };
    }
    case 'arcTangent': {
      const tail = chainTailPoint.value;
      if (tail === null) return null;
      if (clicks.length === 0) {
        const segmentId = chainTailSegmentId.value;
        const tailId = chainTailId.value;
        const dir =
          segmentId !== null && tailId !== null
            ? tangentDirectionAtPoint(sketch.value, segmentId, tailId)
            : null;
        if (dir === null) return { kind: 'line', x1: tail.x, y1: tail.y, x2: cursor.x, y2: cursor.y };
        const derived = arcTangentToPoint(tail, dir, cursor);
        if (derived === null) return { kind: 'line', x1: tail.x, y1: tail.y, x2: cursor.x, y2: cursor.y };
        return { kind: 'path', d: arcPreviewPathD(derived.center, tail, cursor, derived.ccw) };
      }
      const end = clicks[0];
      const derived = arcFromThreePoints(tail, cursor, end);
      if (derived === null) return { kind: 'line', x1: tail.x, y1: tail.y, x2: cursor.x, y2: cursor.y };
      return { kind: 'path', d: arcPreviewPathD(derived.center, tail, end, derived.ccw) };
    }
    case 'slot': {
      if (clicks.length !== 1) return null;
      return { kind: 'path', d: capsulePreviewPathD(clicks[0], cursor, SLOT_PREVIEW_HALF_WIDTH_MM) };
    }
    case 'mirror': {
      if (clicks.length !== 1) return null;
      const a = clicks[0];
      return { kind: 'line', x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y };
    }
    default:
      return assertNever(activeTool.value);
  }
});

/** Whether Alt is currently held, suppressing the auto H/V hint and
 * inference; tracked from the last pointermove/keydown, display only. */
const altHeld = ref(false);

/**
 * The pre-commit H/V hint glyph: while the line tool's rubber band falls
 * within the auto H/V snap band (engine/sketch/autoInfer.ts) and Alt is not
 * held, a small H or V letter shows near the cursor so the user sees the
 * inference coming before they click. Reuses inferHVConstraint, the same
 * function the store applies on placement, so the hint never promises a
 * constraint the store would not actually add (convention 10).
 */
const hvHint = computed<{ x: number; y: number; text: 'H' | 'V' } | null>(() => {
  if (rubberBand.value === null || altHeld.value || activeTool.value !== 'line') return null;
  const inferred = inferHVConstraint(
    rubberBand.value.x2 - rubberBand.value.x1,
    rubberBand.value.y2 - rubberBand.value.y1,
  );
  if (inferred === null) return null;
  return {
    x: rubberBand.value.x2,
    y: rubberBand.value.y2 - mmPerScreenPixel() * 14,
    text: inferred === 'horizontal' ? 'H' : 'V',
  };
});

/**
 * The live length (and, for a line, angle) readout beside the rubber-band
 * cursor while drawing. Raw labeled values (convention 8), not prose.
 */
const liveReadout = computed<{ x: number; y: number; text: string } | null>(() => {
  if (rubberBand.value === null) return null;
  const dx = rubberBand.value.x2 - rubberBand.value.x1;
  const dy = rubberBand.value.y2 - rubberBand.value.y1;
  const length = Math.hypot(dx, dy);
  const lengthText = `${length.toFixed(1)} mm`;
  const text = activeTool.value === 'line'
    ? `${lengthText}  ${(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360).toFixed(1)} deg`
    : lengthText;
  return { x: rubberBand.value.x2 + mmPerScreenPixel() * 10, y: rubberBand.value.y2 + mmPerScreenPixel() * 10, text };
});

/**
 * Invisible hit-path stroke width, in mm, for the wide click target laid
 * over each thin entity path. Screen-px-derived (12px) so the click
 * tolerance tracks zoom instead of a value fitted to one zoom level;
 * reading view.value inside establishes the Vue reactivity dependency that
 * mmPerScreenPixel's DOM read alone would not.
 */
const hitStrokeWidthMm = computed(() => {
  void view.value;
  return mmPerScreenPixel() * 12;
});

/** Anchor position of a dimension label, midway along its geometry. */
const dimensionLabels = computed(() =>
  sketch.value.constraints
    .map((c) => {
      switch (c.kind) {
        case 'length': {
          const line = sketch.value.entities.find((e) => e.id === c.lineId);
          if (line === undefined || line.kind !== 'line') return null;
          const a = pointById.value.get(line.p1Id)!;
          const b = pointById.value.get(line.p2Id)!;
          return { id: c.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${formatMm(c.mm)} mm` };
        }
        case 'distance': {
          const a = pointById.value.get(c.p1Id)!;
          const b = pointById.value.get(c.p2Id)!;
          return { id: c.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${formatMm(c.mm)} mm` };
        }
        case 'radius':
        case 'diameter': {
          const entity = sketch.value.entities.find((e) => e.id === c.entityId);
          if (entity === undefined || (entity.kind !== 'arc' && entity.kind !== 'circle')) return null;
          const center = pointById.value.get(entity.centerId)!;
          const prefix = c.kind === 'radius' ? 'R' : 'D';
          return { id: c.id, x: center.x, y: center.y, text: `${prefix} ${formatMm(c.mm)} mm` };
        }
        case 'angle': {
          const line = sketch.value.entities.find((e) => e.id === c.l1Id);
          if (line === undefined || line.kind !== 'line') return null;
          const a = pointById.value.get(line.p1Id)!;
          return { id: c.id, x: a.x, y: a.y, text: `${formatDegrees(c.degrees)} deg` };
        }
        case 'coincident':
        case 'horizontal':
        case 'vertical':
        case 'parallel':
        case 'perpendicular':
        case 'tangent':
        case 'symmetric':
          return null;
        default:
          return assertNever(c);
      }
    })
    .filter((label): label is NonNullable<typeof label> => label !== null),
);

/** Glyph color: the muted default, or the selection accent when its
 * constraint is the current selectedConstraintId. Distinct from geometry
 * colors (blue/green/red), the entity selection accent, and the dimension
 * label color, per the glyph design. */
function glyphColorOf(constraintId: string): string {
  if (constraintId === selectedConstraintId.value || constraintId === hoveredConstraintId.value) {
    return '#ff9800';
  }
  return '#607d8b';
}

/** Millimeters per screen pixel, re-read whenever the view changes, so glyph
 * sizes stay constant in screen px across zoom levels (same pattern as
 * hitStrokeWidthMm above). */
const glyphMmPerPx = computed(() => {
  void view.value;
  return mmPerScreenPixel();
});

function unitVec(angleDeg: number): { ux: number; uy: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { ux: Math.cos(rad), uy: Math.sin(rad) };
}

interface ParallelTickGlyph { key: string; constraintId: string; x1: number; y1: number; x2: number; y2: number }
interface PerpendicularGlyph { key: string; constraintId: string; d: string }
interface LetterGlyph { key: string; constraintId: string; x: number; y: number; text: 'H' | 'V' }
interface DotGlyph { key: string; constraintId: string; cx: number; cy: number; r: number }
interface SymmetricGlyph { key: string; constraintId: string; d: string }
/** An invisible, enlarged click target centred on a glyph's anchor point,
 * screen-px sized so it stays easy to hit at any zoom regardless of how
 * small the glyph itself renders. */
interface GlyphHitCircle { key: string; constraintId: string; cx: number; cy: number; r: number }

/** Screen pixels of the invisible hit circle's radius per glyph. */
const GLYPH_HIT_RADIUS_PX = 16;

/**
 * Ready-to-draw glyph primitives for every constraint the sketch carries,
 * grouped by SVG shape so the template stays simple. Built by one exhaustive
 * switch over constraintGlyphs' kinds (assertNever guards new kinds), sized
 * in screen px via glyphMmPerPx so glyphs read the same size at any zoom.
 * Twice the earlier size and stroke, per the spec's readability pass; each
 * glyph also gets an invisible enlarged hit circle in hitCircles so a click
 * near (not just exactly on) the drawn glyph selects it.
 */
const glyphShapes = computed(() => {
  const parallelTicks: ParallelTickGlyph[] = [];
  const rightAngles: PerpendicularGlyph[] = [];
  const letters: LetterGlyph[] = [];
  const tangentDots: DotGlyph[] = [];
  const coincidentRings: DotGlyph[] = [];
  const symmetricMarks: SymmetricGlyph[] = [];
  const hitCircles: GlyphHitCircle[] = [];
  const empty = { parallelTicks, rightAngles, letters, tangentDots, coincidentRings, symmetricMarks, hitCircles };
  if (!glyphsVisible.value) return empty;

  const scale = glyphMmPerPx.value;
  const tickLen = scale * 10;
  const tickGap = scale * 5;
  const rightAngleSize = scale * 12;
  const letterOffset = scale * 12;
  const dotR = scale * 4;
  const ringR = scale * 7;
  const arrowLen = scale * 12;
  const hitR = scale * GLYPH_HIT_RADIUS_PX;

  for (const g of constraintGlyphs(sketch.value)) {
    switch (g.kind) {
      case 'parallel': {
        const { ux, uy } = unitVec(g.angleDeg);
        const px = -uy;
        const py = ux;
        for (let n = 0; n < g.tickCount; n++) {
          const offset = (n - (g.tickCount - 1) / 2) * tickGap;
          const cx = g.at.x + ux * offset;
          const cy = g.at.y + uy * offset;
          parallelTicks.push({
            key: `${g.constraintId}-${n}`,
            constraintId: g.constraintId,
            x1: cx + px * tickLen,
            y1: cy + py * tickLen,
            x2: cx - px * tickLen,
            y2: cy - py * tickLen,
          });
        }
        hitCircles.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: hitR });
        break;
      }
      case 'perpendicular': {
        const { ux, uy } = unitVec(g.angleDeg);
        const px = -uy;
        const py = ux;
        const a = { x: g.at.x + ux * rightAngleSize, y: g.at.y + uy * rightAngleSize };
        const b = { x: g.at.x + px * rightAngleSize, y: g.at.y + py * rightAngleSize };
        const corner = { x: a.x + px * rightAngleSize, y: a.y + py * rightAngleSize };
        rightAngles.push({
          key: g.constraintId,
          constraintId: g.constraintId,
          d: `M ${a.x} ${a.y} L ${corner.x} ${corner.y} L ${b.x} ${b.y}`,
        });
        hitCircles.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: hitR });
        break;
      }
      case 'horizontal':
        letters.push({ key: g.constraintId, constraintId: g.constraintId, x: g.at.x, y: g.at.y - letterOffset, text: 'H' });
        hitCircles.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y - letterOffset, r: hitR });
        break;
      case 'vertical':
        letters.push({ key: g.constraintId, constraintId: g.constraintId, x: g.at.x, y: g.at.y - letterOffset, text: 'V' });
        hitCircles.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y - letterOffset, r: hitR });
        break;
      case 'tangent':
        tangentDots.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: dotR });
        hitCircles.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: hitR });
        break;
      case 'coincident':
        coincidentRings.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: ringR });
        hitCircles.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: hitR });
        break;
      case 'symmetric': {
        const { ux, uy } = unitVec(g.angleDeg + 90);
        const aTip = { x: g.aAt.x + ux * arrowLen, y: g.aAt.y + uy * arrowLen };
        const bTip = { x: g.bAt.x + ux * arrowLen, y: g.bAt.y + uy * arrowLen };
        symmetricMarks.push({
          key: g.constraintId,
          constraintId: g.constraintId,
          d: `M ${g.aAt.x} ${g.aAt.y} L ${aTip.x} ${aTip.y} M ${g.bAt.x} ${g.bAt.y} L ${bTip.x} ${bTip.y}`,
        });
        hitCircles.push({
          key: g.constraintId,
          constraintId: g.constraintId,
          cx: (g.aAt.x + g.bAt.x) / 2,
          cy: (g.aAt.y + g.bAt.y) / 2,
          r: hitR,
        });
        break;
      }
      default:
        assertNever(g);
    }
  }
  return { parallelTicks, rightAngles, letters, tangentDots, coincidentRings, symmetricMarks, hitCircles };
});

const glyphStrokeWidthMm = computed(() => glyphMmPerPx.value * 2.6);
const glyphFontSizeMm = computed(() => glyphMmPerPx.value * 18);

/**
 * The small x badge on the selected constraint's glyph, screen-px sized and
 * offset from the glyph's hit-circle anchor so it does not sit on top of the
 * glyph itself. Removes the constraint directly (editor.removeConstraint) on
 * click rather than routing through an emit, since the canvas already owns
 * the store instance and no workspace-level state depends on this action.
 */
const selectedGlyphBadge = computed<{ x: number; y: number; constraintId: string } | null>(() => {
  if (selectedConstraintId.value === null) return null;
  const hit = glyphShapes.value.hitCircles.find((h) => h.constraintId === selectedConstraintId.value);
  if (hit === undefined) return null;
  const scale = glyphMmPerPx.value;
  return { x: hit.cx + scale * 14, y: hit.cy - scale * 14, constraintId: hit.constraintId };
});
const BADGE_RADIUS_PX = 7;
const badgeRadiusMm = computed(() => glyphMmPerPx.value * BADGE_RADIUS_PX);
const badgeFontSizeMm = computed(() => glyphMmPerPx.value * 10);

/** Removes the selected constraint from its glyph's x badge. */
function removeSelectedConstraint(constraintId: string): void {
  editor.removeConstraint(constraintId);
}
</script>

<template>
  <svg
    ref="svgEl"
    class="sketch-canvas"
    :viewBox="viewBox"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerLeave"
    @pointercancel="onPointerCancel"
    :class="canvasCursorClass"
  >
    <image
      v-if="underlayUrl !== null && underlayMmPerPixel !== null"
      :href="underlayUrl"
      x="0"
      y="0"
      :opacity="underlayOpacityPct / 100"
      :style="{ transform: `scale(${underlayMmPerPixel})` }"
    />
    <g class="grid">
      <line
        v-for="(g, i) in gridLines"
        :key="i"
        :x1="g.x1"
        :y1="g.y1"
        :x2="g.x2"
        :y2="g.y2"
        stroke="#e0e0e0"
        stroke-width="0.15"
      />
    </g>
    <g class="regions">
      <path
        v-for="r in regionPaths"
        :key="r.id"
        :d="r.d"
        fill-rule="evenodd"
        :fill="regionFill(r.id)"
        :fill-opacity="regionOpacity(r.id)"
        stroke="none"
        style="cursor: pointer"
        @click.stop="editor.selectRegion(r.id)"
        @pointerenter="hoveredRegionId = r.id"
        @pointerleave="hoveredRegionId = hoveredRegionId === r.id ? null : hoveredRegionId"
      />
    </g>
    <g class="entities">
      <template v-for="{ entity, d } in entityPaths" :key="entity.id">
        <path
          :d="d"
          fill="none"
          :stroke="strokeOf(entity)"
          :stroke-width="0.6"
          :stroke-dasharray="entity.construction ? '1.5 1' : undefined"
          style="pointer-events: none"
        />
        <path
          :d="d"
          fill="none"
          stroke="transparent"
          :stroke-width="hitStrokeWidthMm"
          @click.stop="emit('entityClick', entity.id)"
        />
      </template>
      <circle
        v-for="p in points"
        :key="p.id"
        :cx="p.x"
        :cy="p.y"
        :r="p.id === chainTailId ? 1.6 : 0.9"
        :fill="p.id === chainTailId ? '#ff6f00' : strokeOf(p)"
      />
      <line
        v-if="rubberBand !== null"
        :x1="rubberBand.x1"
        :y1="rubberBand.y1"
        :x2="rubberBand.x2"
        :y2="rubberBand.y2"
        stroke="#ff6f00"
        stroke-width="0.4"
        stroke-dasharray="1.2 1"
      />
      <line
        v-if="ghostPreview !== null && ghostPreview.kind === 'line'"
        :x1="ghostPreview.x1"
        :y1="ghostPreview.y1"
        :x2="ghostPreview.x2"
        :y2="ghostPreview.y2"
        stroke="#ff6f00"
        stroke-width="0.4"
        stroke-dasharray="1.2 1"
        style="pointer-events: none"
      />
      <circle
        v-if="ghostPreview !== null && ghostPreview.kind === 'circle'"
        :cx="ghostPreview.cx"
        :cy="ghostPreview.cy"
        :r="ghostPreview.r"
        fill="none"
        stroke="#ff6f00"
        stroke-width="0.4"
        stroke-dasharray="1.2 1"
        style="pointer-events: none"
      />
      <path
        v-if="ghostPreview !== null && ghostPreview.kind === 'path'"
        :d="ghostPreview.d"
        fill="none"
        stroke="#ff6f00"
        stroke-width="0.4"
        stroke-dasharray="1.2 1"
        style="pointer-events: none"
      />
      <circle
        v-if="activeSnapPoint !== null"
        class="snap-indicator"
        :cx="activeSnapPoint.x"
        :cy="activeSnapPoint.y"
        r="2.4"
        fill="none"
        stroke="#ff6f00"
        stroke-width="0.4"
      />
      <text
        v-if="hvHint !== null"
        :x="hvHint.x"
        :y="hvHint.y"
        font-size="4"
        text-anchor="middle"
        fill="#ff6f00"
        style="pointer-events: none"
      >{{ hvHint.text }}</text>
      <text
        v-if="liveReadout !== null"
        :x="liveReadout.x"
        :y="liveReadout.y"
        font-size="3"
        fill="#424242"
        style="pointer-events: none"
      >{{ liveReadout.text }}</text>
    </g>
    <g class="dimensions">
      <text
        v-for="label in dimensionLabels"
        :key="label.id"
        :x="label.x"
        :y="label.y - 1.5"
        font-size="3"
        text-anchor="middle"
        fill="#6a1b9a"
        style="cursor: pointer"
        @click.stop="emit('dimensionClick', label.id, { x: label.x, y: label.y })"
      >
        {{ label.text }}
      </text>
    </g>
    <g class="constraint-glyphs">
      <line
        v-for="tick in glyphShapes.parallelTicks"
        :key="tick.key"
        :x1="tick.x1"
        :y1="tick.y1"
        :x2="tick.x2"
        :y2="tick.y2"
        :stroke="glyphColorOf(tick.constraintId)"
        :stroke-width="glyphStrokeWidthMm"
        style="cursor: pointer"
        @click.stop="emit('constraintClick', tick.constraintId)"
      />
      <path
        v-for="ra in glyphShapes.rightAngles"
        :key="ra.key"
        :d="ra.d"
        fill="none"
        :stroke="glyphColorOf(ra.constraintId)"
        :stroke-width="glyphStrokeWidthMm"
        style="cursor: pointer"
        @click.stop="emit('constraintClick', ra.constraintId)"
      />
      <text
        v-for="letter in glyphShapes.letters"
        :key="letter.key"
        :x="letter.x"
        :y="letter.y"
        :font-size="glyphFontSizeMm"
        text-anchor="middle"
        :fill="glyphColorOf(letter.constraintId)"
        style="cursor: pointer"
        @click.stop="emit('constraintClick', letter.constraintId)"
      >{{ letter.text }}</text>
      <circle
        v-for="dot in glyphShapes.tangentDots"
        :key="dot.key"
        :cx="dot.cx"
        :cy="dot.cy"
        :r="dot.r"
        :fill="glyphColorOf(dot.constraintId)"
        style="cursor: pointer"
        @click.stop="emit('constraintClick', dot.constraintId)"
      />
      <circle
        v-for="ring in glyphShapes.coincidentRings"
        :key="ring.key"
        :cx="ring.cx"
        :cy="ring.cy"
        :r="ring.r"
        fill="none"
        :stroke="glyphColorOf(ring.constraintId)"
        :stroke-width="glyphStrokeWidthMm"
        style="cursor: pointer"
        @click.stop="emit('constraintClick', ring.constraintId)"
      />
      <path
        v-for="mark in glyphShapes.symmetricMarks"
        :key="mark.key"
        :d="mark.d"
        fill="none"
        :stroke="glyphColorOf(mark.constraintId)"
        :stroke-width="glyphStrokeWidthMm"
        style="cursor: pointer"
        @click.stop="emit('constraintClick', mark.constraintId)"
      />
      <!-- Invisible, enlarged click targets: one per glyph, so a click near
           (not just exactly on) the thin drawn glyph still selects it. -->
      <circle
        v-for="hit in glyphShapes.hitCircles"
        :key="`hit-${hit.key}`"
        :cx="hit.cx"
        :cy="hit.cy"
        :r="hit.r"
        fill="transparent"
        stroke="none"
        style="cursor: pointer"
        @click.stop="emit('constraintClick', hit.constraintId)"
      />
      <!-- The selected glyph's removal badge: a small x that removes the
           constraint directly, without needing Delete or the toolbar. -->
      <g
        v-if="selectedGlyphBadge !== null"
        style="cursor: pointer"
        @click.stop="removeSelectedConstraint(selectedGlyphBadge.constraintId)"
      >
        <circle
          :cx="selectedGlyphBadge.x"
          :cy="selectedGlyphBadge.y"
          :r="badgeRadiusMm"
          fill="#e53935"
        />
        <text
          :x="selectedGlyphBadge.x"
          :y="selectedGlyphBadge.y"
          :font-size="badgeFontSizeMm"
          text-anchor="middle"
          dominant-baseline="central"
          fill="#ffffff"
          style="pointer-events: none"
        >x</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.sketch-canvas {
  width: 100%;
  height: 100%;
  touch-action: none;
  background: #fafafa;
}

/* Space is held to pan; show the grab cursor, grabbing while dragging,
   matching TraceCanvas's convention. */
.cursor-grab {
  cursor: grab;
}
.cursor-grabbing {
  cursor: grabbing;
}
</style>
