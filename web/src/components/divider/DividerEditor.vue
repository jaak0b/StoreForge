<script setup lang="ts">
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../../stores/binDesigner';
import DividerCanvas from './DividerCanvas.vue';

/**
 * The divider wall section of the More options disclosure: the top-down
 * editor with its toolbar, plus the even-dividers quick entry that generates
 * a regular grid of walls. The quick entry is a generator only: applying it
 * replaces the wall list, which then stays freely editable on the canvas.
 */

const store = useBinDesigner();
const { walls, selectedWallIndex } = storeToRefs(store);

const evenCountX = ref(0);
const evenCountY = ref(0);

function applyEvenDividers(): void {
  store.applyEvenDividers(Math.max(0, Math.floor(evenCountX.value || 0)),
    Math.max(0, Math.floor(evenCountY.value || 0)));
}
</script>

<template>
  <div>
    <div class="text-caption text-medium-emphasis mb-1">
      Divider walls (drag on the bin interior to draw a wall, drag a wall to move it, and drag an
      endpoint handle to change its length and angle)
    </div>
    <div class="d-flex align-center ga-1 mb-2">
      <v-tooltip text="Add a divider wall" location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-plus"
            variant="text"
            density="comfortable"
            @click="store.addWall()"
          />
        </template>
      </v-tooltip>
      <v-tooltip text="Duplicate the selected wall" location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-content-duplicate"
            variant="text"
            density="comfortable"
            :disabled="selectedWallIndex === null"
            @click="store.duplicateWall(selectedWallIndex!)"
          />
        </template>
      </v-tooltip>
      <v-tooltip text="Delete the selected wall" location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-delete-outline"
            variant="text"
            density="comfortable"
            :disabled="selectedWallIndex === null"
            @click="store.deleteWall(selectedWallIndex!)"
          />
        </template>
      </v-tooltip>
      <span class="text-caption text-medium-emphasis ml-2">
        {{ walls.length }} wall{{ walls.length === 1 ? '' : 's' }}
      </span>
    </div>

    <DividerCanvas />

    <div class="text-caption text-medium-emphasis mt-3 mb-1">
      Evenly spaced walls (applying replaces the walls above)
    </div>
    <div class="d-flex align-center ga-2">
      <v-text-field
        v-model.number="evenCountX"
        type="number"
        min="0"
        step="1"
        label="Dividers along X"
        density="comfortable"
        hide-details
      />
      <v-text-field
        v-model.number="evenCountY"
        type="number"
        min="0"
        step="1"
        label="Dividers along Y"
        density="comfortable"
        hide-details
      />
      <v-btn variant="outlined" density="comfortable" @click="applyEvenDividers">Apply</v-btn>
    </div>
  </div>
</template>
