<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../../stores/binDesigner';
import { CLEARANCE_CHOICES, HOLE_WIDTH_CHOICES, useToolTrace } from '../../stores/toolTrace';
import { binPlacement } from '../../engine/trace/layoutModel';
import { maxPocketDepthMm } from '../../engine/trace/pocketBin';
import { DEFAULT_DRAFT_ANGLE_DEG, validateDraftAngleDeg } from '../../engine/carve/sweep';
import type { FingerHole } from '../../engine/trace/types';
import { overallHeightMm } from '../../heightHint';
import LabelIconField from '../LabelIconField.vue';
import ProductSelect from '../ProductSelect.vue';
import MoreOptions from '../MoreOptions.vue';

/**
 * The advanced drawer of the layout workspace, opened by the Edit button in
 * the canvas corner. Two tabs: Trace (the tool list with precision fields,
 * the footprint controls and pocket depth default) and Bin (height, label
 * and the shared bin options). Selecting a tool on the canvas expands its
 * row here; all values flow through the toolTrace and binDesigner stores.
 */

const props = defineProps<{
  /** True when a tool can be re-traced (embedding ready or photo stored). */
  retraceAvailable: boolean;
  quantity: number;
}>();

const emit = defineEmits<{
  /** Asks the workspace to re-trace the tool from its stored clicks. */
  retrace: [toolId: string];
  'update:quantity': [value: number];
}>();

const designer = useBinDesigner();
const trace = useToolTrace();

const { labelText, labelIcon, productChoice, fused, heightUnits } = storeToRefs(designer);
const {
  tools,
  selectedToolId,
  gridManual,
  defaultDepthMm,
  fingerHoleDiameterMm,
} = storeToRefs(trace);

const tab = ref<'trace' | 'bin'>('trace');

const selectedPlacement = computed(() =>
  selectedToolId.value !== null ? trace.placementOf(selectedToolId.value) ?? null : null,
);

/**
 * The selected tool's draft angle, edited through a local draft committed on
 * blur or Enter: the value is validated with the shared bound (0 up to but not
 * including 90 degrees) and only written to the placement when it passes,
 * mirroring the cutout tab's draft-angle field. An invalid entry surfaces the
 * bound as the field's error message and reverts to the last good value.
 */
const draftAngleDraft = ref<number>(DEFAULT_DRAFT_ANGLE_DEG);
const draftAngleError = ref<string | null>(null);
watch(
  () => selectedPlacement.value?.draftAngleDeg ?? DEFAULT_DRAFT_ANGLE_DEG,
  (draftAngleDeg) => {
    draftAngleDraft.value = draftAngleDeg;
    draftAngleError.value = null;
  },
  { immediate: true },
);

function commitDraftAngle(): void {
  const toolId = selectedToolId.value;
  const previous = selectedPlacement.value?.draftAngleDeg ?? DEFAULT_DRAFT_ANGLE_DEG;
  const value = draftAngleDraft.value;
  if (toolId === null || !Number.isFinite(value) || value === previous) {
    draftAngleDraft.value = previous;
    draftAngleError.value = null;
    return;
  }
  try {
    validateDraftAngleDeg(value);
  } catch (error) {
    draftAngleError.value =
      error instanceof Error ? error.message : 'The draft angle is out of range.';
    draftAngleDraft.value = previous;
    return;
  }
  draftAngleError.value = null;
  trace.setDraftAngle(toolId, value);
}

/**
 * The smallest footprint that fits the current layout, straight from the
 * layout model; the size fields show it as their minimum. Null while no tool
 * is placed.
 */
const requiredGrid = computed(() =>
  trace.placements.length > 0
    ? binPlacement({
        tools: trace.tools,
        placements: trace.placements,
        gridX: trace.gridX,
        gridY: trace.gridY,
        gridManual: false,
      })
    : null,
);

