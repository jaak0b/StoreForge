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
} from '../engine/baseplate/constants';
import { originOf, type QueueEntry } from '../engine/plan/types';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { baseplateCellCount } from '../engine/baseplate/generator';
import { validateProduct } from '../engine/plan/planFile';
import BinViewport from './BinViewport.vue';
import BaseplateOptionsFields from './BaseplateOptionsFields.vue';
import ConnectionClipCard from './ConnectionClipCard.vue';
import MoreOptions from './MoreOptions.vue';
import DrawerFillPanel from './DrawerFillPanel.vue';

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

// The single-plate form's More options disclosure; collapsed by default and
// component-local, unlike the bin tabs' shared store-persisted open state.
const moreOptionsOpen = ref(false);

// The connection clip's two fields. Component-local because neither is part
// of any baseplate design and neither needs to survive a tab switch.
const clipToleranceMm = ref(CLIP_TOLERANCE_DEFAULT);
const clipQuantity = ref(1);

/** Which size section the tab shows: the units X/Y form, or the drawer-fill form. Pure view state, never part of a queued product. */
const sizeMode = ref<'single' | 'fill'>('single');

/**
 * Whether the current plate is small enough to regenerate on every change.
 * Counts the generated cells including the brim's partial cells
 * (baseplateCellCount), so a brimmed plate loaded for editing is gated by
 * the workload it actually generates.
 */
const livePreview = computed(() => baseplateCellCount(store.params) <= LIVE_PREVIEW_MAX_CELLS);

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
    clipToleranceMm.value = quantizeClipTolerance(entry.product.toleranceMm);
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

// The queue's refusal of an invalid design, shown beside the save button.
const saveError = ref<string | null>(null);

/**
 * Live brim cap feedback: the same validateProduct check that blocks Add to
 * queue / Save changes at submit time, surfaced as soon as a brim side
 * reaches the cap so the user sees it while still editing. Filtered to the
 * brim's own message so an unrelated in-progress field (already constrained
 * by its own min/max) never shows here.
 */
const brimCapError = computed<string | null>(() => {
  const problem = validateProduct(store.product, 'This baseplate');
  return problem !== null && problem.includes('brim') ? problem : null;
});

