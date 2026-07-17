<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import {
  AUTO_SIZE_MARGIN_MM,
  DEFAULT_FINGER_HOLE_DIAMETER_MM,
  useToolTrace,
} from '../../stores/toolTrace';
import { autoPocketGridSize } from '../../workerClient';
import { boundsOf, primitiveOutline, transformTool } from '../../engine/trace/edit';
import { binInteriorSizeMm } from '../../engine/gridfinity/constants';
import type { MmPoint, TracedTool } from '../../engine/trace/types';

/**
 * Step 3 of the Tool trace tab: a top-down layout of the bin interior with
 * draggable tools, per-tool editing controls, custom primitive shapes, and
 * the bin footprint (auto-sized until overridden).
 */

const store = useToolTrace();
const { tools, placements, selectedToolId, gridX, gridY, gridManual, defaultDepthMm } =
  storeToRefs(store);

const canvas = ref<HTMLCanvasElement | null>(null);
const errorMessage = ref<string | null>(null);
const fingerHoleMode = ref(false);
const fingerHoleDiameter = ref(DEFAULT_FINGER_HOLE_DIAMETER_MM);

const CANVAS_WIDTH = 520;
const CLEARANCE_CHOICES = [0, 0.5, 1.5, 3, 4.5];

const selectedTool = computed(() =>
  tools.value.find((tool) => tool.id === selectedToolId.value) ?? null,
);
const selectedPlacement = computed(() =>
  selectedToolId.value !== null ? store.placementOf(selectedToolId.value) ?? null : null,
);

// mm to canvas pixel mapping, bin centre at canvas centre.
function mmScale(): number {
  const interiorX = binInteriorSizeMm(gridX.value);
  const interiorY = binInteriorSizeMm(gridY.value);
  const pad = 20;
  return Math.min(
    (CANVAS_WIDTH - pad) / interiorX,
    ((CANVAS_WIDTH * interiorY) / interiorX - pad) / interiorY,
  );
}

