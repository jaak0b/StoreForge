<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor } from '../../../stores/sketchEditor';
import {
  zoomToCursor,
  type ViewTransform,
} from '../viewTransform';
import { assertNever } from '../../../engine/plan/types';
import type { MmPoint } from '../../../engine/trace/types';
import type { SketchEntity } from '../../../engine/sketch/model';
import { constraintGlyphs } from '../../../engine/sketch/constraintGlyphs';

const emit = defineEmits<{
  /** A canvas click in mm, for the active drawing tool. */
  (e: 'canvasClick', at: MmPoint, hitPointId: string | null): void;
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
} = storeToRefs(editor);

const svgEl = ref<SVGSVGElement | null>(null);
/** Pan/zoom over a fixed 200 mm design window; same math as the trace canvas. */
const WINDOW_MM = 200;
const view = ref<ViewTransform>({ zoom: 1, panX: 0, panY: 0 });

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

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
  const anchorMm = clientToMm(event);
  const next = zoomToCursor(
    view.value,
    view.value.zoom * factor,
    { x: anchorMm.x * view.value.zoom + view.value.panX, y: anchorMm.y * view.value.zoom + view.value.panY },
    WINDOW_MM,
    WINDOW_MM,
  );
  view.value = next;
}

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
  if (selectedIds.value.includes(entity.id)) return '#ff9800';
  if (entity.kind !== 'point' && entity.construction) return '#9e9e9e';
  const state = solveState.value;
  if (state.status === 'conflicting' || state.status === 'failed') return '#e53935';
  if (state.status === 'solved' && state.dof === 0) return '#2e7d32';
  return '#1e88e5';
}

const draggingPointId = ref<string | null>(null);
/** Current cursor position in mm, for the open-chain rubber-band cue; null
 * once the pointer leaves the canvas. Display state only, never the model. */
const cursorMm = ref<MmPoint | null>(null);
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
  emit('canvasClick', at, hit);
}

function onPointerMove(event: PointerEvent): void {
  cursorMm.value = clientToMm(event);
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

function onPointerUp(): void {
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

function onPointerLeave(): void {
  cursorMm.value = null;
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
function onPointerCancel(): void {
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
 * shown only while a line or arc tool is active. */
const rubberBand = computed(() => {
  if (chainTailPoint.value === null || cursorMm.value === null) return null;
  if (!['line', 'arcThreePoint', 'arcTangent'].includes(activeTool.value)) return null;
  return { x1: chainTailPoint.value.x, y1: chainTailPoint.value.y, x2: cursorMm.value.x, y2: cursorMm.value.y };
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
          return { id: c.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${c.mm} mm` };
        }
        case 'distance': {
          const a = pointById.value.get(c.p1Id)!;
          const b = pointById.value.get(c.p2Id)!;
          return { id: c.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${c.mm} mm` };
        }
        case 'radius':
        case 'diameter': {
          const entity = sketch.value.entities.find((e) => e.id === c.entityId);
          if (entity === undefined || (entity.kind !== 'arc' && entity.kind !== 'circle')) return null;
          const center = pointById.value.get(entity.centerId)!;
          const prefix = c.kind === 'radius' ? 'R' : 'D';
          return { id: c.id, x: center.x, y: center.y, text: `${prefix} ${c.mm} mm` };
        }
        case 'angle': {
          const line = sketch.value.entities.find((e) => e.id === c.l1Id);
          if (line === undefined || line.kind !== 'line') return null;
          const a = pointById.value.get(line.p1Id)!;
          return { id: c.id, x: a.x, y: a.y, text: `${c.degrees} deg` };
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
  return constraintId === selectedConstraintId.value ? '#ff9800' : '#607d8b';
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

/**
 * Ready-to-draw glyph primitives for every constraint the sketch carries,
 * grouped by SVG shape so the template stays simple. Built by one exhaustive
 * switch over constraintGlyphs' kinds (assertNever guards new kinds), sized
 * in screen px via glyphMmPerPx so glyphs read the same size at any zoom.
 */
const glyphShapes = computed(() => {
  const parallelTicks: ParallelTickGlyph[] = [];
  const rightAngles: PerpendicularGlyph[] = [];
  const letters: LetterGlyph[] = [];
  const tangentDots: DotGlyph[] = [];
  const coincidentRings: DotGlyph[] = [];
  const symmetricMarks: SymmetricGlyph[] = [];
  const empty = { parallelTicks, rightAngles, letters, tangentDots, coincidentRings, symmetricMarks };
  if (!glyphsVisible.value) return empty;

  const scale = glyphMmPerPx.value;
  const tickLen = scale * 5;
  const tickGap = scale * 2.5;
  const rightAngleSize = scale * 6;
  const letterOffset = scale * 6;
  const dotR = scale * 2;
  const ringR = scale * 3.5;
  const arrowLen = scale * 6;

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
        break;
      }
      case 'horizontal':
        letters.push({ key: g.constraintId, constraintId: g.constraintId, x: g.at.x, y: g.at.y - letterOffset, text: 'H' });
        break;
      case 'vertical':
        letters.push({ key: g.constraintId, constraintId: g.constraintId, x: g.at.x, y: g.at.y - letterOffset, text: 'V' });
        break;
      case 'tangent':
        tangentDots.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: dotR });
        break;
      case 'coincident':
        coincidentRings.push({ key: g.constraintId, constraintId: g.constraintId, cx: g.at.x, cy: g.at.y, r: ringR });
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
        break;
      }
      default:
        assertNever(g);
    }
  }
  return { parallelTicks, rightAngles, letters, tangentDots, coincidentRings, symmetricMarks };
});

const glyphStrokeWidthMm = computed(() => glyphMmPerPx.value * 1.3);
const glyphFontSizeMm = computed(() => glyphMmPerPx.value * 9);
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
</style>
