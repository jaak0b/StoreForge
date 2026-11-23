<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinDesigner } from '../stores/binDesigner';
import { DEFAULT_ENTRY_QUANTITY, useBinQueue } from '../stores/binQueue';
import { useBinPreview } from '../composables/useBinPreview';
import { generateInsert, generateSlottedBin } from '../workerClient';
import type { PartMeshes } from '../engine/gridfinity/types';
import { assertNever, originOf, type Product, type QueueEntry } from '../engine/plan/types';
import { binPreviewParams } from '../engine/plan/geometry';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { manualDesignOf, manualProduct } from '../engine/plan/manualProduct';
import { overallHeightMm } from '../heightHint';
import { downloadProduct, type ProductDownload } from '../binDownloads';
import AddToQueueSplitButton from './AddToQueueSplitButton.vue';
import BinViewport from './BinViewport.vue';
import LabelIconField from './LabelIconField.vue';
import ProductSelect from './ProductSelect.vue';
import MoreOptions from './MoreOptions.vue';
import DividerControl from './divider/DividerControl.vue';

/**
 * The Manual bin tab of the add-bin card: the product designer form with a
 * live preview beside it. Designs a new queue entry (a bin, a bin with its
 * label insert, or a standalone insert), or edits an existing one when the
 * app store carries an editing id. The product choice shapes the form: an
 * insert-only design shows just its width and label content.
 */

const app = useApp();
const store = useBinDesigner();
const queue = useBinQueue();
const { smAndDown } = useDisplay();

// The 3D preview is heavy; on small screens it starts paused and loads on
// demand. Once loaded it stays loaded. Mesh generation itself keeps running
// regardless, so downloads stay available.
const previewLoaded = ref(!smAndDown.value);

const { productChoice, fused, gridX, gridY, heightUnits, labelText, labelIcon, notes } =
  storeToRefs(store);

const quantity = ref(DEFAULT_ENTRY_QUANTITY);
const gridXField = ref<{ focus: () => void } | null>(null);

const insertOnly = computed(() => productChoice.value === 'insert');

const heightMm = computed(() => overallHeightMm(heightUnits.value));

function resetForm(): void {
  const keepOpen = store.moreOptionsOpen;
  store.$reset();
  store.moreOptionsOpen = keepOpen;
  quantity.value = DEFAULT_ENTRY_QUANTITY;
}

/** Loads the entry being edited into the form; null resets to a new design. */
function loadEditingEntry(entryId: string | null): void {
  if (entryId === null) {
    resetForm();
    return;
  }
  const entry = queue.entryById(entryId);
  if (entry === null || originOf(entry.product) !== 'manual') return;
  const design = manualDesignOf(entry.product);
  if (design === null) return;
  store.loadDesign(design);
  store.notes = entry.notes ?? '';
  quantity.value = entry.quantity;
  if (store.labelText2 !== '' || entry.notes !== undefined || entry.quantity > 1) {
    store.moreOptionsOpen = true;
  }
}

// The watch source is null unless the Manual tab owns the edit, so this tab
// never loads a screw or traced entry by construction.
watch(
  () => (app.editingKind === 'manual' || app.editingKind === null ? app.editingEntryId : null),
  loadEditingEntry,
  { immediate: true },
);

// Ctrl+N: reset to a new design and focus the first size field.
watch(
  () => app.focusAddSeq,
  () => {
    if (app.editingEntryId === null) resetForm();
    gridXField.value?.focus();
  },
);

