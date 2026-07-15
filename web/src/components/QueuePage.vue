<script setup lang="ts">
import { computed, ref } from 'vue';
import { useApp } from '../stores/app';
import { useBinQueue } from '../stores/binQueue';
import { generateLabeledBinUnion } from '../workerClient';
import { meshToStlBlob } from '../engine/gridfinity/stlExport';
import type { BinEntry } from '../engine/plan/types';

const app = useApp();
const queue = useBinQueue();

type Filter = 'all' | 'queued' | 'printed';
const filter = ref<Filter>('all');
const errorMessage = ref<string | null>(null);
const downloadingId = ref<string | null>(null);

const filteredEntries = computed(() =>
  filter.value === 'all'
    ? queue.entries
    : queue.entries.filter((entry) => entry.status === filter.value),
);

function sizeLabel(entry: BinEntry): string {
  return `${entry.gridX} x ${entry.gridY} x ${entry.heightUnits}`;
}

async function downloadStl(entry: BinEntry): Promise<void> {
  downloadingId.value = entry.id;
  errorMessage.value = null;
  try {
    const mesh = await generateLabeledBinUnion({
      gridX: entry.gridX,
      gridY: entry.gridY,
      heightUnits: entry.heightUnits,
      stackingLip: entry.stackingLip,
      magnetHoles: entry.magnetHoles,
      labelText: entry.labelText,
      labelIcon: entry.labelIcon,
    });
    const blob = meshToStlBlob(mesh);
    const name = `gridfinity_bin_${entry.gridX}x${entry.gridY}x${entry.heightUnits}.stl`;
    triggerDownload(blob, name);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'STL export failed.';
  } finally {
    downloadingId.value = null;
  }
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportJson(): void {
  const blob = new Blob([queue.exportJson()], { type: 'application/json' });
  triggerDownload(blob, 'gridfinity_print_plan.json');
}

// Import flow: pick a file, then ask whether to merge or replace.
const importDialogOpen = ref(false);
const pendingImportText = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function openImportPicker(): void {
  fileInput.value?.click();
}

async function onImportFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  errorMessage.value = null;
  try {
    pendingImportText.value = await file.text();
    importDialogOpen.value = true;
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Reading the file failed.';
  }
}

function finishImport(mode: 'merge' | 'replace'): void {
  importDialogOpen.value = false;
  if (pendingImportText.value === null) return;
  const problem = queue.importJson(pendingImportText.value, mode);
  pendingImportText.value = null;
  if (problem !== null) errorMessage.value = problem;
}

// Print session: multi-select queued entries, then mark the good ones printed.
const sessionActive = ref(false);
const selectedIds = ref<Set<string>>(new Set());

function toggleSession(): void {
  sessionActive.value = !sessionActive.value;
  selectedIds.value = new Set();
}

function toggleSelected(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function markSelectedPrinted(): void {
  queue.markPrinted(selectedIds.value);
  sessionActive.value = false;
  selectedIds.value = new Set();
}
</script>

<template>
  <v-container>
    <v-card>
      <v-toolbar density="comfortable" color="transparent">
        <v-toolbar-title>Print queue</v-toolbar-title>
        <v-btn-toggle v-model="filter" density="comfortable" mandatory class="mr-4">
          <v-btn value="all">All</v-btn>
          <v-btn value="queued">Queued</v-btn>
          <v-btn value="printed">Printed</v-btn>
        </v-btn-toggle>
        <v-btn variant="text" prepend-icon="mdi-download" @click="exportJson">
          Export JSON
        </v-btn>
        <v-btn variant="text" prepend-icon="mdi-upload" @click="openImportPicker">
          Import JSON
        </v-btn>
        <v-btn
          variant="text"
          prepend-icon="mdi-printer-3d"
          :disabled="queue.queuedCount === 0 && !sessionActive"
          @click="toggleSession"
        >
          {{ sessionActive ? 'Cancel session' : 'Print session' }}
        </v-btn>
        <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="app.openDesignerNew()">
          Add bin
        </v-btn>
      </v-toolbar>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        style="display: none"
        @change="onImportFileChosen"
      />

      <v-alert v-if="errorMessage" type="error" density="compact" class="mx-4 mb-2">
        {{ errorMessage }}
      </v-alert>

      <v-alert v-if="sessionActive" type="info" density="compact" variant="tonal" class="mx-4 mb-2">
        Select the queued bins that printed successfully, then mark them as printed.
        Bins you leave unchecked stay in the queue.
      </v-alert>

      <v-card-text v-if="filteredEntries.length === 0">
        <p class="text-body-1">
          This app manages a print plan of Gridfinity bins: design each bin,
          queue it, download its STL for printing, and mark it printed once it
          is off the bed. Add a bin to start the plan.
        </p>
      </v-card-text>

      <v-list v-else lines="two">
        <v-list-item v-for="entry in filteredEntries" :key="entry.id">
          <template #prepend>
            <v-checkbox-btn
              v-if="sessionActive && entry.status === 'queued'"
              :model-value="selectedIds.has(entry.id)"
              @update:model-value="toggleSelected(entry.id)"
            />
          </template>
          <v-list-item-title>
            {{ sizeLabel(entry) }}
            <span v-if="entry.labelText" class="ml-2">"{{ entry.labelText }}"</span>
          </v-list-item-title>
          <v-list-item-subtitle>
            Icon: {{ entry.labelIcon ?? 'none' }} &middot; Quantity: {{ entry.quantity }}
          </v-list-item-subtitle>
          <template #append>
            <v-chip
              size="small"
              :color="entry.status === 'printed' ? 'success' : 'primary'"
              class="mr-2"
            >
              {{ entry.status }}
            </v-chip>
            <v-btn
              icon="mdi-pencil"
              variant="text"
              size="small"
              title="Edit"
              @click="app.openDesignerEdit(entry.id)"
            />
            <v-btn
              icon="mdi-content-copy"
              variant="text"
              size="small"
              title="Duplicate"
              @click="queue.duplicate(entry.id)"
            />
            <v-btn
              icon="mdi-file-download-outline"
              variant="text"
              size="small"
              title="Download STL"
              :loading="downloadingId === entry.id"
              :disabled="downloadingId !== null"
              @click="downloadStl(entry)"
            />
            <v-btn
              v-if="entry.status === 'queued'"
              icon="mdi-check"
              variant="text"
              size="small"
              title="Mark printed"
              @click="queue.markPrinted([entry.id])"
            />
            <v-btn
              v-else
              icon="mdi-undo"
              variant="text"
              size="small"
              title="Back to queue"
              @click="queue.requeue([entry.id])"
            />
            <v-btn
              icon="mdi-delete-outline"
              variant="text"
              size="small"
              title="Delete"
              @click="queue.remove(entry.id)"
            />
          </template>
        </v-list-item>
      </v-list>

      <v-card-actions v-if="sessionActive">
        <v-spacer />
        <v-btn
          color="primary"
          variant="flat"
          :disabled="selectedIds.size === 0"
          @click="markSelectedPrinted"
        >
          Mark selected as printed
        </v-btn>
      </v-card-actions>
    </v-card>

    <v-dialog v-model="importDialogOpen" max-width="480">
      <v-card>
        <v-card-title>Import plan</v-card-title>
        <v-card-text>
          Merge keeps your current entries and updates any entry that appears in
          the file with the same id. Replace discards the current plan and loads
          the file as the whole plan.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="importDialogOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="text" @click="finishImport('merge')">Merge</v-btn>
          <v-btn color="primary" variant="flat" @click="finishImport('replace')">Replace</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
