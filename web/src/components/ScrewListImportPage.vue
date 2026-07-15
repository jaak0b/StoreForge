<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinQueue } from '../stores/binQueue';
import { iconByName } from '../engine/label/icons';
import {
  composeLabelText,
  computeBinWidthUnits,
  groupBatchRows,
  HEAD_ICON_NAME,
  HEAD_TYPES,
  LENGTHLESS_HEADS,
  MAX_LENGTH_MM,
  MIN_LENGTH_MM,
  parseShorthand,
  type BatchGroup,
  type HeadType,
} from '../engine/plan/screwListImport';
import { PITCH } from '../engine/gridfinity/constants';

const app = useApp();
const queue = useBinQueue();
const { smAndDown } = useDisplay();

const THREADS = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8'];

/** Bin widths beyond this many grid units get a soft warning on the chip. */
const WIDTH_WARNING_UNITS = 3;

/** Defaults matching the designer's initial bin. */
const DEFAULT_HEIGHT_UNITS = 3;
const DEFAULT_STACKING_LIP = true;
const DEFAULT_MAGNET_HOLES = false;

interface Row {
  id: number;
  thread: string | null;
  lengthMm: number | null;
  head: HeadType | null;
  qty: number;
  /** Manual bin width override in grid units, or null to derive from length. */
  widthOverride: number | null;
}

let nextRowId = 1;
const rows = ref<Row[]>([]);

// Sticky defaults the quick-pick chips set and "+ Add row" reads.
const defaultThread = ref<string | null>(null);
const defaultHead = ref<HeadType | null>(null);

// Step: batch entry table, then grouped review.
const step = ref<'entry' | 'review'>('entry');

// Shorthand field with live parse preview.
const shorthand = ref('');
const parsed = computed(() => parseShorthand(shorthand.value));
const previewLabels = computed(() =>
  parsed.value.batches.map(
    (b) =>
      `${composeLabelText(b.thread, b.lengthMm, b.head) || '?'}${b.quantity > 1 ? ` x${b.quantity}` : ''}`,
  ),
);

function commitShorthand(): void {
  const { batches } = parsed.value;
  if (batches.length === 0) return;
  for (const batch of batches) {
    rows.value.push({
      id: nextRowId++,
      thread: batch.thread,
      lengthMm: batch.lengthMm,
      head: batch.head,
      qty: batch.quantity,
      widthOverride: null,
    });
  }
  shorthand.value = '';
}

function isLengthless(row: Row): boolean {
  return row.head !== null && LENGTHLESS_HEADS.has(row.head);
}

function derivedWidth(row: Row): number {
  if (isLengthless(row) || row.lengthMm === null) return 1;
  return computeBinWidthUnits(row.lengthMm);
}

function effectiveWidth(row: Row): number {
  return row.widthOverride ?? derivedWidth(row);
}

function rowValid(row: Row): boolean {
  if (row.thread === null) return false;
  if (isLengthless(row)) return true;
  return (
    row.lengthMm !== null &&
    row.lengthMm >= MIN_LENGTH_MM &&
    row.lengthMm <= MAX_LENGTH_MM
  );
}

const validRows = computed(() => rows.value.filter(rowValid));
const invalidCount = computed(() => rows.value.length - validRows.value.length);

function rowLabel(row: Row): string {
  return composeLabelText(row.thread, isLengthless(row) ? null : row.lengthMm, row.head);
}

function headIconPath(head: HeadType): string {
  return iconByName(HEAD_ICON_NAME[head]).path;
}

function onLengthInput(row: Row, value: string): void {
  const parsedValue = Number(value);
  row.lengthMm = value === '' || !Number.isFinite(parsedValue) ? null : Math.round(parsedValue);
  // A stale manual width no longer belongs to the new length.
  row.widthOverride = null;
}

