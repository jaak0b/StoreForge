<script setup lang="ts">
import { ref, watch } from 'vue';
import { useApp } from '../stores/app';
import type { ProductOrigin } from '../engine/plan/types';
import ManualBinTab from './ManualBinTab.vue';
import ScrewEntryTab from './ScrewEntryTab.vue';
import TraceTab from './trace/TraceTab.vue';
import CutoutTab from './cutout/CutoutTab.vue';

/**
 * The add-bin card at the top of the page: a Manual bin tab (the full bin
 * designer with live preview), a Screw entry tab (screw pickers plus the
 * quick-input shorthand line), a Tool trace tab (photo-traced tool pockets)
 * and a Cutout bin tab (pockets carved from imported STL models). Editing a
 * queue row opens it in the tab that owns the entry's kind; the other tabs
 * are disabled until the edit ends.
 */

const app = useApp();
type TabName = 'manual' | 'screw' | 'trace' | 'cutout' | 'baseplate';
const tab = ref<TabName>('manual');

const TAB_OF_KIND: Record<ProductOrigin, TabName> = {
  manual: 'manual',
  screw: 'screw',
  traced: 'trace',
  cutout: 'cutout',
  baseplate: 'baseplate',
  clip: 'baseplate',
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
      <v-tab value="trace" :disabled="tabDisabled('trace')">Tool bin</v-tab>
      <v-tab value="cutout" :disabled="tabDisabled('cutout')">Cutout bin</v-tab>
    </v-tabs>
    <v-divider />
    <v-card-text>
      <!-- The slide transition is disabled: the tabs hold live 3D previews,
           and animating them across is more distracting than useful. Touch
           swiping is disabled too: on the trace canvases a finger drag is the
           interaction itself and must never switch tabs. -->
      <v-window v-model="tab" :touch="false">
        <v-window-item value="manual" :transition="false" :reverse-transition="false">
          <ManualBinTab />
        </v-window-item>
        <v-window-item value="screw" :transition="false" :reverse-transition="false">
          <ScrewEntryTab />
        </v-window-item>
        <v-window-item value="trace" :transition="false" :reverse-transition="false">
          <TraceTab />
        </v-window-item>
        <v-window-item value="cutout" :transition="false" :reverse-transition="false">
          <CutoutTab />
        </v-window-item>
      </v-window>
    </v-card-text>
  </v-card>
</template>

<style scoped>
/*
 * The card and the tabs window clip their content by default, which stops
 * position: sticky children (the trace screen's floating action island) from
 * pinning to the viewport. The slide transition is disabled, so the window
 * never needs the clip; the card only loses corner clipping of flat content.
 */
.v-card {
  overflow: visible;
}

.v-card :deep(.v-window),
.v-card :deep(.v-window-item) {
  overflow: visible;
}
</style>