const editingEntry = computed<QueueEntry | null>(() => {
  if (app.editingKind !== 'manual' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && originOf(entry.product) === 'manual' ? entry : null;
});

/** The product the form currently designs, through the engine's single manual mapping. */
function designedProduct(): Product {
  return manualProduct({
    productChoice: store.productChoice,
    gridX: store.gridX,
    gridY: store.gridY,
    heightUnits: store.heightUnits,
    magnetHoles: store.magnetHoles,
    walls: store.walls,
    content: store.content,
    fused: store.fused,
  });
}

// The queue's refusal of an invalid design, shown beside the save button.
const saveError = ref<string | null>(null);

function saveEntry(): void {
  const product = designedProduct();
  if (editingEntry.value !== null) {
    saveError.value = queue.update(editingEntry.value.id, {
      product,
      quantity: quantity.value,
      notes: notes.value,
    });
    if (saveError.value !== null) return;
    app.stopEditing();
  } else {
    const result = queue.add(product, quantity.value, notes.value);
    saveError.value = result.problem;
    if (result.problem !== null) return;
  }
  resetForm();
}

/** Queues the design and moves it onto the newest build plate in one step. */
function addToPlate(): void {
  const result = queue.add(designedProduct(), quantity.value, notes.value);
  saveError.value = result.problem;
  if (result.problem !== null) return;
  queue.addEntryToNewestBatch(result.id, quantity.value);
  resetForm();
}

// Direct downloads of the designed product, without touching the queue. The
// warnings a generation can return are shown, never dropped.
const downloadWarnings = ref<string[]>([]);

async function downloadDesign(request: ProductDownload): Promise<void> {
  saveError.value = null;
  downloadWarnings.value = [];
  try {
    const product = designedProduct();
    downloadWarnings.value =
      await downloadProduct(product, request);
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : 'The download failed.';
  }
}

function cancelEdit(): void {
  app.stopEditing();
  resetForm();
}

function editingTitle(entry: QueueEntry): string {
  return describeProduct(entry.product).title;
}

/**
 * The preview follows the product Add to queue would create, so the preview
 * and the queued entry come from the same engine mapping.
 */
function generatePreview(product: Product): Promise<PartMeshes> {
  switch (product.kind) {
    case 'insert':
      return generateInsert({ cells: product.cells, content: product.content });
    case 'bin':
    case 'binWithInsert':
      return generateSlottedBin(binPreviewParams(product));
    case 'baseplate':
    case 'clip':
      throw new Error(`The Manual bin tab never designs a ${product.kind} product.`);
    default:
      return assertNever(product);
  }
}

const { meshes, errorMessage } = useBinPreview(designedProduct, generatePreview);
</script>

<template>
  <v-row>
    <v-col cols="12" md="6">
      <ProductSelect v-model="productChoice" v-model:fused="fused" />

      <template v-if="!insertOnly">
        <div class="text-caption text-medium-emphasis mb-1 mt-4">
          Bin size (grid units of 42 mm; height units of 7 mm)
        </div>
        <div class="d-flex align-center ga-2">
          <v-text-field
            ref="gridXField"
            :model-value="gridX"
            type="number"
            min="1"
            step="1"
            label="Width"
            density="comfortable"
            hide-details
            @update:model-value="store.setGridX(Number($event))"
          />
          <span class="text-medium-emphasis">x</span>
          <v-text-field
            :model-value="gridY"
            type="number"
            min="1"
            step="1"
            label="Depth"
            density="comfortable"
            hide-details
            @update:model-value="store.setGridY(Number($event))"
          />
          <span class="text-medium-emphasis">x</span>
          <v-text-field
            v-model.number="heightUnits"
            type="number"
            min="2"
            step="0.5"
            label="Height"
            density="comfortable"
            hide-details
          />
        </div>
        <div v-if="heightMm !== null" class="text-caption text-medium-emphasis mt-1">
          {{ heightMm }} mm overall
        </div>
      </template>
      <v-text-field
        v-else
        ref="gridXField"
        v-model.number="gridX"
        type="number"
        min="1"
        step="1"
        label="Insert width (grid cells of 42 mm)"
        density="comfortable"
        hide-details
        class="mt-4"
      />
      <LabelIconField
        v-if="store.hasLabel"
        v-model:text="labelText"
        v-model:icon="labelIcon"
        class="mt-4"
      />

      <DividerControl v-if="!insertOnly" class="mt-4" />

      <MoreOptions
        per-bin-fields
        :insert-only="insertOnly"
        :quantity="quantity"
        @update:quantity="quantity = $event"
      />

      <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
        {{ errorMessage }}
      </v-alert>
      <v-alert v-if="saveError" type="error" class="mt-4" density="compact">
        {{ saveError }}
      </v-alert>

      <v-alert
        v-if="downloadWarnings.length > 0"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-4"
      >
        <p v-for="warning in downloadWarnings" :key="warning" class="mb-1">{{ warning }}</p>
      </v-alert>

      <div class="d-flex ga-2 mt-4">
        <AddToQueueSplitButton
          class="flex-grow-1"
          :editing="editingEntry !== null"
          @add="saveEntry"
          @add-to-plate="addToPlate"
          @download="downloadDesign"
        />
        <v-btn
          v-if="editingEntry !== null"
          variant="outlined"
          size="large"
          @click="cancelEdit"
        >
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
        <BinViewport
          v-if="previewLoaded"
          :mesh="meshes?.body ?? null"
          :label="meshes?.label ?? null"
        />
        <div
          v-else
          class="d-flex flex-column align-center justify-center text-center fill-height pa-8"
        >
          <v-icon icon="mdi-cube-outline" size="64" class="mb-4 text-medium-emphasis" />
          <p class="text-body-2 text-medium-emphasis mb-4">
            The 3D preview is paused on small screens.
          </p>
          <v-btn color="primary" variant="tonal" @click="previewLoaded = true">
            Load preview
          </v-btn>
        </div>
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.preview-card {
  min-height: 320px;
}
</style>