function addRow(): void {
  const last = rows.value[rows.value.length - 1];
  rows.value.push({
    id: nextRowId++,
    thread: last?.thread ?? defaultThread.value,
    lengthMm: last?.lengthMm ?? null,
    head: last?.head ?? defaultHead.value,
    qty: 1,
    widthOverride: null,
  });
}

async function onRowEnter(): Promise<void> {
  addRow();
  await nextTick();
  const newRow = rows.value[rows.value.length - 1];
  document.getElementById(`screw-length-${newRow.id}`)?.focus();
}

function duplicateRow(row: Row): void {
  const index = rows.value.findIndex((r) => r.id === row.id);
  rows.value.splice(index + 1, 0, { ...row, id: nextRowId++ });
}

function deleteRow(row: Row): void {
  rows.value = rows.value.filter((r) => r.id !== row.id);
}

// Width override editing: one row's chip opens an inline number field.
const overrideEditingId = ref<number | null>(null);

function widthChipText(row: Row): string {
  const units = effectiveWidth(row);
  return `${units} ${units === 1 ? 'unit' : 'units'} (${units * PITCH} mm)`;
}

// Review step: groups get editable quantity, depth and height.
interface ReviewGroup extends BatchGroup {
  gridY: number;
  heightUnits: number;
}

const reviewGroups = ref<ReviewGroup[]>([]);

function enterReview(): void {
  reviewGroups.value = groupBatchRows(
    validRows.value.map((row) => ({
      thread: row.thread,
      lengthMm: isLengthless(row) ? null : row.lengthMm,
      head: row.head,
      quantity: row.qty,
      widthUnits: effectiveWidth(row),
    })),
  ).map((group) => ({
    ...group,
    gridY: 1,
    heightUnits: DEFAULT_HEIGHT_UNITS,
  }));
  step.value = 'review';
}

function deleteGroup(index: number): void {
  reviewGroups.value.splice(index, 1);
}

const totalBins = computed(() => reviewGroups.value.length);
const totalQuantity = computed(() =>
  reviewGroups.value.reduce((sum, group) => sum + group.quantity, 0),
);

function commitToQueue(): void {
  for (const group of reviewGroups.value) {
    queue.add(
      {
        gridX: group.widthUnits,
        gridY: group.gridY,
        heightUnits: group.heightUnits,
        stackingLip: DEFAULT_STACKING_LIP,
        magnetHoles: DEFAULT_MAGNET_HOLES,
        labelText: composeLabelText(group.thread, group.lengthMm, group.head),
        labelIcon: group.head !== null ? HEAD_ICON_NAME[group.head] : null,
      },
      group.quantity,
    );
  }
  app.showQueue();
}

function groupLabel(group: ReviewGroup): string {
  return composeLabelText(group.thread, group.lengthMm, group.head);
}

// Leaving with unsaved rows asks for confirmation.
const discardDialogOpen = ref(false);

function requestLeave(): void {
  if (rows.value.length === 0) app.showQueue();
  else discardDialogOpen.value = true;
}
</script>

