<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBaseplateDesigner } from '../stores/baseplateDesigner';
import { useBinQueue } from '../stores/binQueue';
import { useBinPreview } from '../composables/useBinPreview';
import { generateBaseplate } from '../workerClient';
import type { PartMeshes } from '../engine/gridfinity/types';
import type { BaseplateParams } from '../engine/baseplate/constants';
import {
  BASEPLATE_UNITS_MAX,
  CLIP_TOLERANCE_DEFAULT,
  CLIP_TOLERANCE_MAX,
  CLIP_TOLERANCE_MIN,
  MAGNET_DIAMETER_MAX,
  MAGNET_DIAMETER_MIN,
  MAGNET_HEIGHT_MAX,
  MAGNET_HEIGHT_MIN,
} from '../engine/baseplate/constants';
import { originOf, type QueueEntry } from '../engine/plan/types';
import { describeProduct } from '../engine/plan/rowDescriptor';
import BinViewport from './BinViewport.vue';

/**
 * The Baseplate tab of the add-bin card: the baseplate designer form with a
 * live preview beside it. Designs a new baseplate queue entry, or edits an
 * existing one when the app store carries an editing id.
 */

const app = useApp();
const store = useBaseplateDesigner();
const queue = useBinQueue();
const { smAndDown } = useDisplay();

// The 3D preview is heavy; on small screens it starts paused and loads on
// demand. Once loaded it stays loaded.
const previewLoaded = ref(!smAndDown.value);

/**
 * Largest cell count the preview regenerates for automatically. Above it the
 * preview waits for the Generate preview button, because a full-option plate
 * generates at roughly 42 ms per cell (measured on a 20 by 20 plate, about
 * 17 s total) and the worker cannot cancel work a keystroke has superseded.
 * A provisional UX pacing threshold pending owner review, not a geometry
 * constant.
 */
const LIVE_PREVIEW_MAX_CELLS = 25;

const quantity = ref(1);
const widthField = ref<{ focus: () => void } | null>(null);

// The connection clip's two fields. Component-local because neither is part
// of any baseplate design and neither needs to survive a tab switch.
const clipToleranceMm = ref(CLIP_TOLERANCE_DEFAULT);
const clipQuantity = ref(1);

/** Whether the current plate is small enough to regenerate on every change. */
const livePreview = computed(() => store.unitsX * store.unitsY <= LIVE_PREVIEW_MAX_CELLS);

/**
 * The parameters the preview has been asked to generate. Follows the form
 * automatically while the plate is small; above the threshold it only moves
 * when the Generate preview button is pressed, so a large plate never queues
 * uncancellable worker runs on every keystroke.
 */
const requestedParams = shallowRef<BaseplateParams | null>(null);

watch(
  () => store.params,
  (params) => {
    if (livePreview.value) requestedParams.value = params;
  },
  { immediate: true },
);

/** True when the form has changed past what the preview last generated. */
const previewStale = computed(() => requestedParams.value !== store.params);

function generateNow(): void {
  requestedParams.value = store.params;
}

function generatePreview(params: BaseplateParams | null): Promise<PartMeshes | null> {
  // Nothing requested yet (a large plate before its first button press).
  if (params === null) return Promise.resolve(null);
  // A baseplate is one solid and has no second-filament part.
  return generateBaseplate(params).then((body) => ({ body, label: null }));
}

const { meshes, errorMessage } = useBinPreview(() => requestedParams.value, generatePreview);

function resetForm(): void {
  store.$reset();
  quantity.value = 1;
}

/** Loads the entry being edited into the form; null resets to a new design. */
function loadEditingEntry(entryId: string | null): void {
  if (entryId === null) {
    resetForm();
    return;
  }
  const entry = queue.entryById(entryId);
  if (entry === null || entry.product.kind !== 'baseplate') return;
  store.loadProduct(entry.product);
  store.notes = entry.notes ?? '';
  quantity.value = entry.quantity;
}

// The watch source is null unless the Baseplate tab owns the edit, so this
// tab never loads another tab's entry by construction. A clip row also routes
// to this tab but has its own parallel watcher below.
watch(
  () => (app.editingKind === 'baseplate' || app.editingKind === null ? app.editingEntryId : null),
  loadEditingEntry,
  { immediate: true },
);

// The parallel guard for a clip row: prefill the clip card from the stored
// product when a clip edit routes here.
watch(
  () => (app.editingKind === 'clip' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null || entry.product.kind !== 'clip') return;
    clipToleranceMm.value = entry.product.toleranceMm;
    clipQuantity.value = entry.quantity;
  },
  { immediate: true },
);

