<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../../stores/binDesigner';
import { CLEARANCE_CHOICES, useToolTrace } from '../../stores/toolTrace';
import { useCustomIcons } from '../../stores/customIcons';
import { LABEL_ICONS } from '../../engine/label/icons';
import { binPlacement } from '../../engine/trace/layoutModel';
import { maxPocketDepthMm } from '../../engine/trace/pocketBin';
import type { FingerHole } from '../../engine/trace/types';
import IconPicker from '../IconPicker.vue';
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
const customIcons = useCustomIcons();

const { labelText, labelIcon, heightUnits } = storeToRefs(designer);
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

/** One-line summary under each tool row: rotation and clearance. */
function toolSummary(rotationDeg: number, offsetMm: number): string {
  return `${rotationDeg} deg, ${offsetMm} mm clearance`;
}

/** The current label icon's drawable shape, from the shared icon sources. */
const currentIcon = computed(() => {
  if (labelIcon.value === null) return null;
  return (
    LABEL_ICONS.find((icon) => icon.name === labelIcon.value) ??
    customIcons.iconByName(labelIcon.value) ??
    null
  );
});

const iconMenuOpen = ref(false);
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
              {{ toolSummary(tool.rotationDeg, tool.offsetMm) }}
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
            <v-switch
              :model-value="tool.mirrored"
              color="primary"
              density="compact"
              hide-details
              label="Mirrored"
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
        step="1"
        label="Height (units of 7 mm)"
        density="comfortable"
        :hint="`Pockets can be at most ${depthLimit} mm deep at this height.`"
        persistent-hint
      />
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
      <v-text-field
        v-model="labelText"
        label="Label"
        placeholder="What's inside?"
        density="comfortable"
        class="mt-2"
        hint="Embossed on the label shelf; long text shrinks to fit."
      />
      <div class="text-caption text-medium-emphasis mt-2 mb-1">Label icon</div>
      <v-menu v-model="iconMenuOpen" :close-on-content-click="false" location="bottom start">
        <template #activator="{ props: menuProps }">
          <v-btn variant="outlined" size="small" class="icon-thumb" v-bind="menuProps">
            <svg
              v-if="currentIcon !== null"
              width="24"
              height="24"
              :viewBox="currentIcon.viewBox.join(' ')"
              aria-hidden="true"
            >
              <path :d="currentIcon.path" fill="currentColor" fill-rule="evenodd" />
            </svg>
            <v-icon v-else icon="mdi-close" size="18" />
            <v-tooltip activator="parent" location="bottom">
              {{ currentIcon !== null ? currentIcon.name : 'No icon' }}; press to pick another.
            </v-tooltip>
          </v-btn>
        </template>
        <v-card class="pa-3 icon-menu">
          <IconPicker v-model="labelIcon" />
        </v-card>
      </v-menu>
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

.icon-thumb {
  min-width: 40px;
  width: 40px;
  height: 40px;
  padding: 0;
}

.icon-menu {
  max-width: 380px;
}
</style>
