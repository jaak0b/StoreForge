<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import type { ScrewSpec } from '../engine/plan/types';
import { useBinPreview } from '../composables/useBinPreview';
import { iconByName } from '../engine/label/icons';
import {
  composeLabelText,
  composeShorthand,
  computeBinWidthUnits,
  HEAD_ICON_NAME,
  HEAD_TYPES,
  LENGTHLESS_HEADS,
  MAX_LENGTH_MM,
  MIN_LENGTH_MM,
  parseShorthand,
  type HeadType,
  type ScrewBatch,
} from '../engine/plan/screwListImport';
import type { LabeledBinParams } from '../engine/gridfinity/types';
import BinViewport from './BinViewport.vue';
import MoreOptions from './MoreOptions.vue';

/**
 * The Screw entry tab of the add-bin card: one shorthand field ("m3x20 fhcs
 * x5") that parses live into a synced Thread/Head/Length/Count/Height
 * breakdown, with the resulting bin (computed size, label, icon) previewing
 * live beside it. A comma-separated shorthand list adds every parsed screw
 * at once; the breakdown then shows the first entry and disables editing,
 * since there is no single set of fields to edit.
 */

const app = useApp();
const queue = useBinQueue();
const store = useBinDesigner();
const { smAndDown } = useDisplay();

const METRIC_THREADS = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8'];
const IMPERIAL_THREADS = ['#4', '#6', '#8', '#10', '#12', '1/4-20', '5/16-18', '3/8-16'];

/** Thread choices grouped by measurement system. */
const THREAD_ITEMS = [
  { type: 'subheader' as const, title: 'Metric' },
  ...METRIC_THREADS,
  { type: 'subheader' as const, title: 'Imperial' },
  ...IMPERIAL_THREADS,
];

/** Default bin height for a screw entry when nothing else determines it; the
 * engine does not derive a minimum height from screw length, so this is a
 * plain starting value the user can raise. */
const DEFAULT_HEIGHT_UNITS = 6;

const thread = ref('M3');
const head = ref<HeadType | null>('countersunk screw');
const lengthMm = ref<number | null>(20);
const count = ref(5);
const heightUnits = ref(DEFAULT_HEIGHT_UNITS);
const shorthand = ref('M3x20 fhcs x5');
const shorthandFocused = ref(false);

const previewLoaded = ref(!smAndDown.value);

/** Head choices: the canonical head types plus an explicit none. */
const HEAD_ITEMS = [
  { title: 'No head type', value: null },
  ...HEAD_TYPES.map((h) => ({ title: h, value: h })),
];

const lengthless = computed(() => head.value !== null && LENGTHLESS_HEADS.has(head.value));

const lengthValid = computed(
  () =>
    lengthless.value ||
    (lengthMm.value !== null &&
      Number.isInteger(lengthMm.value) &&
      lengthMm.value >= MIN_LENGTH_MM &&
      lengthMm.value <= MAX_LENGTH_MM),
);

const countValid = computed(() => Number.isInteger(count.value) && count.value >= 1);
const heightValid = computed(() => Number.isInteger(heightUnits.value) && heightUnits.value >= 2);

function headIconPath(headType: HeadType): string {
  return iconByName(HEAD_ICON_NAME[headType]).path;
}

/** The bin a screw batch turns into (size from the length, label, icon). */
function binParamsFor(
  batch: {
    thread: string | null;
    lengthMm: number | null;
    head: HeadType | null;
    enteredLengthText?: string | null;
  },
  binHeightUnits: number,
): LabeledBinParams {
  const noLength = batch.head !== null && LENGTHLESS_HEADS.has(batch.head);
  const effectiveLength = noLength ? null : batch.lengthMm;
  return {
    gridX: effectiveLength !== null ? computeBinWidthUnits(effectiveLength) : 1,
    gridY: 1,
    heightUnits: binHeightUnits,
    stackingLip: store.stackingLip,
    magnetHoles: store.magnetHoles,
    dividerCountX: store.dividerCountX,
    dividerCountY: store.dividerCountY,
    labelText: composeLabelText(
      batch.thread,
      effectiveLength,
      batch.head,
      batch.enteredLengthText ?? null,
    ),
    labelText2: '',
    labelIcon: batch.head !== null ? HEAD_ICON_NAME[batch.head] : null,
  };
}

