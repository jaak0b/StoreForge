<script setup lang="ts">
import { ref } from 'vue';
import { useBinQueue } from '../stores/binQueue';
import type { BatchItem, PrintBatch } from '../engine/plan/types';
import { resolveLabelIcon } from '../labelIcons';
import type { LabelIcon } from '../engine/label/icons';
import { downloadBatch, type BatchFormat } from '../binDownloads';

/**
 * One print batch box: an editable name, per-row confirm and fail actions
 * (confirm supports a partial amount through an inline input) and a download
 * menu with the three export formats. There is no plate preview; the layout
 * is arranged automatically inside the download.
 */

const props = defineProps<{ batch: PrintBatch }>();

const queue = useBinQueue();

function labelIconOf(name: string | null): LabelIcon | null {
  return name !== null ? resolveLabelIcon(name) : null;
}

function itemTitle(item: BatchItem): string {
  return item.params.labelText !== '' ? item.params.labelText : sizeText(item);
}

function sizeText(item: BatchItem): string {
  return `${item.params.gridX} x ${item.params.gridY} x ${item.params.heightUnits}`;
}

// Name editing commits on change (blur or Enter).
function commitName(value: string): void {
  const name = value.trim();
  if (name !== '' && name !== props.batch.name) queue.renameBatch(props.batch.id, name);
}

// Confirm flow: clicking the checkmark opens an inline amount input that
// defaults to the item's full count, so a partial print can be confirmed.
const confirmingItemId = ref<string | null>(null);
const confirmAmount = ref(1);

function startConfirm(item: BatchItem): void {
  confirmingItemId.value = item.id;
  confirmAmount.value = item.count;
}

function commitConfirm(item: BatchItem): void {
  const amount = Math.min(Math.max(1, Math.floor(confirmAmount.value)), item.count);
  confirmingItemId.value = null;
  queue.confirmBatchItem(props.batch.id, item.id, amount);
}

// Downloads.
const downloading = ref(false);
const progressText = ref('');
const errorMessage = ref<string | null>(null);

const formats: { format: BatchFormat; title: string; detail: string }[] = [
  {
    format: 'stl',
    title: 'STL (all bins merged)',
    detail: 'One mesh; arrange it yourself in any slicer.',
  },
  {
    format: '3mf-single',
    title: '3MF, single color',
    detail: 'One filament, the labels merged into their bins.',
  },
  {
    format: '3mf-two',
    title: '3MF, two filaments',
    detail: 'Body and label slots for toolchanger printing in Orca Slicer.',
  },
];

async function download(format: BatchFormat): Promise<void> {
  downloading.value = true;
  errorMessage.value = null;
  try {
    await downloadBatch(
      // Custom icon paths are resolved inside the worker client.
      props.batch.items.map((item) => ({ params: item.params, count: item.count })),
      format,
      props.batch.name,
      (text) => {
        progressText.value = text;
      },
    );
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Generating the download failed.';
  } finally {
    downloading.value = false;
    progressText.value = '';
  }
}
</script>

