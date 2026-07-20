<script setup lang="ts">
import { ref } from 'vue';
import { useCutout } from '../../stores/cutout';
import { modelNotStoredMessage } from '../../engine/plan/missingModels';
import type { CutoutModel } from '../../engine/plan/types';

/**
 * The models carved out of the bin: one row each, with the file's name, what
 * it contains, and the clearance its pocket is dilated by.
 *
 * Three things happen on a row and nowhere else. A clearance is committed here,
 * on blur or on Enter, because every committed value costs a fresh offset of
 * the whole model. A model whose file this device does not have is located
 * here, which re-links the chosen file to the record and keeps the placement
 * the user already did. And the question about a model's units, when its size
 * makes one worth asking, is answered here.
 *
 * Clicking a row selects the model, which is the selection path that always
 * works: a model sunk into the bin is hidden behind a wall and cannot be
 * clicked in the 3D view at all.
 */

const props = defineProps<{
  /** Largest clearance the bin's footprint can hold, for the field's ceiling. */
  maxClearanceMm: number;
  /** Step of the clearance stepper, in mm. */
  clearanceStepMm: number;
}>();

const emit = defineEmits<{
  /** Files chosen through the Add model button, in the order chosen. */
  add: [files: File[]];
  /** A file chosen to re-link to a model whose bytes are missing. */
  locate: [id: string, file: File];
  remove: [id: string];
  /** A clearance the user committed by leaving the field or pressing Enter. */
  commitClearance: [id: string, clearanceMm: number];
  /** The unit proposal on a model was accepted. */
  acceptUnits: [id: string];
  /** The unit proposal on a model was declined; the model stays in millimetres. */
  keepUnits: [id: string];
}>();

const cutout = useCutout();

const addInput = ref<HTMLInputElement | null>(null);
const locateInput = ref<HTMLInputElement | null>(null);
/** Which model the Locate file picker was opened for. */
const locatingId = ref<string | null>(null);

function onAddInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  if (files.length > 0) emit('add', files);
  input.value = '';
}

function openLocate(id: string): void {
  locatingId.value = id;
  locateInput.value?.click();
}

function onLocateInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const id = locatingId.value;
  if (file !== undefined && id !== null) emit('locate', id, file);
  input.value = '';
  locatingId.value = null;
}

function commitClearance(model: CutoutModel): void {
  emit('commitClearance', model.id, cutout.stateOf(model.id).clearanceDraft);
}

function onClearanceInput(model: CutoutModel, value: unknown): void {
  cutout.setClearanceDraft(model.id, Number(value));
}
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-2">
      <div class="text-caption text-medium-emphasis">Models</div>
      <v-btn
        variant="outlined"
        size="small"
        prepend-icon="mdi-file-plus-outline"
        @click="addInput?.click()"
      >
        Add model
      </v-btn>
    </div>
    <input
      ref="addInput"
      type="file"
      accept=".stl"
      multiple
      class="d-none"
      @change="onAddInput"
    />
    <input
      ref="locateInput"
      type="file"
      accept=".stl"
      class="d-none"
      @change="onLocateInput"
    />

    <p v-if="cutout.models.length === 0" class="text-body-2 text-medium-emphasis">
      Add an STL model of the object the bin has to hold. Its shape is carved
      into the bin interior as a pocket.
    </p>

    <v-card
      v-for="model in cutout.models"
      :key="model.id"
      variant="outlined"
      class="mb-2 model-row"
      :class="{ selected: model.id === cutout.selectedModelId }"
      @click="cutout.select(model.id)"
    >
      <div class="pa-3">
        <div class="d-flex align-center ga-2">
          <v-icon
            :icon="model.id === cutout.selectedModelId ? 'mdi-circle' : 'mdi-circle-outline'"
            size="12"
            :class="model.id === cutout.selectedModelId ? 'text-primary' : 'text-medium-emphasis'"
          />
          <span class="text-body-2 text-truncate flex-grow-1">{{ model.name }}</span>
          <v-btn
            icon="mdi-delete-outline"
            variant="text"
            size="small"
            :aria-label="`Remove the model ${model.name}`"
            @click.stop="emit('remove', model.id)"
          />
        </div>

        <div class="text-caption text-medium-emphasis mt-1">
          {{ model.triangleCount }} triangles
        </div>

        <template v-if="cutout.stateOf(model.id).missing">
          <p class="text-body-2 mt-2">{{ modelNotStoredMessage(model) }}</p>
          <v-btn
            variant="outlined"
            size="small"
            class="mt-2"
            prepend-icon="mdi-file-search-outline"
            @click.stop="openLocate(model.id)"
          >
            Locate file
          </v-btn>
        </template>

        <template v-else>
          <div class="d-flex align-center ga-2 mt-2">
            <v-text-field
              :model-value="cutout.stateOf(model.id).clearanceDraft"
              type="number"
              min="0"
              :max="props.maxClearanceMm"
              :step="props.clearanceStepMm"
              label="Clearance (mm)"
              density="compact"
              hide-details
              :disabled="cutout.stateOf(model.id).busy"
              @click.stop
              @update:model-value="onClearanceInput(model, $event)"
              @blur="commitClearance(model)"
              @keyup.enter="commitClearance(model)"
            />
          </div>
        </template>

        <template v-if="cutout.stateOf(model.id).busy">
          <div class="text-caption text-medium-emphasis mt-2">
            Applying the clearance to this model.
          </div>
          <v-progress-linear indeterminate class="mt-1" />
        </template>

        <v-alert
          v-if="cutout.stateOf(model.id).error"
          type="error"
          density="compact"
          class="mt-2"
        >
          {{ cutout.stateOf(model.id).error }}
        </v-alert>

        <v-alert
          v-if="cutout.stateOf(model.id).note"
          type="info"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          {{ cutout.stateOf(model.id).note }}
        </v-alert>

        <template v-if="cutout.stateOf(model.id).proposal">
          <v-alert type="warning" variant="tonal" density="compact" class="mt-2">
            {{ cutout.stateOf(model.id).proposal?.message }}
          </v-alert>
          <div class="d-flex ga-2 mt-2">
            <v-btn variant="flat" size="small" color="primary" @click.stop="emit('acceptUnits', model.id)">
              {{ cutout.stateOf(model.id).proposal?.acceptLabel }}
            </v-btn>
            <v-btn variant="outlined" size="small" @click.stop="emit('keepUnits', model.id)">
              {{ cutout.stateOf(model.id).proposal?.rejectLabel }}
            </v-btn>
          </div>
        </template>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.model-row {
  cursor: pointer;
}

.model-row.selected {
  border-color: rgb(var(--v-theme-primary));
}
</style>
