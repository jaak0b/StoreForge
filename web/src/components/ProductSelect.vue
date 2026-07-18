<script setup lang="ts">
import { computed } from 'vue';
import type { ProductChoice } from '../stores/binDesigner';

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
}>();

const choice = defineModel<ProductChoice>({ required: true });

const ALL_ITEMS: Array<{ value: ProductChoice; title: string; subtitle: string }> = [
  {
    value: 'binWithInsert',
    title: 'Bin + label insert',
    subtitle: 'A bin plus the matching swappable label insert for its slot.',
  },
  {
    value: 'bin',
    title: 'Bin without label',
    subtitle: 'A bin with an empty label slot; print inserts for it later.',
  },
  {
    value: 'insert',
    title: 'Label insert only',
    subtitle: 'Just the insert, for a bin you already have.',
  },
];

const items = computed(() =>
  props.hideInsertOnly ? ALL_ITEMS.filter((item) => item.value !== 'insert') : ALL_ITEMS,
);
</script>

<template>
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
</template>