// The size fields edit local mirrors of the derived footprint (the typed
// floor grown to whatever the layout demands): the store clamps a typed
// value to the required minimum and returns what it applied, and writing
// that back into the mirror re-renders the field even when the derived
// value itself did not change (a typed value below an unchanged minimum),
// so the field always echoes the applied size.
const gridXField = ref(trace.binPlacement.gridX);
const gridYField = ref(trace.binPlacement.gridY);
watch(
  () => trace.binPlacement.gridX,
  (value) => {
    gridXField.value = value;
  },
);
watch(
  () => trace.binPlacement.gridY,
  (value) => {
    gridYField.value = value;
  },
);

function setGridManually(axis: 'x' | 'y', value: number): void {
  const applied = trace.setGridManually(axis, value);
  if (axis === 'x') gridXField.value = applied;
  else gridYField.value = applied;
}

function applyDefaultDepth(value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  defaultDepthMm.value = value;
  for (const placement of trace.placements) {
    trace.setPocketDepth(placement.toolId, value);
  }
}

/** True when the hole is an elongated slot rather than a circle. */
function isSlot(hole: FingerHole): boolean {
  return hole.x2 !== undefined && hole.y2 !== undefined;
}

/** Overall slot length in mm: the endpoint distance plus one diameter. */
function holeLengthMm(hole: FingerHole): number {
  return (
    Math.hypot((hole.x2 ?? hole.x) - hole.x, (hole.y2 ?? hole.y) - hole.y) + hole.diameterMm
  );
}

const depthLimit = computed(() => maxPocketDepthMm(heightUnits.value));

const heightMm = computed(() => overallHeightMm(heightUnits.value));

/**
 * One-line summary under each tool row: draft angle, clearance and hole width.
 * The draft angle comes from the placement (its single source, edited by the
 * draft-angle field); clearance and hole width live on the tool.
 */
function toolSummary(draftAngleDeg: number, offsetMm: number, minHoleWidthMm: number): string {
  return `${draftAngleDeg} deg, ${offsetMm} mm clearance, ${minHoleWidthMm} mm min hole`;
}

</script>

