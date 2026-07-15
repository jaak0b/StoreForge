<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { useApp } from './stores/app';
import QueuePage from './components/QueuePage.vue';
import BinDesignerPage from './components/BinDesignerPage.vue';
import PlatePage from './components/PlatePage.vue';
import ScrewListImportPage from './components/ScrewListImportPage.vue';

const app = useApp();

// The one global keyboard shortcut listener. Page-specific shortcuts are
// dispatched as intents through the app store; pages watch and react.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onKeydown(event: KeyboardEvent): void {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
    if (app.page !== 'queue') return;
    event.preventDefault();
    app.openDesignerNew();
    return;
  }
  if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
    if (app.page !== 'queue') return;
    event.preventDefault();
    app.sendShortcut('toggleSession');
    return;
  }
  if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
    if (app.page !== 'queue') return;
    event.preventDefault();
    app.sendShortcut('toggleBulk');
    return;
  }
  if (event.key === 'Escape') {
    // Open dialogs consume Escape themselves; this cancels page modes.
    app.sendShortcut('escape');
    return;
  }
  if (event.key === '?' && !modifier && !isEditableTarget(event.target)) {
    event.preventDefault();
    app.shortcutSheetOpen = true;
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

interface ShortcutRow {
  keys: string[];
  action: string;
}

const shortcutGroups: { title: string; rows: ShortcutRow[] }[] = [
  {
    title: 'Print queue',
    rows: [
      { keys: ['Ctrl', 'N'], action: 'Add a new bin' },
      { keys: ['Ctrl', 'Shift', 'P'], action: 'Start or cancel a print session' },
      { keys: ['Ctrl', 'Shift', 'S'], action: 'Start or cancel bin selection' },
      { keys: ['Esc'], action: 'Cancel the active mode or close a dialog' },
      { keys: ['?'], action: 'Show this shortcut sheet' },
    ],
  },
  {
    title: 'Screw list',
    rows: [{ keys: ['Enter'], action: 'Add the typed rows to the list' }],
  },
];
</script>

<template>
  <v-app>
    <v-app-bar color="primary" density="comfortable">
      <v-app-bar-title>Gridfinity Generator</v-app-bar-title>
      <v-btn
        variant="text"
        :active="app.page === 'queue'"
        @click="app.showQueue()"
      >
        Queue
      </v-btn>
      <v-btn
        variant="text"
        :active="app.page === 'designer'"
        @click="app.openDesignerNew()"
      >
        Designer
      </v-btn>
      <v-btn
        variant="text"
        :active="app.page === 'plate'"
        @click="app.showPlate()"
      >
        Plate
      </v-btn>
    </v-app-bar>
    <v-main>
      <QueuePage v-if="app.page === 'queue'" />
      <PlatePage v-else-if="app.page === 'plate'" />
      <ScrewListImportPage v-else-if="app.page === 'screwListImport'" />
      <BinDesignerPage v-else :key="app.editingEntryId ?? 'new'" />
    </v-main>

    <v-dialog v-model="app.shortcutSheetOpen" max-width="420">
      <v-card>
        <v-card-title>Keyboard shortcuts</v-card-title>
        <v-card-text>
          <template v-for="group in shortcutGroups" :key="group.title">
            <div class="text-subtitle-2 mt-2 mb-1">{{ group.title }}</div>
            <div
              v-for="row in group.rows"
              :key="row.action"
              class="d-flex align-center justify-space-between py-1"
            >
              <span class="text-body-2">{{ row.action }}</span>
              <span class="d-flex ga-1">
                <v-chip
                  v-for="key in row.keys"
                  :key="key"
                  size="small"
                  variant="outlined"
                  class="shortcut-key"
                >
                  {{ key }}
                </v-chip>
              </span>
            </div>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="app.shortcutSheetOpen = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<style scoped>
.shortcut-key {
  font-family: monospace;
}
</style>