function sizeText(params: LabeledBinParams): string {
  return `${params.gridX} x ${params.gridY} x ${params.heightUnits}`;
}

// Parsing the shorthand field is the single source of truth; the breakdown
// pickers are a synced view onto it. `internalUpdate` suppresses the pickers
// -> shorthand watcher while the shorthand -> pickers watcher is applying a
// parse result, so the two directions never fight over the caret.
let internalUpdate = false;

const parsed = computed(() => parseShorthand(shorthand.value));
const isMultiple = computed(() => parsed.value.batches.length > 1);
const firstBatch = computed<ScrewBatch | null>(() => parsed.value.batches[0] ?? null);

watch(shorthand, () => {
  const batch = firstBatch.value;
  if (batch === null) return;
  internalUpdate = true;
  if (batch.thread !== null) thread.value = batch.thread;
  if (batch.head !== null) head.value = batch.head;
  if (batch.lengthMm !== null) lengthMm.value = batch.lengthMm;
  count.value = batch.quantity;
  internalUpdate = false;
});

watch([thread, head, lengthMm, count], () => {
  if (internalUpdate || shorthandFocused.value || isMultiple.value) return;
  shorthand.value = composeShorthand(thread.value, lengthMm.value, head.value, count.value);
});

function quickBatchComplete(batch: ScrewBatch): boolean {
  const noLength = batch.head !== null && LENGTHLESS_HEADS.has(batch.head);
  return batch.thread !== null && (noLength || batch.lengthMm !== null);
}

const completeBatches = computed(() => parsed.value.batches.filter(quickBatchComplete));

/** The queue entry being edited on this tab, or null when designing a new bin. */
const editingEntry = computed(() => {
  if (app.editingKind !== 'screw' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && entry.kind === 'screw' ? entry : null;
});

/**
 * The loaded entry's imperial length text stays on the label only while the
 * length itself is unchanged; editing the length drops the stale inch text.
 */
const keptEnteredText = computed(() =>
  editingEntry.value !== null && lengthMm.value === editingEntry.value.screw.lengthMm
    ? editingEntry.value.screw.enteredLengthText
    : null,
);

// Editing a screw queue row rehydrates the breakdown, height and shared
// options from the entry's stored screw description.
watch(
  () => (app.editingKind === 'screw' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null || entry.kind !== 'screw') return;
    internalUpdate = true;
    thread.value = entry.screw.thread;
    head.value = entry.screw.head;
    lengthMm.value = entry.screw.lengthMm;
    count.value = entry.quantity;
    heightUnits.value = entry.heightUnits;
    shorthand.value = composeShorthand(
      entry.screw.thread,
      entry.screw.lengthMm,
      entry.screw.head,
      entry.quantity,
    );
    internalUpdate = false;
    store.$patch({
      stackingLip: entry.stackingLip,
      magnetHoles: entry.magnetHoles,
      dividerCountX: entry.dividerCountX,
      dividerCountY: entry.dividerCountY,
      notes: entry.notes ?? '',
    });
  },
  { immediate: true },
);

/** What Add to queue will do, driving both the summary caption and the
 * button's enabled state. A single screw uses the breakdown fields (which
 * stay editable and independently validated); a comma list uses every
 * complete parsed batch verbatim. While editing, only a single screw is
 * valid, since one queue row is being updated. */