<template>
  <div class="drawer d-flex flex-column">
    <v-tabs v-model="tab" density="compact" grow>
      <v-tab value="trace">Trace</v-tab>
      <v-tab value="bin">Bin</v-tab>
    </v-tabs>
    <v-divider />

    <div v-if="tab === 'trace'" class="drawer-body pa-3">
      <div class="drawer-head">Tools</div>
      <v-list v-if="tools.length > 0" density="compact" class="tool-list py-0">
        <template v-for="tool in tools" :key="tool.id">
          <v-list-item
            :active="tool.id === selectedToolId"
            @click="selectedToolId = tool.id === selectedToolId ? null : tool.id"
          >
            <v-list-item-title>{{ tool.name }}</v-list-item-title>
            <v-list-item-subtitle class="text-caption">
              {{
                toolSummary(
                  trace.placementOf(tool.id)?.draftAngleDeg ?? DEFAULT_DRAFT_ANGLE_DEG,
                  tool.offsetMm,
                  tool.minHoleWidthMm,
                )
              }}
            </v-list-item-subtitle>
            <template #append>
              <v-btn
                v-if="tool.clicks.length > 0"
                icon
                size="x-small"
                variant="text"
                :disabled="!retraceAvailable"
                title="Re-trace this tool from its saved clicks."
                @click.stop="emit('retrace', tool.id)"
              >
                <v-icon icon="mdi-magic-staff" size="16" />
              </v-btn>
              <v-btn icon size="x-small" variant="text" @click.stop="trace.duplicateTool(tool.id)">
                <v-icon icon="mdi-content-copy" size="16" />
              </v-btn>
              <v-btn icon size="x-small" variant="text" color="error" @click.stop="trace.removeTool(tool.id)">
                <v-icon icon="mdi-close" size="16" />
              </v-btn>
            </template>
          </v-list-item>
          <div
            v-if="tool.id === selectedToolId && selectedPlacement !== null"
            class="tool-detail px-3 py-2"
          >
            <v-text-field
              v-model="tool.name"
              label="Tool name"
              density="compact"
              hide-details
              class="mb-2"
            />
            <div class="d-flex align-center flex-wrap ga-2">
              <v-text-field
                :model-value="tool.rotationDeg"
                type="number"
                step="5"
                label="Rotation (degrees)"
                density="compact"
                hide-details
                class="small-field"
                @update:model-value="trace.setToolTransform(tool.id, { rotationDeg: Number($event) })"
              />
              <v-text-field
                :model-value="selectedPlacement.pocketDepthMm"
                type="number"
                min="1"
                step="1"
                label="Depth (mm)"
                density="compact"
                hide-details
                class="small-field"
                @update:model-value="trace.setPocketDepth(tool.id, Number($event))"
              />
              <v-text-field
                v-model.number="draftAngleDraft"
                type="number"
                min="0"
                step="1"
                label="Draft angle (degrees)"
                density="compact"
                hide-details="auto"
                :error-messages="draftAngleError ?? undefined"
                class="small-field"
                @blur="commitDraftAngle"
                @keydown.enter="commitDraftAngle"
              />
            </div>
            <div class="text-caption text-medium-emphasis mt-2 mb-1">Clearance (mm)</div>
            <v-btn-toggle
              :model-value="tool.offsetMm"
              mandatory
              density="compact"
              variant="outlined"
              divided
              @update:model-value="trace.setToolTransform(tool.id, { offsetMm: Number($event) })"
            >
              <v-btn
                v-for="choice in CLEARANCE_CHOICES"
                :key="choice"
                :value="choice"
                size="small"
                class="clearance-choice"
              >
                {{ choice }}
              </v-btn>
            </v-btn-toggle>
            <div class="text-caption text-medium-emphasis mt-2 mb-1">Minimum hole width (mm)</div>
            <v-btn-toggle
              :model-value="tool.minHoleWidthMm"
              mandatory
              density="compact"
              variant="outlined"
              divided
              @update:model-value="trace.setToolTransform(tool.id, { minHoleWidthMm: Number($event) })"
            >
              <v-btn
                v-for="choice in HOLE_WIDTH_CHOICES"
                :key="choice"
                :value="choice"
                size="small"
                class="clearance-choice"
              >
                {{ choice }}
              </v-btn>
            </v-btn-toggle>
            <p class="text-caption text-medium-emphasis mt-1 mb-0">
              Holes narrower than this are filled in so no thin island is left standing in the
              pocket. 0 keeps every hole.
            </p>
            <div class="text-caption text-medium-emphasis mt-2 readout">
              <div><span>Holes in outline</span><span>{{ tool.outline.holes.length }}</span></div>
              <div><span>Filled</span><span>{{ tool.filledHoleIndices.length }}</span></div>
            </div>
            <v-switch
              :model-value="tool.mirrored"
              color="primary"
              density="compact"
              hide-details
              label="Mirrored"
              class="mt-1"
              @update:model-value="trace.setToolTransform(tool.id, { mirrored: $event === true })"
            />
            <div v-if="tool.fingerHoles.length > 0" class="text-caption text-medium-emphasis mt-1">
              Finger holes
            </div>
            <div
              v-for="(hole, index) in tool.fingerHoles"
              :key="index"
              class="d-flex align-center ga-2 mt-1"
            >
              <span class="text-caption flex-grow-1">
                <template v-if="isSlot(hole)">
                  Slot, {{ holeLengthMm(hole).toFixed(0) }} mm long, at
                  {{ hole.x.toFixed(0) }}, {{ hole.y.toFixed(0) }}
                </template>
                <template v-else>
                  Circle at {{ hole.x.toFixed(0) }}, {{ hole.y.toFixed(0) }}
                </template>
              </span>
              <v-text-field
                :model-value="hole.diameterMm"
                type="number"
                min="1"
                step="1"
                label="Diameter (mm)"
                density="compact"
                hide-details
                class="hole-field"
                @update:model-value="trace.setFingerHoleDiameter(hole, Number($event))"
              />
              <v-btn icon size="x-small" variant="text" color="error" @click="trace.removeFingerHole(tool, index)">
                <v-icon icon="mdi-close" size="14" />
              </v-btn>
            </div>
          </div>
        </template>
      </v-list>
      <p v-else class="text-body-2 text-medium-emphasis mb-0">
        Trace a tool on the canvas, or add a basic shape from the canvas buttons.
      </p>

      <div class="drawer-head mt-4">Footprint</div>
      <div class="d-flex align-center ga-2 mb-2">
        <span class="text-body-2">
          {{ trace.binPlacement.gridX }} x {{ trace.binPlacement.gridY }} grid units
        </span>
        <v-chip v-if="!gridManual" size="x-small" color="primary" variant="tonal" label>
          Auto
        </v-chip>
      </div>
      <div class="d-flex align-center flex-wrap ga-2">
        <v-text-field
          :model-value="gridXField"
          type="number"
          :min="requiredGrid?.gridX ?? 1"
          step="1"
          label="Width (grid units)"
          density="compact"
          hide-details
          class="small-field"
          @update:model-value="setGridManually('x', Number($event))"
        />
        <v-text-field
          :model-value="gridYField"
          type="number"
          :min="requiredGrid?.gridY ?? 1"
          step="1"
          label="Depth (grid units)"
          density="compact"
          hide-details
          class="small-field"
          @update:model-value="setGridManually('y', Number($event))"
        />
      </div>
      <v-btn
        v-if="gridManual"
        size="small"
        variant="outlined"
        prepend-icon="mdi-arrow-collapse-all"
        class="mt-2"
        title="Drop the typed minimum size; the footprint follows the layout alone."
        @click="trace.enableAutoSize()"
      >
        Auto size
      </v-btn>
      <div class="d-flex align-center flex-wrap ga-2 mt-3">
        <v-text-field
          :model-value="defaultDepthMm"
          type="number"
          min="1"
          step="1"
          label="Pocket depth (mm)"
          density="compact"
          hide-details
          class="small-field"
          @update:model-value="applyDefaultDepth(Number($event))"
        />
        <v-text-field
          v-model.number="fingerHoleDiameterMm"
          type="number"
          min="1"
          step="1"
          label="Hole diameter (mm)"
          density="compact"
          hide-details
          class="small-field"
        />
      </div>
    </div>

    <div v-else class="drawer-body pa-3">
      <v-text-field
        v-model.number="heightUnits"
        type="number"
        min="2"
        step="0.5"
        label="Height (units of 7 mm)"
        density="comfortable"
        :hint="`Pockets can be at most ${depthLimit} mm deep at this height.`"
        persistent-hint
      />
      <div v-if="heightMm !== null" class="text-caption text-medium-emphasis mt-1">
        {{ heightMm }} mm overall
      </div>
      <v-text-field
        :model-value="defaultDepthMm"
        type="number"
        min="1"
        step="1"
        label="Pocket depth (mm)"
        density="comfortable"
        hide-details
        class="mt-2"
        @update:model-value="applyDefaultDepth(Number($event))"
      />
      <LabelIconField
        v-if="designer.hasLabel"
        v-model:text="labelText"
        v-model:icon="labelIcon"
        class="mt-2"
      />
      <ProductSelect v-model="productChoice" v-model:fused="fused" hide-insert-only class="mt-2" />
      <MoreOptions
        per-bin-fields
        hide-dividers
        :quantity="props.quantity"
        @update:quantity="emit('update:quantity', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.drawer {
  height: 100%;
}

/*
 * The tabs strip (a v-slide-group, flex: 1 1 auto) and the v-divider
 * (flex: 1 1 100%) both grow inside this flex column when the drawer is
 * taller than its content, opening a dead gap between the tab headers and
 * the first section. Pin them to their natural height; spare space belongs
 * below the body.
 */
.drawer > .v-tabs,
.drawer > .v-divider {
  flex: 0 0 auto;
}

.drawer-body {
  overflow-y: auto;
}

.drawer-head {
  font-weight: 700;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-bottom: 6px;
}

.tool-list {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
}

.tool-detail {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.small-field {
  max-width: 145px;
}

.hole-field {
  max-width: 110px;
  flex: 0 0 110px;
}

.clearance-choice {
  min-width: 44px;
  padding: 0 8px;
}

.readout > div {
  display: flex;
  gap: 12px;
}

.readout span:first-child {
  min-width: 120px;
}

</style>
