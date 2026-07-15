<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../stores/binDesigner';
import { generateLabeledBin, generateLabeledBinUnion } from '../workerClient';
import { meshToStlBlob } from '../engine/gridfinity/stlExport';
import { LABEL_ICONS } from '../engine/label/icons';
import type { LabeledBinMeshes } from '../engine/gridfinity/types';
import BinViewport from './BinViewport.vue';

const store = useBinDesigner();
const { gridX, gridY, heightUnits, stackingLip, magnetHoles, labelText, labelIcon } =
  storeToRefs(store);

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
  [gridX, gridY, heightUnits, stackingLip, magnetHoles, labelText, labelIcon],
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
          <v-card-title>Bin Designer</v-card-title>
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
            <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
              {{ errorMessage }}
            </v-alert>
          </v-card-text>
          <v-card-actions>
            <v-btn
              color="primary"
              variant="flat"
              block
              :disabled="!meshes || generating || downloading"
              :loading="downloading"
              @click="downloadStl"
            >
              Download STL
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
      <v-col cols="12" md="8" lg="9">
        <v-card class="fill-height">
          <BinViewport :mesh="meshes?.body ?? null" :label="meshes?.label ?? null" />
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
