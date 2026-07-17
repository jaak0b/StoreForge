<script setup lang="ts">
import { ref, watch } from 'vue';
import { useApp } from '../stores/app';
import type { BinKind } from '../engine/plan/types';
import ManualBinTab from './ManualBinTab.vue';
import ScrewEntryTab from './ScrewEntryTab.vue';
import TraceTab from './trace/TraceTab.vue';

/**
 * The add-bin card at the top of the page: a Manual bin tab (the full bin
 * designer with live preview), a Screw entry tab (screw pickers plus the
 * quick-input shorthand line), and a Tool trace tab (photo-traced tool
 * pockets). Editing a queue row opens it in the tab that owns the entry's
 * kind; the other two tabs are disabled until the edit ends.
 */

const app = useApp();
type TabName = 'manual' | 'screw' | 'trace';
const tab = ref<TabName>('manual');

const TAB_OF_KIND: Record<BinKind, TabName> = {
  manual: 'manual',
  screw: 'screw',
  traced: 'trace',
};

// Editing a queue entry lands on its owning tab; Ctrl+N lands on Manual.
watch(
  () => app.focusAddSeq,
  () => {
    tab.value = app.editingKind !== null ? TAB_OF_KIND[app.editingKind] : 'manual';
  },
);

/** While editing, only the owning tab stays enabled. */
function tabDisabled(name: TabName): boolean {
  return app.editingKind !== null && TAB_OF_KIND[app.editingKind] !== name;
}
</script>

<template>
  <v-card variant="outlined" class="mb-6">
    <v-tabs v-model="tab" color="primary" density="comfortable">
      <v-tab value="manual" :disabled="tabDisabled('manual')">Manual bin</v-tab>
      <v-tab value="screw" :disabled="tabDisabled('screw')">Screw entry</v-tab>
      <v-tab value="trace" :disabled="tabDisabled('trace')">Tool trace</v-tab>
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
        <v-window-item value="trace" :transition="false" :reverse-transition="false">
          <TraceTab />
        </v-window-item>
      </v-window>
    </v-card-text>
  </v-card>
</template>