function draw(): void {
  const el = canvas.value;
  if (!el) return;
  const interiorX = binInteriorSizeMm(gridX.value);
  const interiorY = binInteriorSizeMm(gridY.value);
  const s = mmScale();
  el.width = CANVAS_WIDTH;
  el.height = Math.round((CANVAS_WIDTH * interiorY) / interiorX);
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, el.width, el.height);
  const cx = el.width / 2;
  const cy = el.height / 2;
  const toPx = (p: MmPoint): [number, number] => [cx + p.x * s, cy + p.y * s];
  // Interior outline.
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - (interiorX / 2) * s, cy - (interiorY / 2) * s, interiorX * s, interiorY * s);
  // Tools.
  for (const tool of tools.value) {
    const placement = store.placementOf(tool.id);
    if (placement === undefined) continue;
    const outline = transformTool(tool.outline, tool.rotationDeg, tool.mirrored);
    const selected = tool.id === selectedToolId.value;
    ctx.strokeStyle = selected ? '#42a5f5' : 'rgba(255, 152, 0, 0.9)';
    ctx.fillStyle = selected ? 'rgba(66, 165, 245, 0.18)' : 'rgba(255, 152, 0, 0.12)';
    ctx.lineWidth = selected ? 2.5 : 1.5;
    for (const loop of [outline.outer, ...outline.holes]) {
      ctx.beginPath();
      loop.forEach((p, i) => {
        const [x, y] = toPx({ x: p.x + placement.xMm, y: p.y + placement.yMm });
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.beginPath();
    outline.outer.forEach((p, i) => {
      const [x, y] = toPx({ x: p.x + placement.xMm, y: p.y + placement.yMm });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    for (const hole of tool.fingerHoles) {
      const [x, y] = toPx({ x: hole.x + placement.xMm, y: hole.y + placement.yMm });
      ctx.beginPath();
      ctx.arc(x, y, (hole.diameterMm / 2) * s, 0, 2 * Math.PI);
      ctx.strokeStyle = '#9c27b0';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

watch(
  [tools, placements, gridX, gridY, selectedToolId],
  () => void nextTick(draw),
  { deep: true },
);
onMounted(() => void nextTick(draw));

// Auto footprint sizing, debounced, disabled once the user typed a size.
let autoSizeHandle: ReturnType<typeof setTimeout> | null = null;
watch(
  [tools, placements, gridManual],
  () => {
    if (gridManual.value || placements.value.length === 0) return;
    if (autoSizeHandle !== null) clearTimeout(autoSizeHandle);
    autoSizeHandle = setTimeout(async () => {
      autoSizeHandle = null;
      try {
        const size = await autoPocketGridSize(
          tools.value,
          placements.value,
          AUTO_SIZE_MARGIN_MM,
        );
        errorMessage.value = null;
        gridX.value = size.gridX;
        gridY.value = size.gridY;
      } catch (error) {
        errorMessage.value =
          error instanceof Error ? error.message : 'Sizing the bin failed.';
      }
    }, 300);
  },
  { deep: true, immediate: true },
);

// Dragging tools on the canvas.
let draggingToolId: string | null = null;
let dragStart: MmPoint | null = null;
let dragOrigin: MmPoint | null = null;

function canvasMm(event: PointerEvent | MouseEvent): MmPoint {
  const el = canvas.value!;
  const rect = el.getBoundingClientRect();
  const s = mmScale();
  return {
    x: (((event.clientX - rect.left) / rect.width) * el.width - el.width / 2) / s,
    y: (((event.clientY - rect.top) / rect.height) * el.height - el.height / 2) / s,
  };
}

function toolAt(p: MmPoint): TracedTool | null {
  // Last drawn wins, so iterate back to front.
  for (let i = tools.value.length - 1; i >= 0; i -= 1) {
    const tool = tools.value[i];
    const placement = store.placementOf(tool.id);
    if (placement === undefined) continue;
    const bounds = boundsOf(transformTool(tool.outline, tool.rotationDeg, tool.mirrored));
    if (
      p.x >= bounds.minX + placement.xMm &&
      p.x <= bounds.maxX + placement.xMm &&
      p.y >= bounds.minY + placement.yMm &&
      p.y <= bounds.maxY + placement.yMm
    ) {
      return tool;
    }
  }
  return null;
}

function onPointerDown(event: PointerEvent): void {
  const p = canvasMm(event);
  const tool = toolAt(p);
  if (fingerHoleMode.value) {
    if (tool !== null) {
      const placement = store.placementOf(tool.id)!;
      tool.fingerHoles.push({
        x: p.x - placement.xMm,
        y: p.y - placement.yMm,
        diameterMm: fingerHoleDiameter.value,
      });
      selectedToolId.value = tool.id;
    }
    return;
  }
  if (tool === null) {
    selectedToolId.value = null;
    return;
  }
  selectedToolId.value = tool.id;
  const placement = store.placementOf(tool.id)!;
  draggingToolId = tool.id;
  dragStart = p;
  dragOrigin = { x: placement.xMm, y: placement.yMm };
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (draggingToolId === null || dragStart === null || dragOrigin === null) return;
  const p = canvasMm(event);
  const placement = store.placementOf(draggingToolId);
  if (placement === undefined) return;
  placement.xMm = dragOrigin.x + (p.x - dragStart.x);
  placement.yMm = dragOrigin.y + (p.y - dragStart.y);
}

function onPointerUp(): void {
  draggingToolId = null;
  dragStart = null;
  dragOrigin = null;
}

function setGridManually(axis: 'x' | 'y', value: number): void {
  const cells = Math.max(1, Math.floor(value));
  if (!Number.isFinite(cells)) return;
  gridManual.value = true;
  if (axis === 'x') gridX.value = cells;
  else gridY.value = cells;
}

function applyDefaultDepth(value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  defaultDepthMm.value = value;
  for (const placement of placements.value) placement.pocketDepthMm = value;
}

function removeFingerHole(tool: TracedTool, index: number): void {
  tool.fingerHoles.splice(index, 1);
}

// Custom primitive dialog.
const primitiveDialog = ref(false);
const primitiveKind = ref<'circle' | 'rectangle'>('circle');
const primitiveDiameter = ref(20);
const primitiveWidth = ref(40);
const primitiveHeight = ref(20);
const primitiveCornerRadius = ref(2);

function addPrimitive(): void {
  try {
    const outline =
      primitiveKind.value === 'circle'
        ? primitiveOutline('circle', { diameterMm: primitiveDiameter.value })
        : primitiveOutline('rectangle', {
            widthMm: primitiveWidth.value,
            heightMm: primitiveHeight.value,
            cornerRadiusMm: primitiveCornerRadius.value,
          });
    store.addTool(
      outline,
      primitiveKind.value === 'circle'
        ? `Circle ${primitiveDiameter.value} mm`
        : `Rectangle ${primitiveWidth.value} x ${primitiveHeight.value} mm`,
    );
    primitiveDialog.value = false;
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Adding the shape failed.';
  }
}
</script>

<template>
  <v-row>
    <v-col cols="12" md="7">
      <p class="text-body-2 mb-2">
        <b>Drag each tool to its place in the bin.</b> The footprint grows
        automatically until you type a size yourself.
      </p>
      <canvas
        ref="canvas"
        class="layout-canvas"
        :class="{ 'finger-mode': fingerHoleMode }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
      <div class="d-flex align-center flex-wrap ga-2 mt-2">
        <v-text-field
          :model-value="gridX"
          type="number"
          min="1"
          step="1"
          label="Width (grid units)"
          density="compact"
          hide-details
          class="grid-field"
          @update:model-value="setGridManually('x', Number($event))"
        />
        <v-text-field
          :model-value="gridY"
          type="number"
          min="1"
          step="1"
          label="Depth (grid units)"
          density="compact"
          hide-details
          class="grid-field"
          @update:model-value="setGridManually('y', Number($event))"
        />
        <v-text-field
          :model-value="defaultDepthMm"
          type="number"
          min="1"
          step="1"
          label="Pocket depth (mm)"
          density="compact"
          hide-details
          class="grid-field"
          @update:model-value="applyDefaultDepth(Number($event))"
        />
      </div>
      <div class="d-flex align-center flex-wrap ga-2 mt-2">
        <v-btn
          :variant="fingerHoleMode ? 'flat' : 'outlined'"
          :color="fingerHoleMode ? 'primary' : undefined"
          size="small"
          prepend-icon="mdi-circle-outline"
          @click="fingerHoleMode = !fingerHoleMode"
        >
          {{ fingerHoleMode ? 'Placing finger holes: click a tool' : 'Add finger hole' }}
        </v-btn>
        <v-text-field
          v-if="fingerHoleMode"
          v-model.number="fingerHoleDiameter"
          type="number"
          min="1"
          step="1"
          label="Hole diameter (mm)"
          density="compact"
          hide-details
          class="grid-field"
        />
        <v-btn size="small" variant="outlined" prepend-icon="mdi-shape-outline" @click="primitiveDialog = true">
          Add basic shape
        </v-btn>
      </div>
      <v-alert v-if="errorMessage" type="error" density="compact" class="mt-2">
        {{ errorMessage }}
      </v-alert>
    </v-col>

    <v-col cols="12" md="5">
      <div class="text-caption text-medium-emphasis mb-1">Tools</div>
      <v-list density="compact" class="tool-list">
        <v-list-item
          v-for="tool in tools"
          :key="tool.id"
          :active="tool.id === selectedToolId"
          @click="selectedToolId = tool.id"
        >
          <v-list-item-title>{{ tool.name }}</v-list-item-title>
          <template #append>
            <v-btn icon size="x-small" variant="text" @click.stop="store.duplicateTool(tool.id)">
              <v-icon icon="mdi-content-copy" size="16" />
            </v-btn>
            <v-btn icon size="x-small" variant="text" color="error" @click.stop="store.removeTool(tool.id)">
              <v-icon icon="mdi-close" size="16" />
            </v-btn>
          </template>
        </v-list-item>
      </v-list>
      <p v-if="tools.length === 0" class="text-body-2 text-medium-emphasis">
        Trace a tool in the step above, or add a basic shape.
      </p>

      <template v-if="selectedTool !== null && selectedPlacement !== null">
        <v-divider class="my-3" />
        <v-text-field
          v-model="selectedTool.name"
          label="Tool name"
          density="compact"
          hide-details
          class="mb-2"
        />
        <div class="d-flex align-center flex-wrap ga-2">
          <v-text-field
            v-model.number="selectedTool.rotationDeg"
            type="number"
            step="5"
            label="Rotation (degrees)"
            density="compact"
            hide-details
            class="grid-field"
          />
          <v-select
            v-model="selectedTool.offsetMm"
            :items="CLEARANCE_CHOICES"
            label="Clearance (mm)"
            density="compact"
            hide-details
            class="grid-field"
          />
          <v-text-field
            v-model.number="selectedPlacement.pocketDepthMm"
            type="number"
            min="1"
            step="1"
            label="Depth (mm)"
            density="compact"
            hide-details
            class="grid-field"
          />
        </div>
        <v-switch
          v-model="selectedTool.mirrored"
          color="primary"
          density="compact"
          hide-details
          label="Mirrored"
        />
        <div v-if="selectedTool.fingerHoles.length > 0" class="text-caption text-medium-emphasis mt-1">
          Finger holes
        </div>
        <div
          v-for="(hole, index) in selectedTool.fingerHoles"
          :key="index"
          class="d-flex align-center ga-2"
        >
          <span class="text-caption">
            {{ hole.diameterMm }} mm at {{ hole.x.toFixed(0) }}, {{ hole.y.toFixed(0) }}
          </span>
          <v-btn icon size="x-small" variant="text" color="error" @click="removeFingerHole(selectedTool!, index)">
            <v-icon icon="mdi-close" size="14" />
          </v-btn>
        </div>
      </template>
    </v-col>
  </v-row>

  <v-dialog v-model="primitiveDialog" max-width="360">
    <v-card>
      <v-card-title class="text-subtitle-1">Add a basic shape</v-card-title>
      <v-card-text>
        <v-btn-toggle v-model="primitiveKind" mandatory density="comfortable" variant="outlined" class="mb-3">
          <v-btn value="circle">Circle</v-btn>
          <v-btn value="rectangle">Rectangle</v-btn>
        </v-btn-toggle>
        <v-text-field
          v-if="primitiveKind === 'circle'"
          v-model.number="primitiveDiameter"
          type="number"
          min="1"
          label="Diameter (mm)"
          density="compact"
        />
        <template v-else>
          <v-text-field v-model.number="primitiveWidth" type="number" min="1" label="Width (mm)" density="compact" />
          <v-text-field v-model.number="primitiveHeight" type="number" min="1" label="Height (mm)" density="compact" />
          <v-text-field
            v-model.number="primitiveCornerRadius"
            type="number"
            min="0"
            label="Corner radius (mm)"
            density="compact"
          />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="primitiveDialog = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" @click="addPrimitive">Add shape</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.layout-canvas {
  max-width: 100%;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  touch-action: none;
  cursor: grab;
}

.layout-canvas.finger-mode {
  cursor: crosshair;
}

.grid-field {
  max-width: 160px;
}

.tool-list {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
}
</style>
