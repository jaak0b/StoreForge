<script setup lang="ts">
import type { LabelMode } from '../engine/gridfinity/types';

/**
 * The shared label-mode picker: what the entry produces, from a bin with the
 * label embossed on it to a swappable label insert alone. The slot and insert
 * follow the Printables "Gridfinity bin with printable label by Pred" model,
 * so inserts and bins interchange with that ecosystem.
 */

const mode = defineModel<LabelMode>({ required: true });

const ITEMS: Array<{ value: LabelMode; title: string; subtitle: string }> = [
  {
    value: 'embossed',
    title: 'Bin with printed label',
    subtitle: 'The label is embossed on the bin and cannot be changed later.',
  },
  {
    value: 'slot-insert',
    title: 'Bin + label insert',
    subtitle: 'A bin with a label slot, plus the matching swappable insert.',
  },
  {
    value: 'slot',
    title: 'Bin without label',
    subtitle: 'A bin with an empty label slot; print inserts for it later.',
  },
  {
    value: 'insert',
    title: 'Label insert only',
    subtitle: 'Just the insert, for a slotted bin you already have.',
  },
];
</script>

<template>
  <v-select
    v-model="mode"
    :items="ITEMS"
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
