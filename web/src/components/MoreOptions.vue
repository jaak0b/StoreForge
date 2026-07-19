<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../stores/binDesigner';

/**
 * The "More options" disclosure shared by the Manual bin and Screw entry
 * tabs of the add-bin card. State binds to the binDesigner Pinia store so
 * values persist across tab switches. Second label line and quantity are
 * per-bin-only fields that do not apply to a screw entry (which always adds
 * a set count of identical bins), so the caller hides them with perBinFields.
 * The second label line additionally follows the store's label-visibility
 * getter, so it disappears for products without a label.
 */

const props = defineProps<{
  perBinFields: boolean;
  quantity?: number;
  /** Hides the divider fields; a pocket bin cannot have divider walls. */
  hideDividers?: boolean;
  /**
   * Hides every bin body option (dividers, magnet holes); an
   * insert-only design has no bin body to configure.
   */
  insertOnly?: boolean;
}>();

const emit = defineEmits<{
  'update:quantity': [value: number];
}>();

const store = useBinDesigner();
const { labelText2, dividerCountX, dividerCountY, magnetHoles, notes, moreOptionsOpen: open } =
  storeToRefs(store);
</script>

<template>
  <v-btn
    variant="text"
    size="small"
    class="mt-4 px-2"
    :prepend-icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'"
    @click="open = !open"
  >
    More options
  </v-btn>
  <v-expand-transition>
    <div v-if="open" class="mt-3">
      <v-text-field
        v-if="props.perBinFields && store.hasLabel"
        v-model="labelText2"
        label="Second label line"
        density="comfortable"
        hide-details
      />
      <div class="options-grid mt-3">
        <v-text-field
          v-if="props.perBinFields"
          :model-value="props.quantity"
          type="number"
          min="1"
          step="1"
          label="Quantity"
          density="comfortable"
          hide-details
          @update:model-value="emit('update:quantity', Number($event))"
        />
        <v-text-field
          v-if="!props.hideDividers && !props.insertOnly"
          v-model.number="dividerCountX"
          type="number"
          min="0"
          step="1"
          label="Dividers along X"
          density="comfortable"
          hide-details
        />
        <v-text-field
          v-if="!props.hideDividers && !props.insertOnly"
          v-model.number="dividerCountY"
          type="number"
          min="0"
          step="1"
          label="Dividers along Y"
          density="comfortable"
          hide-details
        />
      </div>
      <div v-if="!props.insertOnly" class="mt-3">
        <v-switch
          v-model="magnetHoles"
          color="primary"
          density="compact"
          hide-details
          label="Magnet holes"
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
    </div>
  </v-expand-transition>
</template>

<style scoped>
.options-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 12px;
}
</style>
