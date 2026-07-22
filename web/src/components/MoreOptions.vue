<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useBinDesigner } from '../stores/binDesigner';

/**
 * The "More options" disclosure shared by the Manual bin, Screw entry and
 * Baseplate tabs of the add-bin card. Bin state binds to the binDesigner
 * Pinia store so values persist across tab switches. Second label line and
 * quantity are per-bin-only fields that do not apply to a screw entry (which
 * always adds a set count of identical bins), so the caller hides them with
 * perBinFields. The second label line additionally follows the store's
 * label-visibility getter, so it disappears for products without a label.
 * A non-bin caller (the Baseplate tab) hides every binDesigner-bound field
 * with hideBinFields and owns the open state through the open model, filling
 * the disclosure through the fields and after slots instead.
 *
 * Divider walls are not here: they live in the always-visible DividerControl
 * above the disclosure, so this holds only the second label line, quantity,
 * magnet holes and notes.
 */

const props = withDefaults(
  defineProps<{
    perBinFields: boolean;
    quantity?: number;
    /**
     * Hides every bin body option (magnet holes); an insert-only design has no
     * bin body to configure.
     */
    insertOnly?: boolean;
    /**
     * Hides every field bound to the binDesigner store (second label line,
     * dividers, magnet holes, notes); a caller designing a non-bin product
     * supplies its own fields through the slots.
     */
    hideBinFields?: boolean;
    /**
     * Overrides the disclosure's open state. When given, the caller owns the
     * state through update:open; when absent, the binDesigner store's
     * moreOptionsOpen persists it across the bin tabs. The undefined default
     * is what keeps an unbound prop caller-owned rather than store-owned.
     */
    open?: boolean;
  }>(),
  { open: undefined },
);

const emit = defineEmits<{
  'update:quantity': [value: number];
  'update:open': [value: boolean];
}>();

const store = useBinDesigner();
const { labelText2, magnetHoles, notes } = storeToRefs(store);

const open = computed({
  get: () => props.open ?? store.moreOptionsOpen,
  set: (value: boolean) => {
    if (props.open !== undefined) emit('update:open', value);
    else store.moreOptionsOpen = value;
  },
});
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
        v-if="props.perBinFields && !props.hideBinFields && store.hasLabel"
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
        <slot name="fields" />
      </div>
      <div v-if="!props.insertOnly && !props.hideBinFields" class="mt-3">
        <v-switch
          v-model="magnetHoles"
          color="primary"
          density="compact"
          hide-details
          label="Magnet holes"
        />
      </div>
      <v-textarea
        v-if="!props.hideBinFields"
        v-model="notes"
        label="Notes"
        density="comfortable"
        rows="2"
        class="mt-2"
        auto-grow
        hide-details
      />
      <slot name="after" />
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
