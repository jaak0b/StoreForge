<script setup lang="ts">
import { ref, watch } from 'vue';
import { useApp } from '../stores/app';
import ManualBinTab from './ManualBinTab.vue';
import ScrewEntryTab from './ScrewEntryTab.vue';

/**
 * The add-bin card at the top of the page: a Manual bin tab (the full bin
 * designer with live preview) and a Screw entry tab (screw pickers plus the
 * quick-input shorthand line). Editing a queue row opens it in the Manual
 * tab.
 */

const app = useApp();
const tab = ref<'manual' | 'screw'>('manual');

// Editing a queue entry (and Ctrl+N) always lands on the Manual tab.
watch(
  () => app.focusAddSeq,
  () => {
    tab.value = 'manual';
  },
);
</script>

<template>
  <v-card variant="outlined" class="mb-6">
    <v-tabs v-model="tab" color="primary" density="comfortable">
      <v-tab value="manual">Manual bin</v-tab>
      <v-tab value="screw">Screw entry</v-tab>
    </v-tabs>
    <v-divider />
    <v-card-text>
      <!-- The slide transition is disabled: the tabs hold live 3D previews,
           and animating them across is more distracting than useful. -->
      <v-window v-model="tab">
        <v-window-item value="manual" :transition="false" :reverse-transition="false">
          <ManualBinTab />
        </v-window-item>
        <v-window-item value="screw" :transition="false" :reverse-transition="false">
          <ScrewEntryTab />
        </v-window-item>
      </v-window>
    </v-card-text>
  </v-card>
</template>
