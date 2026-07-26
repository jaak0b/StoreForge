<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor, type CanvasUnderlay, type UnderlayHandleKind } from '../../../stores/sketchEditor';
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
import type { SketchDimension, SketchEntity } from '../../../engine/sketch/model';
import {
  arcFromThreePoints,
  arcTangentToPoint,
  tangentDirectionAtPoint,
} from '../../../engine/sketch/model';
import { constraintGlyphs } from '../../../engine/sketch/constraintGlyphs';
import { inferHVConstraint } from '../../../engine/sketch/autoInfer';
import { formatMm, formatDegrees, measureLineLength, measurePointAxisDistance, measurePointDistance, measurePointLineDistance, measureRadius, parseDimensionValue } from '../../../engine/sketch/measure';
import {
  DEFAULT_LABEL_OFFSET,
  dimensionAnchor,
  dimensionGraphics,
  type DimensionGraphics,
} from '../../../engine/sketch/dimensionGraphics';
import {
  anchorForDimensionSelection,
  pickDistanceAxis,
  resolveAngleAtCursor,
} from '../../../engine/sketch/dimensionSelection';

const emit = defineEmits<{
  /** A canvas click in mm, for the active drawing tool. altKey is the Alt
   * modifier at click time, which suppresses auto H/V inference. */
  (e: 'canvasClick', at: MmPoint, hitPointId: string | null, altKey: boolean, isEntityHit: boolean): void;
  /** A drag of an existing point to a new mm position (driven point). */
  (e: 'pointDrag', pointId: string, at: MmPoint): void;
  (e: 'pointDragEnd'): void;
  /** A dragged point released within snap range of another point; the
   * workspace merges them with a coincident constraint. */
  (e: 'pointDragMerge', draggedPointId: string, targetPointId: string): void;
  (e: 'entityClick', entityId: string): void;
  /** A dimension mutation (draft commit, or a radius/diameter toggle on an
   * already-committed dimension) that changed the sketch and needs a solve.
   * Solve debouncing (scheduleSolve) lives in SketchWorkspace, not here. */
  (e: 'requestSolve'): void;
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
  underlays,
  selectedUnderlayId,
  calibrating,
  calibrateClicks,
  calibrateDraft,
  calibrateDraftError,
  activeTool,
  chainTailId,
  chainTailSegmentId,
  regionFaces,
  selectedRegionIds,
  cursorMm,
  hoveredConstraintId,
  hoveredEntityIds,
  pendingClicks,
  dimensionPending,
  dimensionDraft,
  dimensionDraftError,
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

/** Region shading: light CAD blue, hover raises opacity, a selected region
 * (any number can be selected at once) reads distinct and stronger.
 *
 * The region fills only pick up pointer events with the select tool active
 * (see the "regions" group's :style binding below): with any point-placement
 * tool active (dimension, line, arc, circle, rectangle, slot, mirror), the
 * region layer is pointer-events:none so clicks fall through to the canvas's
 * own pointerdown handler instead of landing on a region <path> element. That
 * matters because isEntityTarget() below treats any SVGPathElement as an
 * entity hit; before this fix, a click inside a shaded region during
 * dimension-label placement was misread as a hit on the region path, so
 * placeDimensionDraft's `!isEntityHit` guard in SketchWorkspace's
 * onCanvasClick never fired and the pending dimension's label failed to
 * place. Manual verification: activate the dimension tool, pick an entity so
 * a label is pending, then click inside a shaded region versus outside it;
 * both must place the label. Also confirm region selection still works with
 * the select tool (click a region toggles it) and that line/circle/rectangle
 * point placement over a shaded region is unaffected (it never depended on
 * isEntityHit, so it worked before and after). */
function regionFill(regionId: string): string {
  return selectedRegionIds.value.includes(regionId) ? '#1565c0' : '#1e88e5';
}
function regionOpacity(regionId: string): number {
  if (selectedRegionIds.value.includes(regionId)) return 0.35;
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

/** Converts an mm sketch point to pixels relative to the svg element's own
 * top-left, the coordinate space the absolutely-positioned dimension input
 * overlay is placed in (the overlay is a sibling of the svg inside the same
 * relatively-positioned wrapper). Exact inverse of clientToMm's transform. */
function mmToScreenPx(at: MmPoint): { x: number; y: number } {
  const svg = svgEl.value;
  if (svg === null) return { x: 0, y: 0 };
  const ctm = svg.getScreenCTM();
  if (ctm === null) return { x: 0, y: 0 };
  const point = svg.createSVGPoint();
  point.x = at.x;
  point.y = at.y;
  const screen = point.matrixTransform(ctm);
  const rect = svg.getBoundingClientRect();
  return { x: screen.x - rect.left, y: screen.y - rect.top };
}

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
  view.value = zoomToCursor(
    view.value,
    view.value.zoom * factor,
    anchor,
    WINDOW_MM,
    WINDOW_MM,
    SKETCH_ZOOM_RANGE,
    { unbounded: true },
  );
}

/**
 * Applies a pan offset. Unlike the photo trace canvas, the sketch has no
 * fixed content frame to keep in view (it's an open-ended design space), so
 * panning is unclamped: clampPan's bound would have to be an arbitrary
 * virtual window rather than a real content extent, fencing the user near
 * wherever the view started instead of the actual sketch content.
 */
function setPan(nextPanX: number, nextPanY: number): void {
  const clamped = clampPan(
    { zoom: view.value.zoom, panX: nextPanX, panY: nextPanY },
    WINDOW_MM,
    WINDOW_MM,
    { unbounded: true },
  );
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

/**
 * Converts a point in the underlay's local (unscaled, unrotated,
 * center-origin) pixel space to current sketch mm, applying scale then
 * rotation then translation: this is the single source every underlay
 * rendering, bounds and manipulator calculation reads, so the transform math
 * never drifts between them.
 */
function underlayLocalToWorld(u: CanvasUnderlay, local: MmPoint): MmPoint {
  const rad = (u.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = local.x * u.scaleX;
  const sy = local.y * u.scaleY;
  return { x: u.xMm + sx * cos - sy * sin, y: u.yMm + sx * sin + sy * cos };
}

/**
 * Inverse of underlayLocalToWorld's rotation and translation only (not the
 * scale): converts a world mm point to the underlay's rotated-but-unscaled
 * local frame, i.e. (scaleX*localX, scaleY*localY). The manipulator's scale
 * math divides this by the known unscaled offset to recover the new scale,
 * which only works because rotation is undone here first.
 */
function underlayWorldToRotatedLocal(u: CanvasUnderlay, world: MmPoint): MmPoint {
  const rad = (-u.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = world.x - u.xMm;
  const dy = world.y - u.yMm;
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** The underlay's four corners in current sketch mm, for framing and bounds. */
function underlayCornersMm(u: CanvasUnderlay): MmPoint[] {
  const hw = u.naturalWidthPx / 2;
  const hh = u.naturalHeightPx / 2;
  return [
    underlayLocalToWorld(u, { x: -hw, y: -hh }),
    underlayLocalToWorld(u, { x: hw, y: -hh }),
    underlayLocalToWorld(u, { x: hw, y: hh }),
    underlayLocalToWorld(u, { x: -hw, y: hh }),
  ];
}

/** Sketch entity/underlay bounds in mm, or null when the sketch is empty. */
function sketchBoundsMm(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.value.length === 0 && underlays.value.length === 0) return null;
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
  for (const u of underlays.value) {
    for (const corner of underlayCornersMm(u)) {
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
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
const canFit = computed(() => points.value.length > 0 || underlays.value.length > 0);

/** The current view's center in sketch mm, the inverse of the viewBox
 * computed above; used to center a freshly inserted underlay in view
 * (Fusion's Canvas insert behavior). */
function viewCenterMm(): MmPoint {
  const size = WINDOW_MM / view.value.zoom;
  return {
    x: -view.value.panX / view.value.zoom + size / 4,
    y: -view.value.panY / view.value.zoom + size / 4,
  };
}

defineExpose({ fitToView, canFit, viewCenterMm });

const points = computed(() =>
  sketch.value.entities.filter((e): e is Extract<SketchEntity, { kind: 'point' }> => e.kind === 'point'),
);
const pointById = computed(() => new Map(points.value.map((p) => [p.id, p])));

/** SVG path data of every non-point entity, keyed by entity id. */
/**
 * SVG path data of every non-point entity, keyed by entity id. An entity
 * whose point references are dangling (should never happen: deleteEntities
 * cascades point deletion to its dependents) is skipped rather than thrown
 * from, so one bad entity can never blank out the whole canvas; no attempt
 * is made to repair the data.
 */
const entityPaths = computed(() =>
  sketch.value.entities
    .filter((e) => e.kind !== 'point')
    .flatMap((entity): { entity: SketchEntity; d: string }[] => {
      switch (entity.kind) {
        case 'line': {
          const a = pointById.value.get(entity.p1Id);
          const b = pointById.value.get(entity.p2Id);
          if (a === undefined || b === undefined) return [];
          return [{ entity, d: `M ${a.x} ${a.y} L ${b.x} ${b.y}` }];
        }
        case 'arc': {
          const c = pointById.value.get(entity.centerId);
          const s = pointById.value.get(entity.startId);
          const e2 = pointById.value.get(entity.endId);
          if (c === undefined || s === undefined || e2 === undefined) return [];
          const r = Math.hypot(s.x - c.x, s.y - c.y);
          const a0 = Math.atan2(s.y - c.y, s.x - c.x);
          let a1 = Math.atan2(e2.y - c.y, e2.x - c.x);
          if (a1 <= a0) a1 += 2 * Math.PI;
          const largeArc = a1 - a0 > Math.PI ? 1 : 0;
          return [{ entity, d: `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e2.x} ${e2.y}` }];
        }
        case 'circle': {
          const c = pointById.value.get(entity.centerId);
          if (c === undefined) return [];
          return [
            {
              entity,
              d:
                `M ${c.x + entity.radiusMm} ${c.y} ` +
                `A ${entity.radiusMm} ${entity.radiusMm} 0 1 1 ${c.x - entity.radiusMm} ${c.y} ` +
                `A ${entity.radiusMm} ${entity.radiusMm} 0 1 1 ${c.x + entity.radiusMm} ${c.y}`,
            },
          ];
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

/**
 * Fusion-style manipulator for the selected underlay: a body drag (move), a
 * corner handle (uniform scale about the opposite corner, chosen over
 * "about center" so the anchor stays visually pinned the way Fusion's own
 * corner drag behaves), a side handle (non-uniform scale of that one axis
 * about the opposite side), or the rotate handle (rotate about the canvas
 * center). Only active with the select tool on the currently selected
 * underlay; the manipulation itself never touches the Sketch model or the
 * undo stack, matching the rest of the underlay's display-only state.
 */
interface UnderlayDragState {
  id: string;
  kind: UnderlayHandleKind;
  startCursorMm: MmPoint;
  startUnderlay: CanvasUnderlay;
}
const underlayDrag = ref<UnderlayDragState | null>(null);

/** Smallest allowed magnitude for a manipulator-computed scale factor or
 * axis scale, so a corner or side dragged onto its anchor cannot collapse
 * the underlay to (or through) zero size. */
const MIN_UNDERLAY_SCALE_FACTOR = 0.001;

const UNDERLAY_CORNER_SIGN: Record<'cornerTL' | 'cornerTR' | 'cornerBR' | 'cornerBL', MmPoint> = {
  cornerTL: { x: -1, y: -1 },
  cornerTR: { x: 1, y: -1 },
  cornerBR: { x: 1, y: 1 },
  cornerBL: { x: -1, y: 1 },
};
const UNDERLAY_EDGE_AXIS: Record<'edgeL' | 'edgeR' | 'edgeT' | 'edgeB', { axis: 'x' | 'y'; sign: number }> = {
  edgeL: { axis: 'x', sign: -1 },
  edgeR: { axis: 'x', sign: 1 },
  edgeT: { axis: 'y', sign: -1 },
  edgeB: { axis: 'y', sign: 1 },
};

/** Recomputes the underlay's center so `anchorLocal` (a fixed point in the
 * *original* local frame) lands back on `anchorWorld` under the new scale,
 * i.e. the anchor stays pinned while the opposite handle moves with the
 * cursor. Shared by the corner and side scale handlers. */
function repositionAboutAnchor(
  s: CanvasUnderlay,
  anchorLocal: MmPoint,
  anchorWorld: MmPoint,
  newScaleX: number,
  newScaleY: number,
): MmPoint {
  const rad = (s.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ax = anchorLocal.x * newScaleX;
  const ay = anchorLocal.y * newScaleY;
  return { x: anchorWorld.x - (ax * cos - ay * sin), y: anchorWorld.y - (ax * sin + ay * cos) };
}

/** Corner handle: uniform scale about the opposite corner. The scale factor
 * is the ratio of the cursor's distance from that fixed corner to the
 * original corner-to-corner distance, applied equally to both axes so the
 * image never distorts, then the center is repositioned to keep the anchor
 * corner exactly fixed in world space. */
function applyUnderlayCornerDrag(
  id: string,
  s: CanvasUnderlay,
  kind: 'cornerTL' | 'cornerTR' | 'cornerBR' | 'cornerBL',
  cursor: MmPoint,
): void {
  const hw = s.naturalWidthPx / 2;
  const hh = s.naturalHeightPx / 2;
  const sign = UNDERLAY_CORNER_SIGN[kind];
  const draggedLocal = { x: sign.x * hw, y: sign.y * hh };
  const anchorLocal = { x: -draggedLocal.x, y: -draggedLocal.y };
  const anchorWorld = underlayLocalToWorld(s, anchorLocal);
  const draggedWorld = underlayLocalToWorld(s, draggedLocal);
  const oldDist = Math.hypot(draggedWorld.x - anchorWorld.x, draggedWorld.y - anchorWorld.y) || 1e-9;
  const newDist = Math.hypot(cursor.x - anchorWorld.x, cursor.y - anchorWorld.y);
  // Clamped away from zero: a corner dragged exactly onto its anchor would
  // otherwise collapse the underlay to zero size and strand it there, since
  // a zero scale has no distance left to drag back out from.
  const factor = Math.max(newDist / oldDist, MIN_UNDERLAY_SCALE_FACTOR);
  const newScaleX = s.scaleX * factor;
  const newScaleY = s.scaleY * factor;
  const newCenter = repositionAboutAnchor(s, anchorLocal, anchorWorld, newScaleX, newScaleY);
  editor.setUnderlayScale(id, newScaleX, newScaleY);
  editor.setUnderlayPosition(id, newCenter.x, newCenter.y);
}

/** Side handle: non-uniform scale of just that one axis, about the opposite
 * side (which stays fixed in world space), the other axis untouched. */
function applyUnderlayEdgeDrag(
  id: string,
  s: CanvasUnderlay,
  kind: 'edgeL' | 'edgeR' | 'edgeT' | 'edgeB',
  cursor: MmPoint,
): void {
  const hw = s.naturalWidthPx / 2;
  const hh = s.naturalHeightPx / 2;
  const { axis, sign } = UNDERLAY_EDGE_AXIS[kind];
  const draggedLocal = axis === 'x' ? { x: sign * hw, y: 0 } : { x: 0, y: sign * hh };
  const anchorLocal = { x: -draggedLocal.x, y: -draggedLocal.y };
  const anchorWorld = underlayLocalToWorld(s, anchorLocal);
  const rotatedLocalOffset = underlayWorldToRotatedLocal(s, cursor);
  const anchorRotatedLocalOffset = underlayWorldToRotatedLocal(s, anchorWorld);
  let newScaleX = s.scaleX;
  let newScaleY = s.scaleY;
  if (axis === 'x') {
    const raw = (rotatedLocalOffset.x - anchorRotatedLocalOffset.x) / (draggedLocal.x - anchorLocal.x);
    // Clamped away from zero for the same reason the corner drag's factor
    // is: a side dragged onto its anchor must not collapse that axis to
    // zero and strand it there.
    newScaleX = Math.abs(raw) >= MIN_UNDERLAY_SCALE_FACTOR ? raw : Math.sign(raw || s.scaleX) * MIN_UNDERLAY_SCALE_FACTOR;
  } else {
    const raw = (rotatedLocalOffset.y - anchorRotatedLocalOffset.y) / (draggedLocal.y - anchorLocal.y);
    newScaleY = Math.abs(raw) >= MIN_UNDERLAY_SCALE_FACTOR ? raw : Math.sign(raw || s.scaleY) * MIN_UNDERLAY_SCALE_FACTOR;
  }
  const newCenter = repositionAboutAnchor(s, anchorLocal, anchorWorld, newScaleX, newScaleY);
  editor.setUnderlayScale(id, newScaleX, newScaleY);
  editor.setUnderlayPosition(id, newCenter.x, newCenter.y);
}

/** Applies the in-progress manipulator drag for the current cursor position.
 * One exhaustive switch over UnderlayHandleKind (assertNever guards a handle
 * kind added later without a case here). */
function applyUnderlayDrag(drag: UnderlayDragState, cursor: MmPoint): void {
  const s = drag.startUnderlay;
  switch (drag.kind) {
    case 'moveBody': {
      const dx = cursor.x - drag.startCursorMm.x;
      const dy = cursor.y - drag.startCursorMm.y;
      editor.setUnderlayPosition(drag.id, s.xMm + dx, s.yMm + dy);
      return;
    }
    case 'rotate': {
      const center = { x: s.xMm, y: s.yMm };
      const a0 = Math.atan2(drag.startCursorMm.y - center.y, drag.startCursorMm.x - center.x);
      const a1 = Math.atan2(cursor.y - center.y, cursor.x - center.x);
      editor.setUnderlayRotationDeg(drag.id, s.rotationDeg + ((a1 - a0) * 180) / Math.PI);
      return;
    }
    case 'cornerTL':
    case 'cornerTR':
    case 'cornerBR':
    case 'cornerBL':
      applyUnderlayCornerDrag(drag.id, s, drag.kind, cursor);
      return;
    case 'edgeL':
    case 'edgeR':
    case 'edgeT':
    case 'edgeB':
      applyUnderlayEdgeDrag(drag.id, s, drag.kind, cursor);
      return;
    default:
      assertNever(drag.kind);
  }
}

/**
 * Starts a manipulator drag on a handle. Both this and onUnderlayBodyPointerDown
 * below no-op while the Calibrate action is armed or its inline input is
 * open: Calibrate's own two clicks must reach the canvas's plain pointerdown
 * handler (which routes to addCalibrateClick), not be swallowed here as a
 * manipulator gesture. underlayPointerEvents (below) already turns off
 * pointer-events on the underlay's whole group in that state so this guard
 * is belt-and-suspenders, kept because a handle can render on top of the
 * group in edge cases (e.g. mid-drag) where the CSS gate alone would not
 * cover it.
 */
function onUnderlayHandlePointerDown(event: PointerEvent, id: string, kind: UnderlayHandleKind): void {
  const u = underlayById(id);
  if (u === null || editor.activeTool !== 'select') return;
  if (editor.calibrating !== null || editor.calibrateDraft !== null) return;
  if (event.button !== 0) return;
  event.stopPropagation();
  underlayDrag.value = { id, kind, startCursorMm: clientToMm(event), startUnderlay: { ...u } };
  svgEl.value?.setPointerCapture(event.pointerId);
}
/**
 * Starts a body-move drag and selects the clicked underlay, unless the
 * pointerdown actually lands within an existing sketch point's pick radius:
 * a point dragged over an underlay must still start the point drag (the
 * documented hit-tolerance design in onPointerDown), so this defers by
 * returning without stopping propagation whenever hitPoint finds one,
 * letting the event bubble to the canvas root's own pointerdown handler.
 */
function onUnderlayBodyPointerDown(event: PointerEvent, id: string): void {
  if (underlayById(id) === null || editor.activeTool !== 'select') return;
  if (editor.calibrating !== null || editor.calibrateDraft !== null) return;
  if (event.button !== 0) return;
  if (hitPoint(clientToMm(event)) !== null) return;
  editor.selectUnderlay(id);
  onUnderlayHandlePointerDown(event, id, 'moveBody');
}

/** Finds an underlay by id among the current underlays, or null. */
function underlayById(id: string): CanvasUnderlay | null {
  return underlays.value.find((u) => u.id === id) ?? null;
}

/** Screen-px offset of the corner and side handle markers, and the rotate
 * handle's further offset beyond the top-right corner. */
const UNDERLAY_HANDLE_HIT_PX = 10;
const UNDERLAY_ROTATE_OFFSET_PX = 26;

interface UnderlayHandle { kind: UnderlayHandleKind; at: MmPoint; }

/** The selected underlay's manipulator handles in current sketch mm; []
 * when nothing is selected, a placement tool is active, or the Calibrate
 * action is in progress (the underlay is not click-targetable for
 * manipulation outside plain select-tool use). */
const underlayHandles = computed<UnderlayHandle[]>(() => {
  const u = selectedUnderlayId.value === null ? null : underlayById(selectedUnderlayId.value);
  if (
    u === null ||
    activeTool.value !== 'select' ||
    editor.calibrating !== null ||
    editor.calibrateDraft !== null
  ) {
    return [];
  }
  const hw = u.naturalWidthPx / 2;
  const hh = u.naturalHeightPx / 2;
  const corners: { kind: UnderlayHandleKind; local: MmPoint }[] = [
    { kind: 'cornerTL', local: { x: -hw, y: -hh } },
    { kind: 'cornerTR', local: { x: hw, y: -hh } },
    { kind: 'cornerBR', local: { x: hw, y: hh } },
    { kind: 'cornerBL', local: { x: -hw, y: hh } },
  ];
  const edges: { kind: UnderlayHandleKind; local: MmPoint }[] = [
    { kind: 'edgeL', local: { x: -hw, y: 0 } },
    { kind: 'edgeR', local: { x: hw, y: 0 } },
    { kind: 'edgeT', local: { x: 0, y: -hh } },
    { kind: 'edgeB', local: { x: 0, y: hh } },
  ];
  const handles: UnderlayHandle[] = [...corners, ...edges].map((h) => ({
    kind: h.kind,
    at: underlayLocalToWorld(u, h.local),
  }));
  const rotateOffsetMm = mmPerScreenPixel() * UNDERLAY_ROTATE_OFFSET_PX;
  const rad = (u.rotationDeg * Math.PI) / 180;
  const dirX = Math.cos(rad) - Math.sin(rad);
  const dirY = Math.sin(rad) + Math.cos(rad);
  const dirLen = Math.hypot(dirX, dirY) || 1;
  const trCorner = underlayLocalToWorld(u, { x: hw, y: -hh });
  handles.push({
    kind: 'rotate',
    at: {
      x: trCorner.x + (dirX / dirLen) * rotateOffsetMm,
      y: trCorner.y + (dirY / dirLen) * rotateOffsetMm,
    },
  });
  return handles;
});
const underlayHandleRadiusMm = computed(() => mmPerScreenPixel() * UNDERLAY_HANDLE_HIT_PX);

/** The resize cursor for a manipulator handle: diagonal for a corner,
 * left-right for the left/right side handles, up-down for the top/bottom
 * side handles, grab for the rotate handle. One exhaustive switch
 * (assertNever guards a handle kind added later without a cursor here). */
function underlayHandleCursor(kind: UnderlayHandleKind): string {
  switch (kind) {
    case 'cornerTL':
    case 'cornerBR':
      return 'nwse-resize';
    case 'cornerTR':
    case 'cornerBL':
      return 'nesw-resize';
    case 'edgeL':
    case 'edgeR':
      return 'ew-resize';
    case 'edgeT':
    case 'edgeB':
      return 'ns-resize';
    case 'rotate':
      return 'grab';
    case 'moveBody':
      return 'move';
    default:
      return assertNever(kind);
  }
}

/** The underlay's SVG group transform attribute: scale, then rotate, then
 * translate, matching underlayLocalToWorld's math exactly. */
function underlayTransformAttr(u: CanvasUnderlay): string {
  return `translate(${u.xMm} ${u.yMm}) rotate(${u.rotationDeg}) scale(${u.scaleX} ${u.scaleY})`;
}

/**
 * Whether the underlay picks up pointer events at all: never while a
 * placement tool is active (same pointer-events discipline as the region
 * fills, so drawing clicks fall through to the canvas instead of landing on
 * the photo), and never while the Calibrate action is armed or its inline
 * input is open, so Calibrate's own two clicks reach the canvas's plain
 * pointerdown handler instead of starting a manipulator drag.
 */
const underlayPointerEvents = computed(() =>
  activeTool.value === 'select' && editor.calibrating === null && editor.calibrateDraft === null
    ? 'auto'
    : 'none',
);

function onCalibrateInputBlur(): void {
  if (calibrateDraft.value === null) return;
  if (parseDimensionValue(calibrateDraft.value.text) !== null) {
    editor.commitCalibrateDraft();
  } else {
    editor.cancelCalibrateUnderlay();
  }
}

/** The calibrate action's inline value input screen position: the second
 * clicked point, converted the same way the dimension draft input is. */
const calibrateDraftScreenPos = computed<{ x: number; y: number } | null>(() => {
  void view.value;
  if (calibrateDraft.value === null || calibrateClicks.value.length !== 2) return null;
  return mmToScreenPx(calibrateClicks.value[1]);
});

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
    editor.deselectUnderlay();
  }
  emit('canvasClick', at, hit, event.altKey, isEntityTarget(event.target));
}

function onPointerMove(event: PointerEvent): void {
  if (panDrag !== null) {
    const vpx = eventToVirtualPx(event);
    setPan(panDrag.panX + (vpx.x - panDrag.startX), panDrag.panY + (vpx.y - panDrag.startY));
    return;
  }
  if (underlayDrag.value !== null) {
    applyUnderlayDrag(underlayDrag.value, clientToMm(event));
    return;
  }
  cursorMm.value = clientToMm(event);
  altHeld.value = event.altKey;
  if (pendingLabelId.value !== null && pendingLabelDownScreen.value !== null) {
    const dx = event.clientX - pendingLabelDownScreen.value.x;
    const dy = event.clientY - pendingLabelDownScreen.value.y;
    if (Math.hypot(dx, dy) * mmPerScreenPixel() <= dragThresholdMm()) return;
    draggingLabelId.value = pendingLabelId.value;
    pendingLabelId.value = null;
    pendingLabelDownScreen.value = null;
    editor.beginLabelDrag();
  }
  if (draggingLabelId.value !== null) {
    const anchor = dimensionAnchorById(draggingLabelId.value);
    if (anchor !== null) {
      editor.updateLabelOffset(draggingLabelId.value, {
        x: cursorMm.value.x - anchor.x,
        y: cursorMm.value.y - anchor.y,
      });
    }
    return;
  }
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

function endUnderlayDrag(event: PointerEvent): void {
  underlayDrag.value = null;
  try {
    svgEl.value?.releasePointerCapture(event.pointerId);
  } catch {
    // No capture to release; nothing to do.
  }
}

function onPointerUp(event: PointerEvent): void {
  if (endPan(event)) return;
  if (underlayDrag.value !== null) {
    endUnderlayDrag(event);
    return;
  }
  if (pendingLabelId.value !== null) {
    // A plain click on the label with no drag: does nothing on its own
    // (double-click, handled separately, reopens the inline input).
    pendingLabelId.value = null;
    pendingLabelDownScreen.value = null;
    return;
  }
  if (draggingLabelId.value !== null) {
    draggingLabelId.value = null;
    editor.endLabelDrag();
    return;
  }
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
  if (underlayDrag.value !== null) {
    endUnderlayDrag(event);
    return;
  }
  if (pendingLabelId.value !== null) {
    pendingLabelId.value = null;
    pendingLabelDownScreen.value = null;
    return;
  }
  if (draggingLabelId.value !== null) {
    draggingLabelId.value = null;
    editor.endLabelDrag();
    return;
  }
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

/** The dimension-kind subset of the sketch's constraints. */
function dimensionOf(c: (typeof sketch.value.constraints)[number]): SketchDimension | null {
  switch (c.kind) {
    case 'length':
    case 'distance':
    case 'radius':
    case 'diameter':
    case 'angle':
    case 'pointLineDistance':
      return c;
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
}

/** The pre-formatted label text for a dimension: R/D prefix for radius and
 * diameter, degree suffix for angle, mm suffix otherwise. Single source
 * (convention 10) for both the committed labels and the ghost preview. A
 * driven (reference) dimension's value is wrapped in parentheses, matching
 * convention/spec: "(25.00 mm)" reads as reported rather than enforced. */
function dimensionText(dimension: SketchDimension): string {
  const value = ((): string => {
    switch (dimension.kind) {
      case 'length':
      case 'distance':
      case 'pointLineDistance':
        return `${formatMm(dimension.mm)} mm`;
      case 'radius':
        return `R ${formatMm(dimension.mm)} mm`;
      case 'diameter':
        return `D ${formatMm(dimension.mm)} mm`;
      case 'angle':
        return `${formatDegrees(dimension.degrees)} deg`;
      default:
        return assertNever(dimension);
    }
  })();
  return dimension.driven === true ? `(${value})` : value;
}

interface DimensionRender {
  key: string;
  /** null for the placement ghost preview: not a real, editable dimension. */
  constraintId: string | null;
  graphics: DimensionGraphics;
  opacity: number;
  /** True for a driven (reference) dimension, which renders in a distinct
   * muted color rather than the ordinary driving-dimension ink. */
  driven: boolean;
}

/** Graphics for every committed dimension, at its stored (or default)
 * label position. */
const dimensionRenders = computed<DimensionRender[]>(() => {
  const renders: DimensionRender[] = [];
  for (const c of sketch.value.constraints) {
    const dimension = dimensionOf(c);
    if (dimension === null) continue;
    const anchor = dimensionAnchor(sketch.value, dimension);
    const offset = dimension.labelOffset ?? DEFAULT_LABEL_OFFSET;
    const labelAt = { x: anchor.x + offset.x, y: anchor.y + offset.y };
    const graphics = dimensionGraphics(sketch.value, dimension, labelAt, dimensionText(dimension));
    if (graphics === null) continue;
    renders.push({
      key: dimension.id,
      constraintId: dimension.id,
      graphics,
      opacity: 1,
      driven: dimension.driven === true,
    });
  }
  return renders;
});

/** Muted text/line color for a driven (reference) dimension; the ordinary
 * dark ink otherwise. */
function dimensionInkColor(driven: boolean): string {
  return driven ? '#90a4ae' : '#263238';
}

/** The dimension tool's placement ghost: a reduced-opacity preview of the
 * dimension the current resolved selection would produce, following the
 * cursor until the placement click. Reuses dimensionGraphics exactly like
 * the committed renderer, so the preview never promises a shape the commit
 * would not actually draw (convention 10). */
const dimensionGhost = computed<DimensionRender | null>(() => {
  if (dimensionPending.value === null || cursorMm.value === null) return null;
  const resolved = dimensionPending.value;
  let fake: SketchDimension;
  switch (resolved.kind) {
    case 'length':
      fake = {
        kind: 'length', id: '_ghost', lineId: resolved.lineId,
        mm: formatMm(measureLineLength(sketch.value, resolved.lineId)),
      };
      break;
    case 'distance': {
      const axis = pickDistanceAxis(sketch.value, resolved.p1Id, resolved.p2Id, cursorMm.value);
      fake = {
        kind: 'distance', id: '_ghost', p1Id: resolved.p1Id, p2Id: resolved.p2Id, axis,
        mm: formatMm(
          axis === undefined
            ? measurePointDistance(sketch.value, resolved.p1Id, resolved.p2Id)
            : measurePointAxisDistance(sketch.value, resolved.p1Id, resolved.p2Id, axis),
        ),
      };
      break;
    }
    case 'radiusOrDiameter':
      fake = {
        kind: 'radius', id: '_ghost', entityId: resolved.entityId,
        mm: formatMm(measureRadius(sketch.value, resolved.entityId)),
      };
      break;
    case 'angle':
      fake = {
        kind: 'angle', id: '_ghost', l1Id: resolved.l1Id, l2Id: resolved.l2Id,
        degrees: formatDegrees(
          resolveAngleAtCursor(sketch.value, resolved.l1Id, resolved.l2Id, cursorMm.value).degrees,
        ),
      };
      break;
    case 'pointLineDistance':
      fake = {
        kind: 'pointLineDistance', id: '_ghost', pointId: resolved.pointId, lineId: resolved.lineId,
        mm: formatMm(measurePointLineDistance(sketch.value, resolved.pointId, resolved.lineId)),
      };
      break;
    default:
      return assertNever(resolved);
  }
  const graphics = dimensionGraphics(sketch.value, fake, cursorMm.value, dimensionText(fake));
  if (graphics === null) return null;
  return { key: '_ghost', constraintId: null, graphics, opacity: 0.45, driven: false };
});

const allDimensionRenders = computed<DimensionRender[]>(() => {
  const list = [...dimensionRenders.value];
  if (dimensionGhost.value !== null) list.push(dimensionGhost.value);
  return list;
});

/** Screen-px sized arrowhead: a small filled triangle, tip at the origin,
 * pointing along +x in local coordinates before the caller's rotate. */
const arrowSizeMm = computed(() => {
  void view.value;
  return mmPerScreenPixel();
});
function arrowPathD(): string {
  const len = arrowSizeMm.value * 9;
  const half = arrowSizeMm.value * 3;
  return `M 0 0 L ${-len} ${-half} L ${-len} ${half} Z`;
}

/** True while `constraintId` names a dimension label being dragged, for the
 * committed vs. ghost pointer-events distinction. */
const draggingLabelId = ref<string | null>(null);
const pendingLabelId = ref<string | null>(null);
const pendingLabelDownScreen = ref<{ x: number; y: number } | null>(null);

function onLabelPointerDown(event: PointerEvent, constraintId: string): void {
  event.stopPropagation();
  pendingLabelId.value = constraintId;
  pendingLabelDownScreen.value = { x: event.clientX, y: event.clientY };
  (event.target as Element).setPointerCapture(event.pointerId);
}

/** Reopens the inline input on an existing dimension's label. */
function onLabelDblClick(event: MouseEvent, constraintId: string): void {
  event.stopPropagation();
  editor.openDimensionDraftForEdit(constraintId);
}

/** The mm point a dimension's labelOffset is measured from, for updating it
 * mid-drag; null when the constraint no longer resolves to a dimension. */
function dimensionAnchorById(constraintId: string): MmPoint | null {
  const c = sketch.value.constraints.find((x) => x.id === constraintId);
  const dimension = c === undefined ? null : dimensionOf(c);
  return dimension === null ? null : dimensionAnchor(sketch.value, dimension);
}

/** The inline dimension entry field's on-screen position: the draft's
 * anchor (from its pending selection, or its already-committed constraint)
 * plus its labelOffset, converted to client-relative pixels the same way
 * mmToScreenPx does. Recomputed on pan/zoom via view.value. */
const draftInputEl = ref<HTMLInputElement | null>(null);
/** Focuses and fully selects the inline input's text whenever a draft opens,
 * so Enter without editing commits the pre-filled measured value and typing
 * immediately replaces it, per the spec's "text pre-selected". */
watch(
  () => dimensionDraft.value !== null,
  (open) => {
    if (!open) return;
    void nextTick(() => {
      draftInputEl.value?.focus();
      draftInputEl.value?.select();
    });
  },
);

/** Commits the draft on Enter; a failed parse leaves the input open with the
 * store's error message shown (dimensionDraftError), same convention as the
 * rest of the app's numeric-entry fields. */
function onDraftEnter(): void {
  if (editor.commitDimensionDraft()) emit('requestSolve');
}
/** Blur commits a parseable value, same as Enter; an unparseable value on
 * blur cancels instead of leaving the field stuck open (Escape is the
 * deliberate cancel gesture; blur is not, so it should not strand an
 * invisible error message the user can no longer see). */
function onDraftBlur(): void {
  if (dimensionDraft.value === null) return;
  if (editor.commitDimensionDraft()) {
    emit('requestSolve');
  } else {
    editor.cancelDimensionDraft();
  }
}

/** The radius/diameter toggle beside the inline input. */
function onDraftToggleRadiusDiameter(kind: 'radius' | 'diameter'): void {
  const wasCommitted = dimensionDraft.value?.constraintId !== null;
  editor.toggleDraftRadiusDiameter(kind);
  if (wasCommitted) emit('requestSolve');
}

const draftScreenPos = computed<{ x: number; y: number } | null>(() => {
  void view.value;
  const draft = dimensionDraft.value;
  if (draft === null) return null;
  const anchor =
    draft.pending !== null
      ? anchorForDimensionSelection(sketch.value, draft.pending)
      : dimensionAnchorById(draft.constraintId ?? '');
  if (anchor === null) return null;
  const at = { x: anchor.x + draft.labelOffset.x, y: anchor.y + draft.labelOffset.y };
  return mmToScreenPx(at);
});

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
  <div class="sketch-canvas-wrapper">
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
    <g
      v-for="u in underlays"
      :key="u.id"
      :transform="underlayTransformAttr(u)"
      :style="{ pointerEvents: underlayPointerEvents }"
    >
      <image
        :href="u.url"
        :x="-u.naturalWidthPx / 2"
        :y="-u.naturalHeightPx / 2"
        :width="u.naturalWidthPx"
        :height="u.naturalHeightPx"
        :opacity="u.opacityPct / 100"
        style="cursor: move"
        @pointerdown="onUnderlayBodyPointerDown($event, u.id)"
      />
    </g>
    <g v-if="underlayHandles.length > 0 && selectedUnderlayId !== null" class="underlay-manipulator">
      <rect
        v-for="h in underlayHandles.filter((x) => x.kind !== 'rotate')"
        :key="h.kind"
        :x="h.at.x - underlayHandleRadiusMm / 2"
        :y="h.at.y - underlayHandleRadiusMm / 2"
        :width="underlayHandleRadiusMm"
        :height="underlayHandleRadiusMm"
        fill="#90a4ae"
        stroke="#455a64"
        :stroke-width="mmPerScreenPixel() * 1"
        :style="{ cursor: underlayHandleCursor(h.kind) }"
        @pointerdown="onUnderlayHandlePointerDown($event, selectedUnderlayId!, h.kind)"
      />
      <circle
        v-for="h in underlayHandles.filter((x) => x.kind === 'rotate')"
        :key="h.kind"
        :cx="h.at.x"
        :cy="h.at.y"
        :r="underlayHandleRadiusMm / 2"
        fill="#90a4ae"
        stroke="#455a64"
        :stroke-width="mmPerScreenPixel() * 1"
        :style="{ cursor: underlayHandleCursor(h.kind) }"
        @pointerdown="onUnderlayHandlePointerDown($event, selectedUnderlayId!, h.kind)"
      />
    </g>
    <g v-if="calibrating && calibrateClicks.length > 0" style="pointer-events: none">
      <circle
        v-for="(c, i) in calibrateClicks"
        :key="i"
        :cx="c.x"
        :cy="c.y"
        :r="mmPerScreenPixel() * 4"
        fill="#ff6f00"
      />
      <line
        v-if="calibrateClicks.length === 2"
        :x1="calibrateClicks[0].x" :y1="calibrateClicks[0].y"
        :x2="calibrateClicks[1].x" :y2="calibrateClicks[1].y"
        stroke="#ff6f00" :stroke-width="mmPerScreenPixel() * 0.8"
      />
    </g>
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
    <g class="regions" :style="{ pointerEvents: editor.activeTool === 'select' ? 'auto' : 'none' }">
      <path
        v-for="r in regionPaths"
        :key="r.id"
        :d="r.d"
        fill-rule="evenodd"
        :fill="regionFill(r.id)"
        :fill-opacity="regionOpacity(r.id)"
        stroke="none"
        style="cursor: pointer"
        @click.stop="editor.toggleRegionSelection(r.id)"
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
      <g
        v-for="render in allDimensionRenders"
        :key="render.key"
        :opacity="render.opacity"
        style="pointer-events: none"
      >
        <template v-if="render.graphics.kind === 'linear'">
          <line
            v-for="(w, i) in render.graphics.witnessLines"
            :key="`w${i}`"
            :x1="w.a.x" :y1="w.a.y" :x2="w.b.x" :y2="w.b.y"
            stroke="#607d8b" stroke-width="0.25"
          />
          <line
            :x1="render.graphics.dimensionLine.a.x" :y1="render.graphics.dimensionLine.a.y"
            :x2="render.graphics.dimensionLine.b.x" :y2="render.graphics.dimensionLine.b.y"
            stroke="#455a64" stroke-width="0.3"
          />
        </template>
        <template v-else-if="render.graphics.kind === 'angle'">
          <line
            v-for="(w, i) in render.graphics.witnessLines"
            :key="`w${i}`"
            :x1="w.a.x" :y1="w.a.y" :x2="w.b.x" :y2="w.b.y"
            stroke="#607d8b" stroke-width="0.25"
          />
          <path
            :d="render.graphics.arcPath"
            fill="none" stroke="#455a64" stroke-width="0.3"
          />
        </template>
        <line
          v-else-if="render.graphics.kind === 'leader'"
          :x1="render.graphics.leaderLine.a.x" :y1="render.graphics.leaderLine.a.y"
          :x2="render.graphics.leaderLine.b.x" :y2="render.graphics.leaderLine.b.y"
          stroke="#455a64" stroke-width="0.3"
        />
        <path
          v-for="(arrow, i) in render.graphics.arrowheads"
          :key="`a${i}`"
          :d="arrowPathD()"
          fill="#455a64"
          :transform="`translate(${arrow.at.x} ${arrow.at.y}) rotate(${arrow.angleDeg})`"
        />
        <text
          :x="render.graphics.textAt.x"
          :y="render.graphics.textAt.y"
          font-size="3"
          text-anchor="middle"
          dominant-baseline="central"
          :fill="dimensionInkColor(render.driven)"
          :style="render.constraintId !== null ? 'pointer-events: auto; cursor: move;' : undefined"
          @pointerdown="render.constraintId !== null && onLabelPointerDown($event, render.constraintId)"
          @dblclick="render.constraintId !== null && onLabelDblClick($event, render.constraintId)"
        >{{ render.graphics.text }}</text>
      </g>
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
  <div
    v-if="dimensionDraft !== null && draftScreenPos !== null"
    class="dimension-draft-overlay"
    :style="{ left: `${draftScreenPos.x}px`, top: `${draftScreenPos.y}px` }"
  >
    <input
      ref="draftInputEl"
      v-model="dimensionDraft.text"
      class="dimension-draft-input"
      :class="{ 'dimension-draft-input--error': dimensionDraftError !== null }"
      type="text"
      inputmode="decimal"
      @keyup.enter="onDraftEnter"
      @keyup.esc="editor.cancelDimensionDraft()"
      @blur="onDraftBlur"
    />
    <div v-if="dimensionDraftError !== null" class="dimension-draft-error">{{ dimensionDraftError }}</div>
    <div v-if="dimensionDraft.radiusToggle !== null" class="dimension-draft-toggle">
      <button
        type="button"
        :class="{ active: dimensionDraft.radiusToggle.kind === 'radius' }"
        @mousedown.prevent
        @click="onDraftToggleRadiusDiameter('radius')"
      >Radius</button>
      <button
        type="button"
        :class="{ active: dimensionDraft.radiusToggle.kind === 'diameter' }"
        @mousedown.prevent
        @click="onDraftToggleRadiusDiameter('diameter')"
      >Diameter</button>
    </div>
  </div>
  <div
    v-if="calibrateDraft !== null && calibrateDraftScreenPos !== null"
    class="dimension-draft-overlay"
    :style="{ left: `${calibrateDraftScreenPos.x}px`, top: `${calibrateDraftScreenPos.y}px` }"
  >
    <input
      v-model="calibrateDraft.text"
      class="dimension-draft-input"
      :class="{ 'dimension-draft-input--error': calibrateDraftError !== null }"
      type="text"
      inputmode="decimal"
      autofocus
      placeholder="Real distance in mm"
      @keyup.enter="editor.commitCalibrateDraft()"
      @keyup.esc="editor.cancelCalibrateUnderlay()"
      @blur="onCalibrateInputBlur"
    />
    <div v-if="calibrateDraftError !== null" class="dimension-draft-error">{{ calibrateDraftError }}</div>
  </div>
  </div>
</template>

<style scoped>
.sketch-canvas-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}
.sketch-canvas {
  width: 100%;
  height: 100%;
  touch-action: none;
  background: #fafafa;
}

svg text {
  user-select: none;
  -webkit-user-select: none;
}

/* Space is held to pan; show the grab cursor, grabbing while dragging,
   matching TraceCanvas's convention. */
.cursor-grab {
  cursor: grab;
}
.cursor-grabbing {
  cursor: grabbing;
}

/* The dimension tool's inline entry field: absolutely positioned over the
   canvas at the dimension label's screen position (draftScreenPos), rather
   than the old under-toolbar field. */
.dimension-draft-overlay {
  position: absolute;
  transform: translate(-50%, -50%);
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.dimension-draft-input {
  width: 84px;
  padding: 2px 6px;
  font-size: 0.8rem;
  text-align: center;
  border: 1px solid #90a4ae;
  border-radius: 3px;
  background: #ffffff;
  color: #263238;
}
.dimension-draft-input--error {
  border-color: #e53935;
}
.dimension-draft-error {
  font-size: 0.7rem;
  color: #e53935;
  background: #ffffff;
  padding: 0 2px;
  border-radius: 2px;
}
.dimension-draft-toggle {
  display: flex;
  gap: 2px;
}
.dimension-draft-toggle button {
  font-size: 0.7rem;
  padding: 1px 6px;
  border: 1px solid #90a4ae;
  border-radius: 3px;
  background: #ffffff;
  color: #455a64;
  cursor: pointer;
}
.dimension-draft-toggle button.active {
  background: #455a64;
  color: #ffffff;
}
</style>