const pending = computed<{
  batches: Array<{ params: LabeledBinParams; quantity: number; screw: ScrewSpec }>;
}>(() => {
  if (isMultiple.value) {
    if (editingEntry.value !== null) return { batches: [] };
    return {
      batches: completeBatches.value.map((batch) => ({
        params: binParamsFor(batch, DEFAULT_HEIGHT_UNITS),
        quantity: batch.quantity,
        screw: {
          thread: batch.thread!,
          lengthMm: batch.head !== null && LENGTHLESS_HEADS.has(batch.head) ? null : batch.lengthMm,
          head: batch.head,
          enteredLengthText: batch.enteredLengthText,
        },
      })),
    };
  }
  if (!lengthValid.value || !countValid.value || !heightValid.value || thread.value.trim() === '') {
    return { batches: [] };
  }
  const screw: ScrewSpec = {
    thread: thread.value,
    lengthMm: lengthless.value ? null : lengthMm.value,
    head: head.value,
    enteredLengthText: keptEnteredText.value,
  };
  return {
    batches: [
      {
        params: binParamsFor(screw, heightUnits.value),
        quantity: count.value,
        screw,
      },
    ],
  };
});

const resultText = computed(() => {
  if (isMultiple.value) {
    const n = completeBatches.value.length;
    return n > 0 ? `Adds ${n} ${n === 1 ? 'bin' : 'bins'}.` : '';
  }
  if (pending.value.batches.length === 0) return '';
  const params = pending.value.batches[0].params;
  return `Resulting bin: ${params.labelText} (${sizeText(params)}).`;
});

const formValid = computed(() => pending.value.batches.length > 0);

const addedSnackbar = ref(false);
const addedText = ref('');