function saveEntry(): void {
  const cleanNotes = store.notes.trim();
  const product = store.product;
  if (editingEntry.value !== null) {
    saveError.value = queue.update(editingEntry.value.id, {
      product,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    if (saveError.value !== null) return;
    app.stopEditing();
  } else {
    saveError.value = queue.add(product, quantity.value, cleanNotes);
    if (saveError.value !== null) return;
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
 * Rounds a clip tolerance to two decimals: the 0.05 slider step quantizes
 * exactly at two decimals, so filenames and captions render clean instead of
 * carrying float artifacts like 0.30000000000000004. The single source of the
 * stored tolerance value; render sites never re-format it.
 */
function quantizeClipTolerance(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Queues clip rows, or saves the clip row being edited. Leaves the baseplate
 * form untouched, so clips can be added before or after the plate itself. The
 * two fields are clamped to their exported bounds on commit; the queue's own
 * validation stays the backstop.
 */
function addClips(): void {
  clipToleranceMm.value = quantizeClipTolerance(
    Math.min(CLIP_TOLERANCE_MAX, Math.max(CLIP_TOLERANCE_MIN, clipToleranceMm.value)),
  );
  clipQuantity.value = Math.max(1, Math.round(clipQuantity.value));
  const product = { kind: 'clip', toleranceMm: clipToleranceMm.value } as const;
  if (clipEditingEntry.value !== null) {
    clipSaveError.value = queue.update(clipEditingEntry.value.id, {
      product,
      quantity: clipQuantity.value,
    });
    if (clipSaveError.value !== null) return;
    app.stopEditing();
  } else {
    clipSaveError.value = queue.add(product, clipQuantity.value);
  }
}

// The queue's refusal of an invalid clip row, shown beside the clip button.
const clipSaveError = ref<string | null>(null);

function cancelClipEdit(): void {
  app.stopEditing();
  clipToleranceMm.value = CLIP_TOLERANCE_DEFAULT;
  clipQuantity.value = 1;
}

function editingTitle(entry: QueueEntry): string {
  return describeProduct(entry.product).title;
}

/** Whether the drawer-fill layout is showing (a new plate in fill mode, no clip edit). */
const fillMode = computed(
  () => clipEditingEntry.value === null && editingEntry.value === null && sizeMode.value === 'fill',
);

/**
 * Whether the Baseplate tab is showing a drawer group's detail view instead of
 * the designer. This is the tab's third mode, alongside the single-plate form
 * and the fill-a-drawer form; it is driven by the app store's viewingDrawerId,
 * set when a drawer header or a drawer-linked plate row is clicked.
 */
const drawerMode = computed(() => app.viewingDrawerId !== null);
</script>

<template>
  <!-- The tab's drawer-detail mode: a drawer group header or one of its linked
       plate rows navigates here and shows the same fill-a-drawer layout, in edit
       mode, preloaded from the saved group with its own way back to the queue. -->
  <DrawerFillPanel v-if="drawerMode" :group-id="app.viewingDrawerId" />
  <template v-else>
  <!-- The mode toggle switches the tab between designing one plate and filling
       a drawer; hidden while editing an existing plate. -->
  <v-btn-toggle
    v-if="clipEditingEntry === null && editingEntry === null"
    v-model="sizeMode"
    mandatory
    density="comfortable"
    variant="outlined"
    class="mb-4"
  >
    <v-btn value="single">Single plate</v-btn>
    <v-btn value="fill">Fill a drawer</v-btn>
  </v-btn-toggle>

  <!-- Fill a drawer (create mode): the same shared panel the drawer detail view
       uses, composing a new drawer group. -->
  <DrawerFillPanel v-if="fillMode" :group-id="null" />

  <!-- Single plate, or editing an existing plate: the form beside the 3D preview. -->
  <v-row v-else-if="clipEditingEntry === null">
    <v-col cols="12" md="6">
      <div class="text-caption text-medium-emphasis mb-1">
        Baseplate size (grid units of 42 mm)
      </div>
      <div class="d-flex align-center ga-2 mb-2">
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
      <v-alert v-if="brimCapError" type="error" density="compact" class="mt-2">
        {{ brimCapError }}
      </v-alert>

      <BaseplateOptionsFields
        v-model:magnet-mode="store.magnetMode"
        v-model:magnet-diameter-mm="store.magnetDiameterMm"
        v-model:magnet-height-mm="store.magnetHeightMm"
        v-model:screw-hole-mode="store.screwHoleMode"
        v-model:connectable="store.connectable"
        class="mt-4"
      />

      <MoreOptions
        v-model:open="moreOptionsOpen"
        per-bin-fields
        hide-bin-fields
        :quantity="quantity"
        @update:quantity="quantity = $event"
      >
        <template #fields>
          <div class="brim-fields-row">
            <v-row dense>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimLeftMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim left (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimRightMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim right (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimFrontMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim front (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimBackMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim back (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
            </v-row>
          </div>
        </template>
        <template #after>
          <v-textarea
            v-model="store.notes"
            label="Notes"
            rows="2"
            auto-grow
            density="comfortable"
            hide-details
            class="mt-3"
          />
        </template>
      </MoreOptions>

      <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
        {{ errorMessage }}
      </v-alert>
      <v-alert v-if="saveError" type="error" class="mt-4" density="compact">
        {{ saveError }}
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
    </v-col>

    <v-col cols="12" md="6">
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

  <!-- The connection clip card: shown while designing a single connectable
       plate, or alone when a clip row routes here for editing. In fill-a-drawer
       mode the DrawerFillPanel owns the clip control (tolerance only, no
       quantity), so this card stays hidden there. -->
  <ConnectionClipCard
    v-if="(editingEntry === null && store.connectable && !fillMode) || clipEditingEntry !== null"
    v-model:tolerance-mm="clipToleranceMm"
    v-model:quantity="clipQuantity"
    show-quantity
    :submit-label="clipEditingEntry !== null ? 'Save changes' : 'Add clips to queue'"
    :show-cancel="clipEditingEntry !== null"
    :error="clipSaveError"
    class="mt-4"
    @submit="addClips"
    @cancel="cancelClipEdit"
  />
  </template>
</template>

<style scoped>
.preview-card {
  min-height: 320px;
}
.brim-fields-row {
  grid-column: 1 / -1;
  order: -1;
}
</style>
