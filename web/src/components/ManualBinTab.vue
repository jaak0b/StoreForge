<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import { useBinPreview } from '../composables/useBinPreview';
import { generateInsert, generateSlottedBin } from '../workerClient';
import type { PartMeshes, SlottedBinParams } from '../engine/gridfinity/types';
import { originOf, type Product, type QueueEntry } from '../engine/plan/types';
import { describeProduct } from '../engine/plan/rowDescriptor';
import BinViewport from './BinViewport.vue';
import LabelIconField from './LabelIconField.vue';
import ProductSelect from './ProductSelect.vue';
import MoreOptions from './MoreOptions.vue';

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

const quantity = ref(1);
const gridXField = ref<{ focus: () => void } | null>(null);

const insertOnly = computed(() => productChoice.value === 'insert');

function resetForm(): void {
  const keepOpen = store.moreOptionsOpen;
  store.$reset();
  store.moreOptionsOpen = keepOpen;
  quantity.value = 1;
}

/** Loads the entry being edited into the form; null resets to a new design. */
function loadEditingEntry(entryId: string | null): void {
  if (entryId === null) {
    resetForm();
    return;
  }
  const entry = queue.entryById(entryId);
  if (entry === null || originOf(entry.product) !== 'manual') return;
  const product = entry.product;
  if (product.kind === 'insert') {
    store.$patch({
      productChoice: 'insert',
      gridX: product.cells,
      labelText: product.content.text,
      labelText2: product.content.text2,
      labelIcon: product.content.icon,
      notes: entry.notes ?? '',
    });
  } else {
    const bin = product.bin;
    if (bin.origin !== 'manual') return;
    const content = product.kind === 'binWithInsert' ? product.insert : null;
    store.$patch({
      productChoice:
        product.kind === 'binWithInsert' ? 'binWithInsert' : product.labelSlot ? 'bin' : 'plainBin',
      fused: product.kind === 'binWithInsert' ? product.fused ?? false : false,
      gridX: bin.gridX,
      gridY: bin.gridY,
      heightUnits: bin.heightUnits,
      magnetHoles: bin.magnetHoles,
      dividerCountX: bin.dividerCountX,
      dividerCountY: bin.dividerCountY,
      labelText: content?.text ?? '',
      labelText2: content?.text2 ?? '',
      labelIcon: content?.icon ?? null,
      notes: entry.notes ?? '',
    });
  }
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

/** The product the form currently designs. */
function designedProduct(): Product {
  if (insertOnly.value) {
    return {
      kind: 'insert',
      origin: 'manual',
      cells: store.gridX,
      content: store.content,
    };
  }
  const bin = {
    origin: 'manual' as const,
    gridX: store.gridX,
    gridY: store.gridY,
    heightUnits: store.heightUnits,
    magnetHoles: store.magnetHoles,
    dividerCountX: store.dividerCountX,
    dividerCountY: store.dividerCountY,
  };
  if (productChoice.value === 'binWithInsert') {
    const product: Product = { kind: 'binWithInsert', bin, insert: store.content };
    if (store.fused) product.fused = true;
    return product;
  }
  return { kind: 'bin', bin, labelSlot: productChoice.value !== 'plainBin' };
}

function saveEntry(): void {
  const cleanNotes = notes.value.trim();
  const product = designedProduct();
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

function editingTitle(entry: QueueEntry): string {
  return describeProduct(entry.product).title;
}

/** Everything the preview depends on, regenerated on any change. */
interface PreviewSpec {
  insertOnly: boolean;
  bin: SlottedBinParams;
  cells: number;
  content: { text: string; text2: string; icon: string | null };
}

const previewSpec = computed<PreviewSpec>(() => ({
  insertOnly: insertOnly.value,
  bin: store.binParams,
  cells: store.gridX,
  content: store.content,
}));

function generatePreview(spec: PreviewSpec): Promise<PartMeshes> {
  if (spec.insertOnly) {
    return generateInsert({ cells: spec.cells, content: spec.content });
  }
  return generateSlottedBin(spec.bin);
}

const { meshes, errorMessage } = useBinPreview(() => previewSpec.value, generatePreview);
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
            v-model.number="gridX"
            type="number"
            min="1"
            step="1"
            label="Width"
            density="comfortable"
            hide-details
          />
          <span class="text-medium-emphasis">x</span>
          <v-text-field
            v-model.number="gridY"
            type="number"
            min="1"
            step="1"
            label="Depth"
            density="comfortable"
            hide-details
          />
          <span class="text-medium-emphasis">x</span>
          <v-text-field
            v-model.number="heightUnits"
            type="number"
            min="2"
            step="1"
            label="Height"
            density="comfortable"
            hide-details
          />
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

      <MoreOptions
        per-bin-fields
        :insert-only="insertOnly"
        :quantity="quantity"
        @update:quantity="quantity = $event"
      />

      <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
        {{ errorMessage }}
      </v-alert>

      <div class="d-flex ga-2 mt-4">
        <v-btn color="primary" variant="flat" size="large" class="flex-grow-1" @click="saveEntry">
          {{ editingEntry !== null ? 'Save changes' : 'Add to queue' }}
        </v-btn>
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
