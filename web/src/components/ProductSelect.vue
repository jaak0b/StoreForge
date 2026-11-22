<script setup lang="ts">
import { computed } from 'vue';
import type { ProductChoice } from '../stores/binDesigner';
import { BIN_ALONE_CHOICES, PRODUCT_CHOICES } from '../engine/plan/manualProduct';

/**
 * The shared product picker: what the entry produces. Every bin has the
 * swappable label insert slot; the slot and insert follow the Printables
 * "Gridfinity bin with printable label by Pred" model, so inserts and bins
 * interchange with that ecosystem.
 */

const props = defineProps<{
  /**
   * Hides the insert-only choice. The Tool trace tab sets this: an insert
   * has no interior for tool pockets, so it cannot come from that tab.
   */
  hideInsertOnly?: boolean;
  /**
   * Hides both bin-alone choices. The Screw entry tab sets this: a screw bin
   * is printed to carry the label naming its fastener, so it always comes
   * with its insert.
   */
  hideBinAlone?: boolean;
}>();

const choice = defineModel<ProductChoice>({ required: true });

// Whether a Bin + label insert prints as one fused piece. Only shown, and only
// meaningful, when the choice is binWithInsert.
const fused = defineModel<boolean>('fused', { default: false });

const items = computed(() =>
  PRODUCT_CHOICES.filter(
    (item) =>
      !(props.hideInsertOnly && item.value === 'insert') &&
      !(props.hideBinAlone && BIN_ALONE_CHOICES.includes(item.value)),
  ),
);
</script>

<template>
  <div>
    <v-select
      v-model="choice"
      :items="items"
      item-title="title"
      item-value="value"
      label="Parts to print"
      density="comfortable"
      hide-details
    >
      <template #item="{ props: itemProps, item }">
        <v-list-item v-bind="itemProps" :subtitle="item.raw.subtitle" />
      </template>
    </v-select>

    <template v-if="choice === 'binWithInsert'">
      <v-checkbox
        v-model="fused"
        label="Print the label as part of the bin"
        density="comfortable"
        hide-details
        class="mt-1"
      />
      <div class="text-caption text-medium-emphasis ml-10 mt-n2">
        The bin and its label print as one fused piece; the label is raised on the bin and
        there is no swappable insert slot.
      </div>
    </template>
  </div>
</template>
