<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../../stores/binDesigner';
import type { DividerMode } from '../../stores/binDesigner';
import DividerEditor from './DividerEditor.vue';

/**
 * The always-visible divider control shared by the Manual bin and Screw entry
 * tabs: a segmented None / Grid / Custom mode selector, above the More options
 * expander. Grid shows the two count fields and a live compartment readout and
 * applies immediately; Custom shows the full free-angle wall editor. The mode
 * and its wall generation live in the binDesigner store, the single home both
 * tabs share, so neither tab reimplements the spacing math.
 *
 * A caller whose bin footprint is not a single known size passes a notice
 * string, shown in place of the count fields and editor, because a wall list is
 * authored against one interior and means nothing without it.
 */

const props = defineProps<{
  /** Why the Grid and Custom editors are unavailable, shown in their place. */
  notice?: string | null;
}>();

const store = useBinDesigner();
const { dividerMode, dividerCountX, dividerCountY } = storeToRefs(store);

const mode = computed({
  get: () => dividerMode.value,
  set: (value: DividerMode) => store.setDividerMode(value),
});

const countX = computed({
  get: () => dividerCountX.value,
  set: (value: number) => store.setDividerCount('x', value),
});

const countY = computed({
  get: () => dividerCountY.value,
  set: (value: number) => store.setDividerCount('y', value),
});

/** Compartments a grid of the current counts divides the bin into. */
const compartmentCount = computed(
  () => (dividerCountX.value + 1) * (dividerCountY.value + 1),
);
</script>

<template>
  <div>
    <div class="text-caption text-medium-emphasis mb-1">Dividers</div>
    <v-btn-toggle v-model="mode" mandatory density="comfortable" variant="outlined">
      <v-btn value="none">None</v-btn>
      <v-btn value="grid">Grid</v-btn>
      <v-btn value="custom">Custom</v-btn>
    </v-btn-toggle>

    <div v-if="props.notice && mode !== 'none'" class="text-caption text-medium-emphasis mt-3">
      {{ props.notice }}
    </div>

    <template v-else-if="mode === 'grid'">
      <div class="d-flex align-center ga-2 mt-3">
        <v-text-field
          v-model.number="countX"
          type="number"
          min="0"
          step="1"
          label="Dividers along X"
          density="comfortable"
          hide-details
        />
        <v-text-field
          v-model.number="countY"
          type="number"
          min="0"
          step="1"
          label="Dividers along Y"
          density="comfortable"
          hide-details
        />
      </div>
      <div class="readout mt-2 text-caption text-medium-emphasis">
        <span>Compartments</span><span>{{ compartmentCount }}</span>
      </div>
    </template>

    <DividerEditor v-else-if="mode === 'custom'" class="mt-3" />
  </div>
</template>

<style scoped>
.readout {
  display: grid;
  grid-template-columns: max-content max-content;
  gap: 0 16px;
}
</style>
