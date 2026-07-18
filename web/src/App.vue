<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useApp } from './stores/app';
import { useBinQueue } from './stores/binQueue';
import { triggerDownload } from './binDownloads';
import MainPage from './components/MainPage.vue';

const app = useApp();
const queue = useBinQueue();

// The one global keyboard shortcut listener.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onKeydown(event: KeyboardEvent): void {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    app.focusAddCard();
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

const shortcutRows: ShortcutRow[] = [
  { keys: ['Ctrl', 'N'], action: 'Start a new bin in the add card' },
  { keys: ['Enter'], action: 'In the quick input: add the typed screws to the queue' },
  { keys: ['Esc'], action: 'Close an open dialog' },
  { keys: ['?'], action: 'Show this shortcut sheet' },
];

// Plan backup: export the plan as JSON, import with a merge/replace choice.
const importDialogOpen = ref(false);
const pendingImportText = ref<string | null>(null);
const importError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function exportBackup(): void {
  const blob = new Blob([queue.exportJson()], { type: 'application/json' });
  triggerDownload(blob, 'gridfinity_print_plan.json');
}

function openImportPicker(): void {
  importError.value = null;
  fileInput.value?.click();
}

async function onImportFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    pendingImportText.value = await file.text();
    importDialogOpen.value = true;
  } catch (error) {
    importError.value =
      error instanceof Error ? error.message : 'Reading the file failed.';
  }
}

function finishImport(mode: 'merge' | 'replace'): void {
  importDialogOpen.value = false;
  if (pendingImportText.value === null) return;
  const problem = queue.importJson(pendingImportText.value, mode);
  pendingImportText.value = null;
  if (problem !== null) importError.value = problem;
}
</script>

<template>
  <v-app>
    <v-app-bar color="primary" density="comfortable">
      <v-app-bar-title>StoreForge</v-app-bar-title>
      <v-btn variant="text" prepend-icon="mdi-upload" @click="openImportPicker">
        Import backup
      </v-btn>
      <v-btn variant="text" prepend-icon="mdi-download" @click="exportBackup">
        Export backup
      </v-btn>
      <v-btn icon variant="text" @click="app.shortcutSheetOpen = true">
        <v-icon icon="mdi-help-circle-outline" />
        <v-tooltip activator="parent" location="bottom">Keyboard shortcuts (?)</v-tooltip>
      </v-btn>
      <v-btn
        icon
        variant="text"
        href="https://github.com/jaak0b/StoreForge"
        target="_blank"
        rel="noopener"
      >
        <v-icon icon="mdi-github" />
        <v-tooltip activator="parent" location="bottom">View on GitHub</v-tooltip>
      </v-btn>
    </v-app-bar>
    <v-main>
      <MainPage />
    </v-main>

    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      style="display: none"
      @change="onImportFileChosen"
    />

    <v-snackbar
      :model-value="importError !== null"
      color="error"
      timeout="6000"
      @update:model-value="importError = null"
    >
      {{ importError }}
    </v-snackbar>

    <v-dialog v-model="importDialogOpen" max-width="480">
      <v-card>
        <v-card-title>Import plan</v-card-title>
        <v-card-text>
          Merge keeps your current entries and batches and updates any that
          appear in the file with the same id. Replace discards the current
          plan and loads the file as the whole plan.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="importDialogOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="text" @click="finishImport('merge')">Merge</v-btn>
          <v-btn color="primary" variant="flat" @click="finishImport('replace')">Replace</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="app.shortcutSheetOpen" max-width="460">
      <v-card>
        <v-card-title>Keyboard shortcuts</v-card-title>
        <v-card-text>
          <div
            v-for="row in shortcutRows"
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
