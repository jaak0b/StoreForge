<script setup lang="ts">
import { computed, ref } from 'vue';
import { useApp } from '../stores/app';
import { useBinQueue } from '../stores/binQueue';
import {
  binOf,
  insertOf,
  originOf,
  type QueueEntry,
} from '../engine/plan/types';
import { snapshotProduct, type BatchSelection } from '../engine/plan/batches';
import { resolveLabelIcon } from '../labelIcons';
import type { LabelIcon } from '../engine/label/icons';
import { downloadProduct3mf, downloadProductStl } from '../binDownloads';
import AddBinCard from './AddBinCard.vue';
import BatchBox from './BatchBox.vue';
import CountStepper from './CountStepper.vue';

/**
 * The whole app on one page: the add-bin card on top, then zero or more
 * print batch boxes, then the main queue. Selecting queue rows reveals
 * per-row plate amounts and the sticky create-build-plate bar; creating
 * moves the selected amounts into a new batch box.
 */

const app = useApp();
const queue = useBinQueue();

/** The row's label icon, from the entry's insert content, when it has one. */
function rowIcon(entry: QueueEntry): LabelIcon | null {
  const icon = insertOf(entry.product)?.content.icon ?? null;
  return icon !== null ? resolveLabelIcon(icon) : null;
}

function sizeText(entry: QueueEntry): string {
  const bin = binOf(entry.product);
  if (bin === null) return '';
  return `${bin.gridX} x ${bin.gridY} x ${bin.heightUnits}`;
}

function rowTitle(entry: QueueEntry): string {
  const insert = insertOf(entry.product);
  if (insert !== null && insert.content.text !== '') return insert.content.text;
  if (entry.product.kind === 'insert') return `${entry.product.cells}u label insert`;
  return sizeText(entry);
}

function rowText2(entry: QueueEntry): string {
  return insertOf(entry.product)?.content.text2 ?? '';
}

/** Chip text marking what the row prints beyond a plain bin, or null. */
function productChip(entry: QueueEntry): string | null {
  switch (entry.product.kind) {
    case 'binWithInsert':
      return 'bin + insert';
    case 'insert':
      return 'insert only';
    default:
      return null;
  }
}

/** The traced bin's pocket count of the row, or null for other rows. */
function pocketCount(entry: QueueEntry): number | null {
  const bin = binOf(entry.product);
  return bin !== null && bin.origin === 'traced' ? bin.pockets.placements.length : null;
}

// Row selection for building a plate. Each selected row carries an amount
// that defaults to its full quantity and can be edited down for a partial
// plate.
const selectedIds = ref<Set<string>>(new Set());
const plateCounts = ref<Map<string, number>>(new Map());

function toggleSelected(entry: QueueEntry): void {
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

function plateCountOf(entry: QueueEntry): number {
  return plateCounts.value.get(entry.id) ?? entry.quantity;
}

function setPlateCount(entry: QueueEntry, value: number): void {
  const next = new Map(plateCounts.value);
  next.set(entry.id, Math.min(Math.max(1, Math.floor(value)), entry.quantity));
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

// Row click loads the entry into the tab that owns its origin for editing.
function editRow(entry: QueueEntry): void {
  app.editEntry(entry.id, originOf(entry.product));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Per-row single-bin downloads.
const downloadingId = ref<string | null>(null);
const errorMessage = ref<string | null>(null);

async function downloadRow(entry: QueueEntry, format: 'stl' | '3mf'): Promise<void> {
  downloadingId.value = entry.id;
  errorMessage.value = null;
  try {
    const product = snapshotProduct(entry.product);
    if (format === 'stl') await downloadProductStl(product);
    else await downloadProduct3mf(product);
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'The download failed.';
  } finally {
    downloadingId.value = null;
  }
}

function removeRow(entry: QueueEntry): void {
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
      Add bins to the queue, select rows to create a build plate batch, then
      confirm what printed.
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
      text="Add a bin with the card above."
    />

    <div v-else class="d-flex flex-column ga-1">
      <div
        v-for="entry in queue.entries"
        :key="entry.id"
        class="qrow"
        :class="{ selected: selectedIds.has(entry.id) }"
        role="button"
        @click="editRow(entry)"
      >
        <v-checkbox-btn
          :model-value="selectedIds.has(entry.id)"
          density="compact"
          class="flex-grow-0 row-check"
          @click.stop="toggleSelected(entry)"
        />
        <span class="swatch d-flex align-center justify-center">
          <svg
            v-if="rowIcon(entry) !== null"
            width="18"
            height="18"
            :viewBox="rowIcon(entry)!.viewBox.join(' ')"
            aria-hidden="true"
          >
            <path
              :d="rowIcon(entry)!.path"
              fill="currentColor"
              fill-rule="evenodd"
            />
          </svg>
          <v-icon v-else icon="mdi-cube-outline" size="16" class="text-medium-emphasis" />
        </span>
        <span class="row-name">
          <span class="d-block text-body-2 font-weight-bold">{{ rowTitle(entry) }}</span>
          <span
            v-if="rowText2(entry) !== ''"
            class="d-block text-caption text-medium-emphasis"
          >
            {{ rowText2(entry) }}
          </span>
        </span>
        <v-chip
          v-if="pocketCount(entry) !== null"
          size="x-small"
          variant="tonal"
          color="primary"
          class="flex-grow-0"
        >
          {{ pocketCount(entry) }}
          {{ pocketCount(entry) === 1 ? 'pocket' : 'pockets' }}
        </v-chip>
        <v-chip
          v-if="productChip(entry) !== null"
          size="x-small"
          variant="tonal"
          color="secondary"
          class="flex-grow-0"
        >
          {{ productChip(entry) }}
        </v-chip>
        <span class="row-dims">{{ rowTitle(entry) !== sizeText(entry) ? sizeText(entry) : '' }}</span>
        <span class="qty-badge">x{{ entry.quantity }}</span>
        <div v-if="selectedIds.has(entry.id)" class="d-flex align-center ga-1" @click.stop>
          <span class="text-caption text-primary font-weight-bold">Plate:</span>
          <CountStepper
            :model-value="plateCountOf(entry)"
            :max="entry.quantity"
            @update:model-value="(v: number) => setPlateCount(entry, v)"
          />
        </div>
        <div v-else></div>
        <div class="row-actions d-flex ga-1 justify-end" @click.stop>
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
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 10px;
  cursor: pointer;
  background: rgb(var(--v-theme-surface));
}

.row-check {
  flex: 0 0 auto;
}

.qty-badge {
  font-family: monospace;
  font-size: 11.5px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  background: rgba(var(--v-theme-on-surface), 0.05);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  padding: 2px 8px;
  flex: 0 0 auto;
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
  flex: 1 1 auto;
  min-width: 0;
}

.row-name > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-dims {
  flex: 0 0 auto;
  font-family: monospace;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

@media (max-width: 800px) {
  .qrow {
    display: flex;
    flex-wrap: wrap;
  }
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
