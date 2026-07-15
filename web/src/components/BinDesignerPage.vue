<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import { useBinTemplates } from '../stores/binTemplates';
import { useApp } from '../stores/app';
import { generateLabeledBin, generateLabeledBinUnion } from '../workerClient';
import { meshToStlBlob } from '../engine/gridfinity/stlExport';
import { PITCH, WALL_THICKNESS } from '../engine/gridfinity/constants';
import { LABEL_ICONS } from '../engine/label/icons';
import type { LabeledBinMeshes, LabeledBinParams } from '../engine/gridfinity/types';
import BinViewport from './BinViewport.vue';
import FootprintThumb from './FootprintThumb.vue';

const store = useBinDesigner();
const queue = useBinQueue();
const templates = useBinTemplates();
const app = useApp();
const { smAndDown } = useDisplay();

// The 3D preview is heavy; on small screens it starts paused and loads on
// demand. Once loaded it stays loaded. Mesh generation itself keeps running
// regardless, so the STL download is always available.
const previewLoaded = ref(!smAndDown.value);

const quantity = ref(1);
const notes = ref('');
const editingId = app.editingEntryId;
if (editingId !== null) {
  const entry = queue.entryById(editingId);
  if (entry !== null) {
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
      labelIcon: entry.labelIcon,
    });
    quantity.value = entry.quantity;
    notes.value = entry.notes ?? '';
  }
}

function saveEntry(): void {
  if (editingId !== null && queue.entryById(editingId) !== null) {
    queue.update(editingId, {
      ...store.params,
      quantity: quantity.value,
      notes: notes.value === '' ? undefined : notes.value,
    });
  } else {
    const id = queue.add(store.params, quantity.value);
    if (notes.value !== '') queue.update(id, { notes: notes.value });
  }
  app.showQueue();
}
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
  labelIcon,
} = storeToRefs(store);

// Dividers can be entered as a count or as a target spacing. Spacing is a
// UI convenience only: it is converted to a stored count on input, so the
// count stays the single persisted representation.
const dividerMode = ref<'count' | 'spacing'>('count');
const spacingX = ref<number | null>(null);
const spacingY = ref<number | null>(null);

const interiorWidth = computed(() => gridX.value * PITCH - 0.5 - 2 * WALL_THICKNESS);
const interiorDepth = computed(() => gridY.value * PITCH - 0.5 - 2 * WALL_THICKNESS);

function countFromSpacing(interiorMm: number, spacing: number | null): number {
  if (spacing === null || !Number.isFinite(spacing) || spacing <= 0) return 0;
  return Math.max(0, Math.round(interiorMm / spacing) - 1);
}

function applySpacingX(): void {
  dividerCountX.value = countFromSpacing(interiorWidth.value, spacingX.value);
}

function applySpacingY(): void {
  dividerCountY.value = countFromSpacing(interiorDepth.value, spacingY.value);
}

function spacingCaption(count: number, interiorMm: number): string {
  const effective = (interiorMm / (count + 1)).toFixed(1);
  const noun = count === 1 ? 'divider' : 'dividers';
  return `${count} ${noun} (effective spacing ${effective} mm)`;
}

// Templates: save the current parameters under a name, or load a saved set.
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

const meshes = ref<LabeledBinMeshes | null>(null);
const generating = ref(false);
const downloading = ref(false);
const errorMessage = ref<string | null>(null);

const iconChoices = computed(() => [
  { title: 'No icon', value: null as string | null },
  ...LABEL_ICONS.map((icon) => ({ title: icon.name, value: icon.name as string | null })),
]);

let debounceHandle: ReturnType<typeof setTimeout> | null = null;
let generationCounter = 0;

async function regenerate(): Promise<void> {
  const ticket = ++generationCounter;
  generating.value = true;
  errorMessage.value = null;
  try {
    const result = await generateLabeledBin(store.params);
    if (ticket === generationCounter) {
      meshes.value = result;
    }
  } catch (error) {
    if (ticket === generationCounter) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Bin generation failed.';
    }
  } finally {
    if (ticket === generationCounter) {
      generating.value = false;
    }
  }
}

function scheduleRegenerate(): void {
  if (debounceHandle !== null) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    void regenerate();
  }, 300);
}

watch(
  [
    gridX,
    gridY,
    heightUnits,
    stackingLip,
    magnetHoles,
    dividerCountX,
    dividerCountY,
    perforatedBase,
    labelText,
    labelIcon,
  ],
  scheduleRegenerate,
);
onMounted(() => void regenerate());