<template>
  <v-card variant="outlined" class="batch-box mb-4">
    <div class="d-flex align-center flex-wrap ga-2 px-4 py-2 batch-head">
      <span class="text-caption font-weight-bold text-primary text-uppercase">Batch:</span>
      <v-text-field
        :model-value="batch.name"
        density="compact"
        variant="plain"
        hide-details
        class="batch-name flex-grow-0"
        @change="commitName(($event.target as HTMLInputElement).value)"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <v-spacer />
      <v-btn
        variant="outlined"
        size="small"
        color="success"
        prepend-icon="mdi-check-all"
        @click="queue.confirmAll(batch.id)"
      >
        Confirm all
      </v-btn>
      <v-menu>
        <template #activator="{ props: menuProps }">
          <v-btn
            variant="outlined"
            size="small"
            prepend-icon="mdi-download-outline"
            append-icon="mdi-menu-down"
            :loading="downloading"
            v-bind="menuProps"
          >
            Download
          </v-btn>
        </template>
        <v-list density="comfortable" min-width="280">
          <v-list-item
            v-for="entry in formats"
            :key="entry.format"
            :title="entry.title"
            :subtitle="entry.detail"
            :disabled="downloading"
            @click="download(entry.format)"
          />
        </v-list>
      </v-menu>
    </div>
    <v-divider />
    <div class="pa-2">
      <p v-if="downloading" class="text-body-2 px-2 py-1 mb-1">
        <v-progress-circular indeterminate size="16" width="2" class="mr-2" />
        {{ progressText }}
      </p>
      <v-alert v-if="errorMessage" type="error" density="compact" class="ma-2">
        {{ errorMessage }}
      </v-alert>
      <div
        v-for="item in batch.items"
        :key="item.id"
        class="d-flex align-center ga-3 px-3 py-2 batch-row"
      >
        <span class="swatch d-flex align-center justify-center">
          <svg
            v-if="labelIconOf(item.params.labelIcon) !== null"
            width="18"
            height="18"
            :viewBox="labelIconOf(item.params.labelIcon)!.viewBox.join(' ')"
            aria-hidden="true"
          >
            <path
              :d="labelIconOf(item.params.labelIcon)!.path"
              fill="currentColor"
              fill-rule="evenodd"
            />
          </svg>
          <v-icon v-else icon="mdi-cube-outline" size="16" class="text-medium-emphasis" />
        </span>
        <span class="row-name">
          <span class="d-block text-body-2 font-weight-bold">{{ itemTitle(item) }}</span>
          <span
            v-if="item.params.labelText2 !== ''"
            class="d-block text-caption text-medium-emphasis"
          >
            {{ item.params.labelText2 }}
          </span>
        </span>
        <span class="text-caption text-medium-emphasis row-dims">{{ sizeText(item) }}</span>
        <v-chip size="small" variant="outlined">x{{ item.count }}</v-chip>
        <v-spacer />
        <template v-if="confirmingItemId === item.id">
          <div class="d-flex align-center ga-1 confirm-inline pa-1 pl-2">
            <span class="text-caption text-success font-weight-bold">Printed:</span>
            <v-text-field
              v-model.number="confirmAmount"
              type="number"
              min="1"
              :max="item.count"
              density="compact"
              hide-details
              style="width: 70px"
              autofocus
              @keydown.enter.prevent="commitConfirm(item)"
              @keydown.esc="confirmingItemId = null"
            />
            <span class="text-caption text-medium-emphasis">of {{ item.count }}</span>
            <v-btn size="small" color="success" variant="flat" @click="commitConfirm(item)">
              OK
            </v-btn>
            <v-btn
              icon
              size="x-small"
              variant="text"
              @click="confirmingItemId = null"
            >
              <v-icon icon="mdi-close" size="16" />
              <v-tooltip activator="parent" location="bottom">Cancel</v-tooltip>
            </v-btn>
          </div>
        </template>
        <template v-else>
          <v-btn icon size="small" variant="text" color="success" @click="startConfirm(item)">
            <v-icon icon="mdi-check" size="18" />
            <v-tooltip activator="parent" location="bottom">Confirm printed</v-tooltip>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            color="error"
            @click="queue.failBatchItem(batch.id, item.id)"
          >
            <v-icon icon="mdi-close" size="18" />
            <v-tooltip activator="parent" location="bottom">
              Failed, return to queue
            </v-tooltip>
          </v-btn>
        </template>
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.batch-box {
  border-color: rgba(var(--v-theme-primary), 0.5);
}

.batch-head {
  background: rgba(var(--v-theme-primary), 0.08);
}

.batch-name :deep(input) {
  font-weight: 700;
  min-width: 160px;
}

.batch-row {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  margin-bottom: 6px;
}

.swatch {
  width: 34px;
  height: 28px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 6px;
  flex-shrink: 0;
}

.row-name {
  min-width: 140px;
}

.row-dims {
  font-family: monospace;
}

.confirm-inline {
  border: 1px solid rgba(var(--v-theme-success), 0.5);
  border-radius: 8px;
}
</style>