function addToQueue(): void {
  if (!formValid.value) return;
  const cleanNotes = store.notes.trim();
  const editing = editingEntry.value;
  if (editing !== null) {
    const { params, quantity, screw } = pending.value.batches[0];
    queue.update(editing.id, {
      ...params,
      quantity,
      screw,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    addedText.value = `Updated ${params.labelText} in the queue.`;
    addedSnackbar.value = true;
    app.stopEditing();
    return;
  }
  for (const { params, quantity, screw } of pending.value.batches) {
    const id = queue.add(params, quantity, { kind: 'screw', screw });
    if (cleanNotes !== '') queue.update(id, { notes: cleanNotes });
  }
  const n = pending.value.batches.length;
  addedText.value =
    n === 1
      ? `Added ${pending.value.batches[0].params.labelText} to the queue.`
      : `Added ${n} bins to the queue.`;
  addedSnackbar.value = true;
  if (isMultiple.value) shorthand.value = '';
}

function cancelEdit(): void {
  app.stopEditing();
}

// The preview follows whichever bin Add to queue would create first.
const previewParams = computed(
  () => pending.value.batches[0]?.params ?? binParamsFor({ thread: null, lengthMm: null, head: null }, heightUnits.value),
);

const { meshes, errorMessage } = useBinPreview(() => previewParams.value);
</script>

<template>
  <v-row>
    <v-col cols="12" md="6">
      <v-text-field
        v-model="shorthand"
        label="Screw"
        placeholder="m3x20 fhcs x5"
        prepend-inner-icon="mdi-pencil-outline"
        density="comfortable"
        hide-details
        @focus="shorthandFocused = true"
        @blur="shorthandFocused = false"
        @keydown.enter="addToQueue"
      />
      <p class="text-caption text-medium-emphasis mt-1 mb-0">
        Separate screws with commas; imperial works too (#8 x 1-1/2" wood).
      </p>

      <div class="text-caption text-medium-emphasis mt-4 mb-1">Breakdown</div>
      <div class="d-flex flex-wrap ga-2">
        <v-select
          v-model="thread"
          :items="THREAD_ITEMS"
          label="Thread"
          density="comfortable"
          hide-details
          :disabled="isMultiple"
          class="screw-field"
          style="min-width: 125px"
        />
        <v-select
          v-model="head"
          :items="HEAD_ITEMS"
          label="Head"
          density="comfortable"
          hide-details
          :disabled="isMultiple"
          class="screw-field"
          style="min-width: 150px"
        >
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps">
              <template #prepend>
                <svg
                  v-if="item.raw.value !== null"
                  width="18"
                  height="18"
                  viewBox="0 0 100 100"
                  class="mr-2"
                  aria-hidden="true"
                >
                  <path :d="headIconPath(item.raw.value)" fill="currentColor" fill-rule="evenodd" />
                </svg>
              </template>
            </v-list-item>
          </template>
        </v-select>
        <v-text-field
          v-model.number="lengthMm"
          type="number"
          :min="MIN_LENGTH_MM"
          :max="MAX_LENGTH_MM"
          step="1"
          label="Length"
          suffix="mm"
          density="comfortable"
          hide-details
          :disabled="isMultiple || lengthless"
          class="screw-field"
          style="min-width: 110px; max-width: 150px"
        />
        <v-text-field
          v-model.number="count"
          type="number"
          min="1"
          step="1"
          label="Count"
          density="comfortable"
          hide-details
          :disabled="isMultiple"
          class="screw-field"
          style="min-width: 90px; max-width: 120px"
        />
        <v-text-field
          v-model.number="heightUnits"
          type="number"
          min="2"
          step="1"
          label="Height"
          density="comfortable"
          hide-details
          :disabled="isMultiple"
          class="screw-field"
          style="min-width: 90px; max-width: 120px"
        />
      </div>
      <p v-if="isMultiple && editingEntry !== null" class="text-error text-body-2 mt-2 mb-0">
        Remove the extra comma-separated screws to save; an edit updates one queue row.
      </p>
      <p v-else-if="isMultiple" class="text-caption text-medium-emphasis mt-2 mb-0">
        The shorthand lists more than one screw; the breakdown shows the first entry only.
        Add to queue adds all of them.
      </p>
      <p v-else-if="!lengthValid" class="text-error text-body-2 mt-2 mb-0">
        The length must be a whole number between {{ MIN_LENGTH_MM }} and
        {{ MAX_LENGTH_MM }} mm.
      </p>
      <p v-else-if="!heightValid" class="text-error text-body-2 mt-2 mb-0">
        The height must be a whole number of at least 2 height units.
      </p>

      <p v-if="resultText !== ''" class="text-caption text-medium-emphasis mt-2 mb-0">
        {{ resultText }}
      </p>
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

      <MoreOptions :per-bin-fields="false" />

      <div class="d-flex ga-2 mt-4">
        <v-btn
          color="primary"
          variant="flat"
          size="large"
          class="flex-grow-1"
          :disabled="!formValid"
          @click="addToQueue"
        >
          {{ editingEntry !== null ? 'Save changes' : 'Add to queue' }}
        </v-btn>
        <v-btn v-if="editingEntry !== null" variant="outlined" size="large" @click="cancelEdit">
          Cancel edit
        </v-btn>
      </div>
      <v-alert
        v-if="editingEntry !== null"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        Editing "{{ editingEntry.labelText }}"; saving updates the queue row.
      </v-alert>
    </v-col>

    <v-col cols="12" md="6">
      <v-card variant="outlined" class="preview-card">
        <BinViewport
          v-if="previewLoaded"
          :mesh="meshes?.body ?? null"
          :label="meshes?.label ?? null"
        />
        <div
          v-else
          class="d-flex flex-column align-center justify-center text-center fill-height pa-8"
        >
          <v-icon icon="mdi-cube-outline" size="64" class="mb-4 text-medium-emphasis" />
          <p class="text-body-2 text-medium-emphasis mb-4">
            The 3D preview is paused on small screens.
          </p>
          <v-btn color="primary" variant="tonal" @click="previewLoaded = true">
            Load preview
          </v-btn>
        </div>
      </v-card>
      <v-alert v-if="errorMessage" type="error" density="compact" class="mt-2">
        {{ errorMessage }}
      </v-alert>
    </v-col>
  </v-row>

  <v-snackbar v-model="addedSnackbar" timeout="3000">
    {{ addedText }}
  </v-snackbar>
</template>

<style scoped>
.preview-card {
  min-height: 320px;
}

.screw-field {
  flex: 1 1 0;
}
</style>
