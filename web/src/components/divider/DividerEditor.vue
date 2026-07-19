<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../../stores/binDesigner';
import { wallAngleDeg, wallLength } from '../../engine/gridfinity/dividerModel';
import DividerCanvas from './DividerCanvas.vue';

/**
 * The divider wall section of the More options disclosure: the top-down
 * editor with its toolbar, the wall list with the selected wall's exact
 * millimetre entry, and the even-dividers quick entry that generates a
 * regular grid of walls. The quick entry is a generator only: applying it
 * replaces the wall list, which then stays freely editable on the canvas.
 *
 * Endpoint coordinates are the only editable representation of a wall here,
 * matching the model's own representation, so there is nothing to convert and
 * no second editable form of the same value. Length and angle follow from the
 * endpoints and are shown as read-only rows.
 */

const store = useBinDesigner();
const { walls, selectedWallIndex, snapEnabled } = storeToRefs(store);

const evenCountX = ref(0);
const evenCountY = ref(0);

function applyEvenDividers(): void {
  store.applyEvenDividers(Math.max(0, Math.floor(evenCountX.value || 0)),
    Math.max(0, Math.floor(evenCountY.value || 0)));
}

/** The endpoint fields of the selected wall, in model order. */
const endpointFields = [
  { key: 'x1' as const, label: 'X1 (mm)' },
  { key: 'y1' as const, label: 'Y1 (mm)' },
  { key: 'x2' as const, label: 'X2 (mm)' },
  { key: 'y2' as const, label: 'Y2 (mm)' },
];

const selected = computed(() => store.selectedWall);

/** Rounded for display only; the stored wall keeps its full precision. */
function mm(value: number): string {
  return value.toFixed(2);
}

/**
 * Writes one endpoint coordinate of the selected wall. A field left empty or
 * mid-edit is not a number, and rewriting the wall with it would destroy the
 * wall, so the entry is ignored until it parses.
 */
function setCoordinate(key: 'x1' | 'y1' | 'x2' | 'y2', raw: string): void {
  const index = selectedWallIndex.value;
  const wall = selected.value;
  if (index === null || wall === null) return;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) return;
  store.setWall(index, { ...wall, [key]: value });
}
</script>

<template>
  <div>
    <div class="text-caption text-medium-emphasis mb-1">
      Drag on the bin interior to draw a divider wall. Drag a wall to move it, or drag an endpoint
      handle to change its length and angle.
    </div>
    <div class="d-flex align-center ga-1 mb-2">
      <v-tooltip text="Add a divider wall" location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-plus"
            variant="text"
            density="comfortable"
            @click="store.addWall()"
          />
        </template>
      </v-tooltip>
      <v-tooltip text="Duplicate the selected wall" location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-content-duplicate"
            variant="text"
            density="comfortable"
            :disabled="selectedWallIndex === null"
            @click="store.duplicateWall(selectedWallIndex!)"
          />
        </template>
      </v-tooltip>
      <v-tooltip text="Delete the selected wall" location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-delete-outline"
            variant="text"
            density="comfortable"
            :disabled="selectedWallIndex === null"
            @click="store.deleteWall(selectedWallIndex!)"
          />
        </template>
      </v-tooltip>
      <v-divider vertical class="mx-1" />
      <v-tooltip location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-grid"
            variant="text"
            density="comfortable"
            :color="snapEnabled ? 'primary' : undefined"
            :aria-pressed="snapEnabled"
            @click="snapEnabled = !snapEnabled"
          />
        </template>
        <span>
          Snap dragged walls to quarter cell positions and 15 degree angles. Turn snapping off to
          drag a wall to any position and angle.
        </span>
      </v-tooltip>
      <span class="text-caption text-medium-emphasis ml-2">
        {{ walls.length }} wall{{ walls.length === 1 ? '' : 's' }}
      </span>
    </div>

    <DividerCanvas />

    <div v-if="walls.length === 0" class="text-caption text-medium-emphasis mt-2">
      This bin has no divider walls yet.
    </div>
    <div v-else class="mt-2">
      <v-chip-group
        :model-value="selectedWallIndex"
        column
        @update:model-value="store.selectWall(($event as number | undefined) ?? null)"
      >
        <v-chip v-for="(_, index) in walls" :key="index" size="small" filter variant="outlined">
          Wall {{ index + 1 }}
        </v-chip>
      </v-chip-group>
    </div>

    <div v-if="selected !== null" class="mt-2">
      <div class="endpoint-grid">
        <v-text-field
          v-for="field in endpointFields"
          :key="field.key"
          :model-value="mm(selected[field.key])"
          type="number"
          step="0.5"
          :label="field.label"
          density="compact"
          hide-details
          @update:model-value="setCoordinate(field.key, String($event))"
        />
      </div>
      <div class="readout mt-2 text-caption text-medium-emphasis">
        <span>Length</span><span>{{ mm(wallLength(selected)) }} mm</span>
        <span>Angle</span><span>{{ wallAngleDeg(selected).toFixed(1) }}&deg;</span>
      </div>
    </div>

    <div class="text-caption text-medium-emphasis mt-3 mb-1">
      Evenly spaced walls (applying replaces the walls above)
    </div>
    <div class="d-flex align-center ga-2">
      <v-text-field
        v-model.number="evenCountX"
        type="number"
        min="0"
        step="1"
        label="Dividers along X"
        density="comfortable"
        hide-details
      />
      <v-text-field
        v-model.number="evenCountY"
        type="number"
        min="0"
        step="1"
        label="Dividers along Y"
        density="comfortable"
        hide-details
      />
      <v-btn variant="outlined" density="comfortable" @click="applyEvenDividers">Apply</v-btn>
    </div>
  </div>
</template>

<style scoped>
.endpoint-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}

.readout {
  display: grid;
  grid-template-columns: max-content max-content;
  gap: 0 16px;
}
</style>
