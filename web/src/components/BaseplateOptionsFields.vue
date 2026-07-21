<script setup lang="ts">
import {
  MAGNET_DIAMETER_MAX,
  MAGNET_DIAMETER_MIN,
  MAGNET_HEIGHT_MAX,
  MAGNET_HEIGHT_MIN,
} from '../engine/baseplate/constants';
import type { HoleMode } from '../stores/baseplateDesigner';

/**
 * The baseplate hardware controls shared between the Baseplate tab and the
 * drawer view: base magnets (with their diameter and height sliders), screw
 * holes, and the connectable switch. Two-way bound through defineModel so each
 * consumer supplies its own backing state (the tab's form store, or the drawer
 * view's local options), keeping one copy of the controls' markup and wording.
 */

const magnetMode = defineModel<HoleMode>('magnetMode', { required: true });
const magnetDiameterMm = defineModel<number>('magnetDiameterMm', { required: true });
const magnetHeightMm = defineModel<number>('magnetHeightMm', { required: true });
const screwHoleMode = defineModel<HoleMode>('screwHoleMode', { required: true });
const connectable = defineModel<boolean>('connectable', { required: true });
</script>

<template>
  <div>
    <div class="text-caption text-medium-emphasis mb-1">Base magnets</div>
    <v-btn-toggle v-model="magnetMode" mandatory density="comfortable" variant="outlined">
      <v-btn value="none">None</v-btn>
      <v-btn value="full">Full</v-btn>
    </v-btn-toggle>
    <v-expand-transition>
      <div v-if="magnetMode === 'full'" class="mt-6">
        <v-slider
          v-model="magnetDiameterMm"
          :min="MAGNET_DIAMETER_MIN"
          :max="MAGNET_DIAMETER_MAX"
          step="0.1"
          thumb-label="always"
          label="Magnet diameter (mm)"
          hide-details
        >
          <template #append>
            <v-text-field
              v-model.number="magnetDiameterMm"
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
          v-model="magnetHeightMm"
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
              v-model.number="magnetHeightMm"
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
    <v-btn-toggle v-model="screwHoleMode" mandatory density="comfortable" variant="outlined">
      <v-btn value="none">None</v-btn>
      <v-btn value="full">Full</v-btn>
    </v-btn-toggle>

    <v-switch
      v-model="connectable"
      label="Connectable"
      color="primary"
      density="compact"
      hide-details
      class="mt-2"
    />
  </div>
</template>