async function downloadStl(): Promise<void> {
  downloading.value = true;
  errorMessage.value = null;
  try {
    const mesh = await generateLabeledBinUnion(store.params);
    const blob = meshToStlBlob(mesh);
    const name = `gridfinity_bin_${gridX.value}x${gridY.value}x${heightUnits.value}.stl`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'STL export failed.';
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <v-container fluid class="fill-height align-start">
    <v-row class="fill-height">
      <v-col cols="12" md="4" lg="3">
        <v-card>
          <v-card-title class="d-flex align-center">
            Bin Designer
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
          </v-card-title>
          <v-card-text>
            <p class="text-body-2 mb-4">
              Design a standard Gridfinity bin. Sizes are given in grid units of
              42 mm and height units of 7 mm.
            </p>
            <v-text-field
              v-model.number="gridX"
              type="number"
              min="1"
              step="1"
              label="Width in grid units"
              density="comfortable"
            />
            <v-text-field
              v-model.number="gridY"
              type="number"
              min="1"
              step="1"
              label="Depth in grid units"
              density="comfortable"
            />
            <v-text-field
              v-model.number="heightUnits"
              type="number"
              min="2"
              step="1"
              label="Height in 7 mm units"
              density="comfortable"
            />
            <v-switch
              v-model="stackingLip"
              color="primary"
              label="Stacking lip"
              hint="The lip on top of the walls lets another bin stack securely on this one."
              persistent-hint
            />
            <v-switch
              v-model="magnetHoles"
              color="primary"
              label="Magnet holes"
              hint="Each foot gets four 6.5 mm holes for 6 x 2 mm magnets, so the bin holds onto a magnetic baseplate."
              persistent-hint
            />
            <v-switch
              v-model="perforatedBase"
              color="primary"
              label="Perforated floor"
              hint="The bin floor is cut away in a grid pattern instead of solid, saving filament and letting spilled contents and debris fall through."
              persistent-hint
            />
            <div class="text-subtitle-2 mt-4">Dividers</div>
            <p class="text-body-2 text-medium-emphasis mb-2">
              Dividers split the bin's interior into equal compartments along
              each axis; add none for a single open interior.
            </p>
            <v-btn-toggle
              v-model="dividerMode"
              density="comfortable"
              divided
              mandatory
              class="mb-3"
            >
              <v-btn value="count" size="small">By count</v-btn>
              <v-btn value="spacing" size="small">By spacing</v-btn>
            </v-btn-toggle>
            <template v-if="dividerMode === 'count'">
              <v-text-field
                v-model.number="dividerCountX"
                type="number"
                min="0"
                step="1"
                label="Dividers along X"
                density="comfortable"
              />
              <v-text-field
                v-model.number="dividerCountY"
                type="number"
                min="0"
                step="1"
                label="Dividers along Y"
                density="comfortable"
              />
            </template>
            <template v-else>
              <v-text-field
                v-model.number="spacingX"
                type="number"
                min="1"
                label="Spacing along X (mm)"
                density="comfortable"
                :hint="spacingCaption(dividerCountX, interiorWidth)"
                persistent-hint
                @update:model-value="applySpacingX"
              />
              <v-text-field
                v-model.number="spacingY"
                type="number"
                min="1"
                label="Spacing along Y (mm)"
                density="comfortable"
                :hint="spacingCaption(dividerCountY, interiorDepth)"
                persistent-hint
                @update:model-value="applySpacingY"
              />
            </template>
            <v-text-field
              v-model="labelText"
              label="Label text"
              density="comfortable"
              class="mt-2"
              hint="The label is embossed on a shelf at the top front edge of the bin, raised 0.6 mm, so it reads from above. Long text is shrunk to fit the bin width."
              persistent-hint
            />
            <v-select
              v-model="labelIcon"
              :items="iconChoices"
              label="Label icon"
              density="comfortable"
              class="mt-4"
              hint="The icon is embossed on the shelf to the left of the label text."
              persistent-hint
            />
            <v-text-field
              v-model.number="quantity"
              type="number"
              min="1"
              step="1"
              label="Quantity"
              density="comfortable"
              class="mt-2"
              hint="How many copies of this bin the print plan calls for."
              persistent-hint
            />
            <v-textarea
              v-model="notes"
              label="Notes"
              density="comfortable"
              rows="2"
              class="mt-4"
              auto-grow
            />
            <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
              {{ errorMessage }}
            </v-alert>
          </v-card-text>
          <v-card-actions class="flex-column align-stretch">
            <v-btn color="primary" variant="flat" block @click="saveEntry">
              {{ editingId !== null ? 'Save changes' : 'Add to queue' }}
            </v-btn>
            <v-btn
              variant="outlined"
              block
              class="mt-2 ml-0"
              :disabled="!meshes || generating || downloading"
              :loading="downloading"
              @click="downloadStl"
            >
              Download STL
            </v-btn>
            <v-btn
              variant="text"
              block
              class="mt-2 ml-0"
              prepend-icon="mdi-content-save-outline"
              @click="openSaveTemplate"
            >
              Save as template
            </v-btn>
            <v-btn variant="text" block class="mt-2 ml-0" @click="app.showQueue()">
              Cancel
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
      <v-col cols="12" md="8" lg="9">
        <v-card class="fill-height">
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
              The 3D preview is paused on this screen size to save battery and data.
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
  </v-container>
</template>
