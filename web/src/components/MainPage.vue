<script setup lang="ts">
import { computed, ref } from 'vue';
import { useApp } from '../stores/app';
import { useBinQueue } from '../stores/binQueue';
import type { BinEntry } from '../engine/plan/types';
import { snapshotParams, type BatchSelection } from '../engine/plan/batches';
import { resolveLabelIcon } from '../labelIcons';
import type { LabelIcon } from '../engine/label/icons';
import { downloadBin3mf, downloadBinStl } from '../binDownloads';
import AddBinCard from './AddBinCard.vue';
import BatchBox from './BatchBox.vue';

/**
 * The whole app on one page: the add-bin card on top, then zero or more
 * print batch boxes, then the main queue. Selecting queue rows reveals
 * per-row plate amounts and the sticky create-build-plate bar; creating
 * moves the selected amounts into a new batch box.
 */

const app = useApp();
const queue = useBinQueue();

function labelIconOf(name: string | null): LabelIcon | null {
  return name !== null ? resolveLabelIcon(name) : null;
}

function sizeText(entry: BinEntry): string {
  return `${entry.gridX} x ${entry.gridY} x ${entry.heightUnits}`;
}

function rowTitle(entry: BinEntry): string {
  return entry.labelText !== '' ? entry.labelText : sizeText(entry);
}

// Row selection for building a plate. Each selected row carries an amount
// that defaults to its full quantity and can be edited down for a partial
// plate.
const selectedIds = ref<Set<string>>(new Set());
const plateCounts = ref<Map<string, number>>(new Map());

function toggleSelected(entry: BinEntry): void {
  const nextIds = new Set(selectedIds.value);
  const nextCounts = new Map(plateCounts.value);
  if (nextIds.has(entry.id)) {
    nextIds.delete(entry.id);
    nextCounts.delete(entry.id);
  } else {
    nextIds.add(entry.id);
    nextCounts.set(entry.id, entry.quantity);
  }
  selectedIds.value = nextIds;
  plateCounts.value = nextCounts;
}

function plateCountOf(entry: BinEntry): number {
  return plateCounts.value.get(entry.id) ?? entry.quantity;
}

function setPlateCount(entry: BinEntry, value: string): void {
  const parsed = Math.floor(Number(value));
  const clamped = Number.isFinite(parsed)
    ? Math.min(Math.max(1, parsed), entry.quantity)
    : entry.quantity;
  const next = new Map(plateCounts.value);
  next.set(entry.id, clamped);
  plateCounts.value = next;
}

const selectedEntries = computed(() =>
  queue.entries.filter((entry) => selectedIds.value.has(entry.id)),
);

const selectedBinTotal = computed(() =>
  selectedEntries.value.reduce((sum, entry) => sum + plateCountOf(entry), 0),
);

function createPlate(): void {
  const selections: BatchSelection[] = selectedEntries.value.map((entry) => ({
    entryId: entry.id,
    count: plateCountOf(entry),
  }));
  queue.createBatch(selections, `Build plate ${queue.batches.length + 1}`);
  selectedIds.value = new Set();
  plateCounts.value = new Map();
}