// Ctrl+N: reset to a new design and focus the first size field.
watch(
  () => app.focusAddSeq,
  () => {
    if (app.editingEntryId === null) resetForm();
    widthField.value?.focus();
  },
);

const editingEntry = computed<QueueEntry | null>(() => {
  if (app.editingKind !== 'baseplate' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && originOf(entry.product) === 'baseplate' ? entry : null;
});

function saveEntry(): void {
  const cleanNotes = store.notes.trim();
  const product = store.product;
  if (editingEntry.value !== null) {
    queue.update(editingEntry.value.id, {
      product,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    app.stopEditing();
  } else {
    queue.add(product, quantity.value, cleanNotes);
  }
  resetForm();
}

function cancelEdit(): void {
  app.stopEditing();
  resetForm();
}

/**
 * The clip entry being edited, when the app store routes a clip edit here. In
 * that mode the tab collapses to just the clip card.
 */
const clipEditingEntry = computed<QueueEntry | null>(() => {
  if (app.editingKind !== 'clip' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && entry.product.kind === 'clip' ? entry : null;
});

/**
 * Queues clip rows, or saves the clip row being edited. Leaves the baseplate
 * form untouched, so clips can be added before or after the plate itself.
 */
function addClips(): void {
  const product = { kind: 'clip', toleranceMm: clipToleranceMm.value } as const;
  if (clipEditingEntry.value !== null) {
    queue.update(clipEditingEntry.value.id, { product, quantity: clipQuantity.value });
    app.stopEditing();
  } else {
    queue.add(product, clipQuantity.value);
  }
}

function cancelClipEdit(): void {
  app.stopEditing();
  clipToleranceMm.value = CLIP_TOLERANCE_DEFAULT;
  clipQuantity.value = 1;
}

function editingTitle(entry: QueueEntry): string {
  return describeProduct(entry.product).title;
}
</script>

<template>
  <v-row>
    <v-col cols="12" md="6">
      <template v-if="clipEditingEntry === null">
      <div class="text-caption text-medium-emphasis mb-1">
        Baseplate size (grid units of 42 mm)
      </div>
      <div class="d-flex align-center ga-2">
        <v-text-field
          ref="widthField"
          v-model.number="store.unitsX"
          type="number"
          min="1"
          :max="BASEPLATE_UNITS_MAX"
          step="1"
          label="Width"
          density="comfortable"
          hide-details
        />
        <span class="text-medium-emphasis">x</span>
        <v-text-field
          v-model.number="store.unitsY"
          type="number"
          min="1"
          :max="BASEPLATE_UNITS_MAX"
          step="1"
          label="Depth"
          density="comfortable"
          hide-details
        />
      </div>

      <div class="text-caption text-medium-emphasis mb-1 mt-4">Base magnets</div>
      <v-btn-toggle
        v-model="store.magnetMode"
        mandatory
        density="comfortable"
        variant="outlined"
      >
        <v-btn value="none">None</v-btn>
        <v-btn value="full">Full</v-btn>
      </v-btn-toggle>
      <v-expand-transition>
        <div v-if="store.magnetMode === 'full'" class="mt-6">
          <v-slider
            v-model="store.magnetDiameterMm"
            :min="MAGNET_DIAMETER_MIN"
            :max="MAGNET_DIAMETER_MAX"
            step="0.1"
            thumb-label="always"
            label="Magnet diameter (mm)"
            hide-details
          >
            <template #append>
              <v-text-field
                v-model.number="store.magnetDiameterMm"
                type="number"
                :min="MAGNET_DIAMETER_MIN"
                :max="MAGNET_DIAMETER_MAX"
                step="0.1"
                density="compact"
                hide-details
                style="width: 90px"
              />
            </template>
          </v-slider>
          <v-slider
            v-model="store.magnetHeightMm"
            :min="MAGNET_HEIGHT_MIN"
            :max="MAGNET_HEIGHT_MAX"
            step="0.1"
            thumb-label="always"
            label="Magnet height (mm)"
            hide-details
            class="mt-4"
          >
            <template #append>
              <v-text-field
                v-model.number="store.magnetHeightMm"
                type="number"
                :min="MAGNET_HEIGHT_MIN"
                :max="MAGNET_HEIGHT_MAX"
                step="0.1"
                density="compact"
                hide-details
                style="width: 90px"
              />
            </template>
          </v-slider>
        </div>
      </v-expand-transition>

      <div class="text-caption text-medium-emphasis mb-1 mt-4">Screw holes</div>
      <v-btn-toggle
        v-model="store.screwHoleMode"
        mandatory
        density="comfortable"
        variant="outlined"
      >
        <v-btn value="none">None</v-btn>
        <v-btn value="full">Full</v-btn>
      </v-btn-toggle>

      <v-switch
        v-model="store.connectable"
        label="Connectable"
        color="primary"
        density="compact"
        hint="The plate's edges get the mating features a connection clip bridges."
        persistent-hint
        class="mt-2"
      />

      <div class="d-flex ga-2 mt-4">
        <v-text-field
          v-model.number="quantity"
          type="number"
          min="1"
          step="1"
          label="Quantity"
          density="comfortable"
          hide-details
          style="max-width: 140px"
        />
        <v-textarea v-model="store.notes" label="Notes" rows="2" auto-grow density="comfortable" hide-details />
      </div>

      <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
        {{ errorMessage }}
      </v-alert>

      <div class="d-flex ga-2 mt-4">
        <v-btn color="primary" variant="flat" size="large" class="flex-grow-1" @click="saveEntry">
          {{ editingEntry !== null ? 'Save changes' : 'Add to queue' }}
        </v-btn>
        <v-btn v-if="editingEntry !== null" variant="outlined" size="large" @click="cancelEdit">
          Cancel edit
        </v-btn>
      </div>
      <v-alert
        v-if="editingEntry !== null"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        Editing "{{ editingTitle(editingEntry) }}"; saving updates the queue row.
      </v-alert>
      </template>

      <v-card
        v-if="(editingEntry === null && store.connectable) || clipEditingEntry !== null"
        variant="tonal"
        class="mt-4"
        density="compact"
      >
        <v-card-item>
          <v-card-title>Connection clips</v-card-title>
        </v-card-item>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-4">
            A connection clip bridges two connectable baseplates. It prints as
            its own part, so it is queued as a separate row.
          </p>
          <v-slider
            v-model="clipToleranceMm"
            :min="CLIP_TOLERANCE_MIN"
            :max="CLIP_TOLERANCE_MAX"
            step="0.05"
            thumb-label="always"
            label="Clip tolerance (mm)"
            hint="The clearance is added to the clip only, so a clip printed with a larger tolerance still fits a plate you have already printed. Raise it when the clip is too tight to push into the joint."
            persistent-hint
            class="mt-4"
          >
            <template #append>
              <v-text-field
                v-model.number="clipToleranceMm"
                type="number"
                :min="CLIP_TOLERANCE_MIN"
                :max="CLIP_TOLERANCE_MAX"
                step="0.05"
                density="compact"
                hide-details
                style="width: 90px"
              />
            </template>
          </v-slider>
          <div class="d-flex align-center ga-2 mt-4">
            <v-text-field
              v-model.number="clipQuantity"
              type="number"
              min="1"
              step="1"
              label="Quantity"
              density="comfortable"
              hide-details
              style="max-width: 140px"
            />
            <v-btn variant="outlined" @click="addClips">
              {{ clipEditingEntry !== null ? 'Save changes' : 'Add clips to queue' }}
            </v-btn>
            <v-btn v-if="clipEditingEntry !== null" variant="outlined" @click="cancelClipEdit">
              Cancel edit
            </v-btn>
          </div>
        </v-card-text>
      </v-card>
    </v-col>

    <v-col v-if="clipEditingEntry === null" cols="12" md="6">
      <v-card variant="outlined" class="preview-card">
        <template v-if="!previewLoaded">
          <div class="d-flex flex-column align-center justify-center text-center fill-height pa-8">
            <v-icon icon="mdi-cube-outline" size="64" class="mb-4 text-medium-emphasis" />
            <p class="text-body-2 text-medium-emphasis mb-4">
              The 3D preview is paused on small screens.
            </p>
            <v-btn color="primary" variant="tonal" @click="previewLoaded = true">
              Load preview
            </v-btn>
          </div>
        </template>
        <template v-else-if="!livePreview && previewStale">
          <div class="d-flex flex-column align-center justify-center text-center fill-height pa-8">
            <v-icon icon="mdi-cube-outline" size="64" class="mb-4 text-medium-emphasis" />
            <p class="text-body-2 text-medium-emphasis mb-4">
              The preview of a plate this large takes a while to generate, so it
              waits until you ask for it.
            </p>
            <v-btn color="primary" variant="tonal" @click="generateNow">
              Generate preview
            </v-btn>
          </div>
        </template>
        <BinViewport v-else :mesh="meshes?.body ?? null" :label="null" />
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.preview-card {
  min-height: 320px;
}
</style>