<template>
  <v-container fluid class="screw-import-page">
    <v-toolbar density="comfortable" color="surface" flat rounded>
      <v-btn icon variant="text" @click="requestLeave">
        <v-icon icon="mdi-arrow-left" />
        <v-tooltip activator="parent" location="bottom">Back to the queue</v-tooltip>
      </v-btn>
      <v-toolbar-title>Add bins from a screw list</v-toolbar-title>
    </v-toolbar>

    <template v-if="step === 'entry'">
      <v-text-field
        v-model="shorthand"
        class="mt-4"
        label="Type a screw list"
        placeholder="m3x20 fhcs, m4x40 hex bolt x6"
        density="comfortable"
        variant="outlined"
        hide-details
        autofocus
        @keydown.enter.prevent="commitShorthand"
      />
      <div v-if="previewLabels.length > 0" class="d-flex flex-wrap ga-1 mt-2">
        <v-chip
          v-for="(label, i) in previewLabels"
          :key="i"
          size="small"
          variant="tonal"
          color="primary"
        >
          {{ label }}
        </v-chip>
        <span class="text-caption text-medium-emphasis align-self-center ml-1">
          Press Enter to add {{ previewLabels.length === 1 ? 'this row' : 'these rows' }}.
        </span>
      </div>
      <v-alert
        v-for="(error, i) in parsed.errors"
        :key="i"
        type="warning"
        density="compact"
        variant="tonal"
        class="mt-2"
      >
        {{ error }}
      </v-alert>

      <div class="mt-4">
        <div class="text-caption text-medium-emphasis mb-1">
          Defaults for new rows
        </div>
        <v-chip-group
          v-model="defaultThread"
          selected-class="text-primary"
          column
        >
          <v-chip
            v-for="thread in THREADS"
            :key="thread"
            :value="thread"
            size="small"
            filter
          >
            {{ thread }}
          </v-chip>
        </v-chip-group>
        <v-chip-group
          v-model="defaultHead"
          selected-class="text-primary"
          column
        >
          <v-chip
            v-for="head in HEAD_TYPES"
            :key="head"
            :value="head"
            size="small"
            filter
          >
            <template #prepend>
              <svg width="14" height="14" viewBox="0 0 100 100" class="mr-1" aria-hidden="true">
                <path :d="headIconPath(head)" fill="currentColor" fill-rule="evenodd" />
              </svg>
            </template>
            {{ head }}
          </v-chip>
        </v-chip-group>
      </div>

      <!-- Wide screens: an editable table. -->
      <v-table v-if="!smAndDown && rows.length > 0" density="compact" class="mt-2">
        <thead>
          <tr>
            <th style="width: 100px">Thread</th>
            <th style="width: 100px">Length (mm)</th>
            <th style="width: 170px">Head type</th>
            <th style="width: 80px">Qty</th>
            <th>Preview</th>
            <th style="width: 160px">Bin width</th>
            <th style="width: 110px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" @keydown.enter.prevent="onRowEnter">
            <td>
              <v-select
                v-model="row.thread"
                :items="THREADS"
                density="compact"
                hide-details
                variant="plain"
              />
            </td>
            <td>
              <v-text-field
                :id="`screw-length-${row.id}`"
                :model-value="row.lengthMm ?? ''"
                :disabled="isLengthless(row)"
                type="number"
                :min="MIN_LENGTH_MM"
                :max="MAX_LENGTH_MM"
                density="compact"
                hide-details
                variant="plain"
                @update:model-value="onLengthInput(row, $event)"
              />
            </td>
            <td>
              <v-select
                v-model="row.head"
                :items="HEAD_TYPES"
                clearable
                density="compact"
                hide-details
                variant="plain"
              >
                <template #item="{ props: itemProps, item }">
                  <v-list-item v-bind="itemProps">
                    <template #prepend>
                      <svg width="18" height="18" viewBox="0 0 100 100" class="mr-2" aria-hidden="true">
                        <path :d="headIconPath(item.raw)" fill="currentColor" fill-rule="evenodd" />
                      </svg>
                    </template>
                  </v-list-item>
                </template>
              </v-select>
            </td>
            <td>
              <v-text-field
                v-model.number="row.qty"
                type="number"
                min="1"
                density="compact"
                hide-details
                variant="plain"
              />
            </td>
            <td>
              <span class="d-inline-flex align-center ga-1">
                <svg
                  v-if="row.head !== null"
                  width="20"
                  height="20"
                  viewBox="0 0 100 100"
                  aria-hidden="true"
                >
                  <path :d="headIconPath(row.head)" fill="currentColor" fill-rule="evenodd" />
                </svg>
                <v-icon v-else icon="mdi-help-circle-outline" size="20" class="text-medium-emphasis" />
                {{ rowLabel(row) }}
              </span>
            </td>
            <td>
              <v-select
                v-if="overrideEditingId === row.id"
                :model-value="effectiveWidth(row)"
                :items="[1, 2, 3, 4, 5, 6]"
                density="compact"
                hide-details
                variant="plain"
                @update:model-value="
                  row.widthOverride = $event === derivedWidth(row) ? null : $event;
                  overrideEditingId = null;
                "
              />
              <v-chip
                v-else
                size="small"
                variant="tonal"
                @click="overrideEditingId = row.id"
              >
                <template v-if="row.widthOverride !== null" #prepend>
                  <v-icon icon="mdi-pencil" size="14" class="mr-1" />
                </template>
                {{ widthChipText(row) }}
                <v-icon
                  v-if="effectiveWidth(row) > WIDTH_WARNING_UNITS"
                  icon="mdi-alert-outline"
                  size="14"
                  class="ml-1"
                >
                </v-icon>
                <v-tooltip
                  v-if="effectiveWidth(row) > WIDTH_WARNING_UNITS"
                  activator="parent"
                  location="bottom"
                >
                  This bin is wider than {{ WIDTH_WARNING_UNITS }} grid units.
                </v-tooltip>
              </v-chip>
            </td>
            <td>
              <v-icon
                v-if="!rowValid(row)"
                icon="mdi-alert-circle"
                color="error"
                size="20"
                class="mr-1"
              >
              </v-icon>
              <v-btn
                icon
                variant="text"
                size="small"
                @click="duplicateRow(row)"
              >
                <v-icon icon="mdi-content-copy" size="18" />
                <v-tooltip activator="parent" location="bottom">Duplicate row</v-tooltip>
              </v-btn>
              <v-btn icon variant="text" size="small" @click="deleteRow(row)">
                <v-icon icon="mdi-delete-outline" size="18" />
                <v-tooltip activator="parent" location="bottom">Delete row</v-tooltip>
              </v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>

      <!-- Small screens: one card per row with stacked fields. -->
      <template v-if="smAndDown && rows.length > 0">
        <v-card v-for="row in rows" :key="row.id" variant="outlined" class="mt-2">
          <v-card-text class="d-flex flex-column ga-2">
            <div class="d-flex align-center ga-1">
              <svg
                v-if="row.head !== null"
                width="20"
                height="20"
                viewBox="0 0 100 100"
                aria-hidden="true"
              >
                <path :d="headIconPath(row.head)" fill="currentColor" fill-rule="evenodd" />
              </svg>
              <v-icon v-else icon="mdi-help-circle-outline" size="20" class="text-medium-emphasis" />
              <span class="text-body-1">{{ rowLabel(row) || 'New row' }}</span>
              <v-icon
                v-if="!rowValid(row)"
                icon="mdi-alert-circle"
                color="error"
                size="20"
              >
              </v-icon>
              <v-spacer />
              <v-btn icon variant="text" size="small" @click="duplicateRow(row)">
                <v-icon icon="mdi-content-copy" size="18" />
              </v-btn>
              <v-btn icon variant="text" size="small" @click="deleteRow(row)">
                <v-icon icon="mdi-delete-outline" size="18" />
              </v-btn>
            </div>
            <v-select
              v-model="row.thread"
              :items="THREADS"
              label="Thread"
              density="compact"
              hide-details
            />
            <v-text-field
              :model-value="row.lengthMm ?? ''"
              :disabled="isLengthless(row)"
              label="Length (mm)"
              type="number"
              :min="MIN_LENGTH_MM"
              :max="MAX_LENGTH_MM"
              density="compact"
              hide-details
              @update:model-value="onLengthInput(row, $event)"
            />
            <v-select
              v-model="row.head"
              :items="HEAD_TYPES"
              label="Head type"
              clearable
              density="compact"
              hide-details
            />
            <v-text-field
              v-model.number="row.qty"
              label="Quantity"
              type="number"
              min="1"
              density="compact"
              hide-details
            />
            <v-chip size="small" variant="tonal" class="align-self-start">
              {{ widthChipText(row) }}
            </v-chip>
          </v-card-text>
        </v-card>
      </template>

      <div class="d-flex mt-2">
        <v-btn variant="text" prepend-icon="mdi-plus" @click="addRow">
          Add row
        </v-btn>
      </div>

      <div class="session-bar d-flex align-center py-3 px-2">
        <span v-if="invalidCount > 0" class="text-body-2 text-error mr-4">
          {{ invalidCount }} {{ invalidCount === 1 ? 'row needs' : 'rows need' }} attention
        </span>
        <v-spacer />
        <v-btn variant="text" @click="requestLeave">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          class="ml-2"
          :disabled="validRows.length === 0"
          @click="enterReview"
        >
          Review
        </v-btn>
      </div>
    </template>

    <template v-else>
      <v-card
        v-for="(group, index) in reviewGroups"
        :key="index"
        variant="outlined"
        class="mt-3"
      >
        <v-card-item>
          <template #prepend>
            <svg
              v-if="group.head !== null"
              width="28"
              height="28"
              viewBox="0 0 100 100"
              aria-hidden="true"
            >
              <path :d="headIconPath(group.head)" fill="currentColor" fill-rule="evenodd" />
            </svg>
            <v-icon v-else icon="mdi-help-circle-outline" size="28" class="text-medium-emphasis" />
          </template>
          <v-card-title>{{ groupLabel(group) }}</v-card-title>
          <v-card-subtitle>
            from {{ group.rowCount }} {{ group.rowCount === 1 ? 'row' : 'rows' }}
          </v-card-subtitle>
          <template #append>
            <v-btn icon variant="text" size="small" @click="deleteGroup(index)">
              <v-icon icon="mdi-delete-outline" size="18" />
              <v-tooltip activator="parent" location="bottom">Remove this bin</v-tooltip>
            </v-btn>
          </template>
        </v-card-item>
        <v-divider />
        <v-card-text class="d-flex flex-wrap align-center ga-4">
          <v-chip size="small" variant="tonal">
            {{ group.widthUnits }} x {{ group.gridY }} x {{ group.heightUnits }}
          </v-chip>
          <v-text-field
            v-model.number="group.gridY"
            label="Depth (cells)"
            type="number"
            min="1"
            density="compact"
            hide-details
            style="max-width: 120px"
          />
          <v-text-field
            v-model.number="group.heightUnits"
            label="Height (units)"
            type="number"
            min="2"
            density="compact"
            hide-details
            style="max-width: 120px"
          />
          <v-text-field
            v-model.number="group.quantity"
            label="Quantity"
            type="number"
            min="1"
            density="compact"
            hide-details
            style="max-width: 110px"
          />
        </v-card-text>
      </v-card>

      <p v-if="reviewGroups.length === 0" class="text-body-1 text-medium-emphasis text-center py-8">
        Nothing left to add.
      </p>

      <div class="session-bar d-flex align-center py-3 px-2">
        <span class="text-body-2 text-medium-emphasis mr-4">
          {{ totalQuantity }} {{ totalQuantity === 1 ? 'print' : 'prints' }} across
          {{ totalBins }} {{ totalBins === 1 ? 'bin' : 'bins' }}
        </span>
        <v-spacer />
        <v-btn variant="text" @click="step = 'entry'">Back to editing</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          class="ml-2"
          :disabled="reviewGroups.length === 0"
          @click="commitToQueue"
        >
          Add {{ totalBins }} {{ totalBins === 1 ? 'bin' : 'bins' }} to queue
        </v-btn>
      </div>
    </template>

    <v-dialog v-model="discardDialogOpen" max-width="440">
      <v-card>
        <v-card-title>Discard this screw list?</v-card-title>
        <v-card-text>
          The rows you entered have not been added to the queue yet. Leaving
          this page discards them.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="discardDialogOpen = false">Keep editing</v-btn>
          <v-btn color="error" variant="text" @click="app.showQueue()">Discard</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

  </v-container>
</template>

<style scoped>
.screw-import-page {
  max-width: 1100px;
}

.session-bar {
  position: sticky;
  bottom: 0;
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}
</style>
