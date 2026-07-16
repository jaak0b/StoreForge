<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import { useBinTemplates } from '../stores/binTemplates';
import { useBinPreview } from '../composables/useBinPreview';
import type { LabeledBinParams } from '../engine/gridfinity/types';
import BinViewport from './BinViewport.vue';
import FootprintThumb from './FootprintThumb.vue';
import IconPicker from './IconPicker.vue';

/**
 * The Manual bin tab of the add-bin card: the bin designer form with a live
 * preview beside it. Designs a new queue entry, or edits an existing one
 * when the app store carries an editing id.
 */

const app = useApp();
const store = useBinDesigner();
const queue = useBinQueue();
const templates = useBinTemplates();
const { smAndDown } = useDisplay();

// The 3D preview is heavy; on small screens it starts paused and loads on
// demand. Once loaded it stays loaded. Mesh generation itself keeps running
// regardless, so downloads stay available.
const previewLoaded = ref(!smAndDown.value);

const {
  gridX,
  gridY,
  heightUnits,
  stackingLip,
  magnetHoles,
  dividerCountX,
  dividerCountY,
  perforatedBase,
  labelText,
  labelText2,
  labelIcon,
} = storeToRefs(store);

const quantity = ref(1);
const notes = ref('');
const moreOptionsOpen = ref(false);
const gridXField = ref<{ focus: () => void } | null>(null);

function resetForm(): void {
  store.$reset();
  quantity.value = 1;
  notes.value = '';
}

/** Loads the entry being edited into the form; null resets to a new bin. */
function loadEditingEntry(entryId: string | null): void {
  if (entryId === null) {
    resetForm();
    return;
  }
  const entry = queue.entryById(entryId);
  if (entry === null) return;
  store.$patch({
    gridX: entry.gridX,
    gridY: entry.gridY,
    heightUnits: entry.heightUnits,
    stackingLip: entry.stackingLip,
    magnetHoles: entry.magnetHoles,
    dividerCountX: entry.dividerCountX,
    dividerCountY: entry.dividerCountY,
    perforatedBase: entry.perforatedBase,
    labelText: entry.labelText,
    labelText2: entry.labelText2,
    labelIcon: entry.labelIcon,
  });
  quantity.value = entry.quantity;
  notes.value = entry.notes ?? '';
  if (entry.labelText2 !== '' || entry.notes !== undefined || entry.quantity > 1) {
    moreOptionsOpen.value = true;
  }
}

watch(() => app.editingEntryId, loadEditingEntry, { immediate: true });

// Ctrl+N: reset to a new bin and focus the first size field.
watch(
  () => app.focusAddSeq,
  () => {
    if (app.editingEntryId === null) resetForm();
    gridXField.value?.focus();
  },
);

const editingEntry = computed(() =>
  app.editingEntryId !== null ? queue.entryById(app.editingEntryId) : null,
);

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

// Templates: save the current parameters under a name, or apply a saved set.
const saveTemplateOpen = ref(false);
const templateName = ref('');

function openSaveTemplate(): void {
  templateName.value =
    labelText.value !== ''
      ? labelText.value
      : `${gridX.value} x ${gridY.value} x ${heightUnits.value}`;
  saveTemplateOpen.value = true;
}

function saveTemplate(): void {
  const name = templateName.value.trim();
  if (name === '') return;
  templates.save(name, store.params);
  saveTemplateOpen.value = false;
}

function templateSize(params: LabeledBinParams): string {
  return `${params.gridX} x ${params.gridY} x ${params.heightUnits}`;
}

function applyTemplate(id: string): void {
  const params = templates.apply(id);
  if (params === null) return;
  store.$patch(params);
}

const { meshes, errorMessage } = useBinPreview(() => store.params);
</script>

<template>
  <v-row>
    <v-col cols="12" md="6">
      <div class="d-flex align-center mb-1">
        <div class="text-caption text-medium-emphasis">
          Bin size (grid units of 42 mm; height units of 7 mm)
        </div>
        <v-spacer />
        <v-menu v-if="templates.templates.length > 0">
          <template #activator="{ props: menuProps }">
            <v-btn
              variant="text"
              size="small"
              prepend-icon="mdi-view-grid-outline"
              v-bind="menuProps"
            >
              From template
            </v-btn>
          </template>
          <v-list density="comfortable" max-height="320" class="overflow-y-auto">
            <v-list-item
              v-for="template in templates.templates"
              :key="template.id"
              :title="template.name"
              :subtitle="templateSize(template.params)"
              @click="applyTemplate(template.id)"
            >
              <template #prepend>
                <FootprintThumb
                  class="mr-3"
                  :grid-x="template.params.gridX"
                  :grid-y="template.params.gridY"
                  :label-icon="template.params.labelIcon"
                />
              </template>
            </v-list-item>
          </v-list>
        </v-menu>
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
      <v-text-field
        v-model="labelText"
        label="Label"
        placeholder="What's inside?"
        density="comfortable"
        class="mt-4"
        hint="Embossed on the label shelf; long text shrinks to fit."
      />
      <div class="text-caption text-medium-emphasis mt-2 mb-1">Label icon</div>
      <IconPicker v-model="labelIcon" />

      <v-btn
        variant="text"
        size="small"
        class="mt-4 px-2"
        :prepend-icon="moreOptionsOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        @click="moreOptionsOpen = !moreOptionsOpen"
      >
        More options
      </v-btn>
      <v-expand-transition>
        <div v-if="moreOptionsOpen" class="mt-3">
          <v-text-field
            v-model="labelText2"
            label="Second label line"
            density="comfortable"
            hide-details
          />
          <div class="options-grid mt-3">
            <v-text-field
              v-model.number="quantity"
              type="number"
              min="1"
              step="1"
              label="Quantity"
              density="comfortable"
              hide-details
            />
            <v-text-field
              v-model.number="dividerCountX"
              type="number"
              min="0"
              step="1"
              label="Dividers along X"
              density="comfortable"
              hide-details
            />
            <v-text-field
              v-model.number="dividerCountY"
              type="number"
              min="0"
              step="1"
              label="Dividers along Y"
              density="comfortable"
              hide-details
            />
          </div>
          <div class="options-grid mt-3">
            <v-switch
              v-model="stackingLip"
              color="primary"
              density="compact"
              hide-details
              label="Stacking lip"
            />
            <v-switch
              v-model="magnetHoles"
              color="primary"
              density="compact"
              hide-details
              label="Magnet holes"
            />
            <v-switch
              v-model="perforatedBase"
              color="primary"
              density="compact"
              hide-details
              label="Perforated floor"
            />
          </div>
          <v-textarea
            v-model="notes"
            label="Notes"
            density="comfortable"
            rows="2"
            class="mt-2"
            auto-grow
            hide-details
          />
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-content-save-outline"
            class="mt-2"
            @click="openSaveTemplate"
          >
            Save as template
          </v-btn>
        </div>
      </v-expand-transition>

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
        Editing "{{ editingEntry.labelText !== '' ? editingEntry.labelText : templateSize(editingEntry) }}"; saving updates the queue row.
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

  <v-dialog v-model="saveTemplateOpen" max-width="400">
    <v-card>
      <v-card-title>Save as template</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="templateName"
          label="Template name"
          density="comfortable"
          autofocus
          hide-details
          @keydown.enter.prevent="saveTemplate"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="saveTemplateOpen = false">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="templateName.trim() === ''"
          @click="saveTemplate"
        >
          Save
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.options-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 12px;
}

.preview-card {
  min-height: 320px;
  height: 100%;
}
</style>
