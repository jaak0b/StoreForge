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

const emit = defineEmits<{
  /** A canvas click in mm, for the active drawing tool. */
  (e: 'canvasClick', at: MmPoint, hitPointId: string | null): void;
  /** A drag of an existing point to a new mm position (driven point). */
  (e: 'pointDrag', pointId: string, at: MmPoint): void;
  (e: 'pointDragEnd'): void;
  /** A click on a dimension label, for click-to-edit. */
  (e: 'dimensionClick', constraintId: string, at: MmPoint): void;
  (e: 'entityClick', entityId: string): void;
}>();

const editor = useSketchEditor();
const { sketch, solveState, selectedIds, underlayUrl, underlayOpacityPct, underlayMmPerPixel } =
  storeToRefs(editor);

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

function onPointerDown(event: PointerEvent): void {
  const at = clientToMm(event);
  const hit = hitPoint(at);
  if (editor.activeTool === 'select' && hit !== null) {
    draggingPointId.value = hit;
    (event.target as Element).setPointerCapture(event.pointerId);
    return;
  }
  emit('canvasClick', at, hit);
}

function onPointerMove(event: PointerEvent): void {
  if (draggingPointId.value === null) return;
  emit('pointDrag', draggingPointId.value, clientToMm(event));
}

function onPointerUp(): void {
  if (draggingPointId.value !== null) {
    draggingPointId.value = null;
    emit('pointDragEnd');
  }
}

/** The point id within a 2 mm (screen-scaled) pick radius, or null. */
function hitPoint(at: MmPoint): string | null {
  const radius = 2 / view.value.zoom;
  for (const p of points.value) {
    if (Math.hypot(p.x - at.x, p.y - at.y) <= radius) return p.id;
  }
  return null;
}

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
      <path
        v-for="{ entity, d } in entityPaths"
        :key="entity.id"
        :d="d"
        fill="none"
        :stroke="strokeOf(entity)"
        :stroke-width="0.6"
        :stroke-dasharray="entity.construction ? '1.5 1' : undefined"
        @click.stop="emit('entityClick', entity.id)"
      />
      <circle
        v-for="p in points"
        :key="p.id"
        :cx="p.x"
        :cy="p.y"
        r="0.9"
        :fill="strokeOf(p)"
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