// Row click loads the entry into the Manual tab for editing.
function editRow(entry: BinEntry): void {
  app.editEntry(entry.id);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Per-row single-bin downloads.
const downloadingId = ref<string | null>(null);
const errorMessage = ref<string | null>(null);

async function downloadRow(entry: BinEntry, format: 'stl' | '3mf'): Promise<void> {
  downloadingId.value = entry.id;
  errorMessage.value = null;
  try {
    const params = snapshotParams(entry);
    if (format === 'stl') await downloadBinStl(params);
    else await downloadBin3mf(params);
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'The download failed.';
  } finally {
    downloadingId.value = null;
  }
}

function removeRow(entry: BinEntry): void {
  if (app.editingEntryId === entry.id) app.stopEditing();
  const nextIds = new Set(selectedIds.value);
  nextIds.delete(entry.id);
  selectedIds.value = nextIds;
  queue.remove(entry.id);
}
</script>

<template>
  <v-container class="main-page">
    <h1 class="text-h5 mt-2 mb-1">What do you want to print?</h1>
    <p class="text-body-2 text-medium-emphasis mb-5">
      Add bins at the top. They land in the queue at the bottom; selecting
      queue rows creates a build plate batch, and batches sit in between until
      you confirm what printed.
    </p>

    <AddBinCard />

    <BatchBox v-for="batch in queue.batches" :key="batch.id" :batch="batch" />

    <div class="d-flex align-center mt-6 mb-2">
      <h2 class="text-subtitle-1 font-weight-bold">Your queue</h2>
      <v-chip size="small" variant="tonal" class="ml-2">
        {{ queue.entries.length }} {{ queue.entries.length === 1 ? 'bin' : 'bins' }} queued
      </v-chip>
    </div>

    <v-alert v-if="errorMessage" type="error" density="compact" class="mb-3">
      {{ errorMessage }}
    </v-alert>

    <v-empty-state
      v-if="queue.entries.length === 0"
      icon="mdi-cube-outline"
      title="No bins queued"
      text="Add a bin with the card above. Queued bins can be downloaded one at a time or grouped into a build plate batch."
    />

    <div v-else class="d-flex flex-column ga-1">
      <div
        v-for="entry in queue.entries"
        :key="entry.id"
        class="qrow d-flex align-center ga-3 px-3 py-2"
        :class="{ selected: selectedIds.has(entry.id) }"
        role="button"
        @click="editRow(entry)"
      >
        <v-checkbox-btn
          :model-value="selectedIds.has(entry.id)"
          density="compact"
          class="flex-grow-0"
          @click.stop="toggleSelected(entry)"
        />
        <span class="swatch d-flex align-center justify-center">
          <svg
            v-if="labelIconOf(entry.labelIcon) !== null"
            width="18"
            height="18"
            :viewBox="labelIconOf(entry.labelIcon)!.viewBox.join(' ')"
            aria-hidden="true"
          >
            <path
              :d="labelIconOf(entry.labelIcon)!.path"
              fill="currentColor"
              fill-rule="evenodd"
            />
          </svg>
          <v-icon v-else icon="mdi-cube-outline" size="16" class="text-medium-emphasis" />
        </span>
        <span class="row-name">
          <span class="d-block text-body-2 font-weight-bold">{{ rowTitle(entry) }}</span>
          <span
            v-if="entry.labelText2 !== ''"
            class="d-block text-caption text-medium-emphasis"
          >
            {{ entry.labelText2 }}
          </span>
        </span>
        <span class="text-caption text-medium-emphasis row-dims">{{ sizeText(entry) }}</span>
        <v-chip size="small" variant="outlined">x{{ entry.quantity }}</v-chip>
        <div
          v-if="selectedIds.has(entry.id)"
          class="d-flex align-center ga-1"
          @click.stop
        >
          <span class="text-caption text-primary font-weight-bold">Plate:</span>
          <v-text-field
            :model-value="plateCountOf(entry)"
            type="number"
            min="1"
            :max="entry.quantity"
            density="compact"
            hide-details
            style="width: 70px"
            @update:model-value="(v: string) => setPlateCount(entry, v)"
          />
        </div>
        <v-spacer />
        <div class="row-actions d-flex ga-1" @click.stop>
          <v-menu>
            <template #activator="{ props: menuProps }">
              <v-btn
                icon
                size="small"
                variant="text"
                :loading="downloadingId === entry.id"
                :disabled="downloadingId !== null"
                v-bind="menuProps"
              >
                <v-icon icon="mdi-download-outline" size="18" />
                <v-tooltip activator="parent" location="bottom">Download bin</v-tooltip>
              </v-btn>
            </template>
            <v-list density="comfortable">
              <v-list-item
                title="STL"
                subtitle="One mesh, label merged into the bin."
                @click="downloadRow(entry, 'stl')"
              />
              <v-list-item
                title="3MF, two filaments"
                subtitle="Body and label slots for toolchanger printing."
                @click="downloadRow(entry, '3mf')"
              />
            </v-list>
          </v-menu>
          <v-btn icon size="small" variant="text" @click="queue.duplicate(entry.id)">
            <v-icon icon="mdi-content-copy" size="18" />
            <v-tooltip activator="parent" location="bottom">Duplicate</v-tooltip>
          </v-btn>
          <v-btn icon size="small" variant="text" color="error" @click="removeRow(entry)">
            <v-icon icon="mdi-close" size="18" />
            <v-tooltip activator="parent" location="bottom">Remove</v-tooltip>
          </v-btn>
        </div>
      </div>
    </div>

    <div v-if="selectedEntries.length > 0" class="create-plate-bar">
      <span class="text-body-2 mr-3">
        <b>{{ selectedEntries.length }}
          {{ selectedEntries.length === 1 ? 'row' : 'rows' }} selected</b>
        <span class="text-medium-emphasis"> &middot; {{ selectedBinTotal }} bins</span>
      </span>
      <v-btn color="primary" variant="flat" @click="createPlate">
        Create build plate ({{ selectedBinTotal }}
        {{ selectedBinTotal === 1 ? 'bin' : 'bins' }})
      </v-btn>
    </div>
  </v-container>
</template>

<style scoped>
.main-page {
  max-width: 1100px;
  padding-bottom: 120px;
}

.qrow {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 10px;
  cursor: pointer;
  background: rgb(var(--v-theme-surface));
}

.qrow:hover {
  border-color: rgb(var(--v-theme-primary));
}

.qrow.selected {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.08);
}

.qrow .row-actions {
  opacity: 0;
  transition: opacity 0.1s;
}

.qrow:hover .row-actions,
.qrow:focus-within .row-actions {
  opacity: 1;
}

.swatch {
  width: 34px;
  height: 28px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 6px;
  flex-shrink: 0;
}

.row-name {
  min-width: 160px;
}

.row-dims {
  font-family: monospace;
}

.create-plate-bar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  align-items: center;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-primary));
  border-radius: 12px;
  padding: 10px 12px 10px 18px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
}
</style>
