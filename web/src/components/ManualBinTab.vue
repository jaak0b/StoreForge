<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import { useBinPreview } from '../composables/useBinPreview';
import BinViewport from './BinViewport.vue';
import LabelIconField from './LabelIconField.vue';
import LabelModeSelect from './LabelModeSelect.vue';
import MoreOptions from './MoreOptions.vue';

/**
 * The Manual bin tab of the add-bin card: the bin designer form with a live
 * preview beside it. Designs a new queue entry, or edits an existing one
 * when the app store carries an editing id.
 */

const app = useApp();
const store = useBinDesigner();
const queue = useBinQueue();
const { smAndDown } = useDisplay();

// The 3D preview is heavy; on small screens it starts paused and loads on
// demand. Once loaded it stays loaded. Mesh generation itself keeps running
// regardless, so downloads stay available.
const previewLoaded = ref(!smAndDown.value);

const { gridX, gridY, heightUnits, labelText, labelIcon, labelMode, notes } = storeToRefs(store);

const quantity = ref(1);
const gridXField = ref<{ focus: () => void } | null>(null);

function resetForm(): void {
  const keepOpen = store.moreOptionsOpen;
  store.$reset();
  store.moreOptionsOpen = keepOpen;
  quantity.value = 1;
}

/** Loads the entry being edited into the form; null resets to a new bin. */
function loadEditingEntry(entryId: string | null): void {
  if (entryId === null) {
    resetForm();
    return;
  }
  const entry = queue.entryById(entryId);
  if (entry === null || entry.kind !== 'manual') return;
  store.$patch({
    gridX: entry.gridX,
    gridY: entry.gridY,
    heightUnits: entry.heightUnits,
    stackingLip: entry.stackingLip,
    magnetHoles: entry.magnetHoles,
    dividerCountX: entry.dividerCountX,
    dividerCountY: entry.dividerCountY,
    labelText: entry.labelText,
    labelText2: entry.labelText2,
    labelIcon: entry.labelIcon,
    labelMode: entry.labelMode ?? 'embossed',
    notes: entry.notes ?? '',
  });
  quantity.value = entry.quantity;
  if (entry.labelText2 !== '' || entry.notes !== undefined || entry.quantity > 1) {
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

// Ctrl+N: reset to a new bin and focus the first size field.
watch(
  () => app.focusAddSeq,
  () => {
    if (app.editingEntryId === null) resetForm();
    gridXField.value?.focus();
  },
);

const editingEntry = computed(() => {
  if (app.editingKind !== 'manual' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && entry.kind === 'manual' ? entry : null;
});

function saveEntry(): void {
  const cleanNotes = notes.value.trim();
  if (editingEntry.value !== null) {
    queue.update(editingEntry.value.id, {
      ...store.params,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    app.stopEditing();
  } else {
    const id = queue.add(store.params, quantity.value);
    if (cleanNotes !== '') queue.update(id, { notes: cleanNotes });
  }
  resetForm();
}

function cancelEdit(): void {
  app.stopEditing();
  resetForm();
}

function entrySize(gx: number, gy: number, hu: number): string {
  return `${gx} x ${gy} x ${hu}`;
}

const { meshes, errorMessage } = useBinPreview(() => store.params);
</script>

<template>
  <v-row>
    <v-col cols="12" md="6">
      <div class="text-caption text-medium-emphasis mb-1">
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
      <LabelIconField v-model:text="labelText" v-model:icon="labelIcon" class="mt-4" />
      <LabelModeSelect v-model="labelMode" class="mt-4" />

      <MoreOptions per-bin-fields :quantity="quantity" @update:quantity="quantity = $event" />

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
        Editing "{{ editingEntry.labelText !== '' ? editingEntry.labelText : entrySize(editingEntry.gridX, editingEntry.gridY, editingEntry.heightUnits) }}"; saving updates the queue row.
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
