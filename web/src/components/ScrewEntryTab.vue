<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import { useBinPreview } from '../composables/useBinPreview';
import { iconByName } from '../engine/label/icons';
import {
  composeLabelText,
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
 * The Screw entry tab of the add-bin card: one screw at a time through four
 * inputs, with the resulting bin (computed size, label, icon) previewing
 * live beside the form, plus a quick-input shorthand line below the Add
 * button. Both add straight to the queue.
 */

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

/** Height matching the designer's initial bin; the screw entry form does not
 * expose a height field, so it stays fixed. */
const DEFAULT_HEIGHT_UNITS = 3;

const thread = ref('M3');
const head = ref<HeadType>('countersunk screw');
const lengthMm = ref<number | null>(20);
const count = ref(5);

const previewLoaded = ref(!smAndDown.value);

const lengthless = computed(() => LENGTHLESS_HEADS.has(head.value));

const lengthValid = computed(
  () =>
    lengthless.value ||
    (lengthMm.value !== null &&
      Number.isInteger(lengthMm.value) &&
      lengthMm.value >= MIN_LENGTH_MM &&
      lengthMm.value <= MAX_LENGTH_MM),
);

const countValid = computed(() => Number.isInteger(count.value) && count.value >= 1);

function headIconPath(headType: HeadType): string {
  return iconByName(HEAD_ICON_NAME[headType]).path;
}

/** The bin a screw batch turns into (size from the length, label, icon). */
function binParamsFor(batch: {
  thread: string | null;
  lengthMm: number | null;
  head: HeadType | null;
  enteredLengthText?: string | null;
}): LabeledBinParams {
  const noLength = batch.head !== null && LENGTHLESS_HEADS.has(batch.head);
  const effectiveLength = noLength ? null : batch.lengthMm;
  return {
    gridX: effectiveLength !== null ? computeBinWidthUnits(effectiveLength) : 1,
    gridY: 1,
    heightUnits: DEFAULT_HEIGHT_UNITS,
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

const formBinParams = computed(() =>
  binParamsFor({
    thread: thread.value,
    lengthMm: lengthValid.value ? lengthMm.value : null,
    head: head.value,
  }),
);

function sizeText(params: LabeledBinParams): string {
  return `${params.gridX} x ${params.gridY} x ${params.heightUnits}`;
}

const formValid = computed(() => lengthValid.value && countValid.value);

const addedSnackbar = ref(false);
const addedText = ref('');

/** Adds the form's screw as a bin; the form keeps its values. */
function addFormBin(): void {
  if (!formValid.value) return;
  const cleanNotes = store.notes.trim();
  const id = queue.add(formBinParams.value, count.value);
  if (cleanNotes !== '') queue.update(id, { notes: cleanNotes });
  addedText.value = `Added ${formBinParams.value.labelText} to the queue.`;
  addedSnackbar.value = true;
}

// Quick input: the shorthand line below the button. Enter adds every parsed
// batch straight to the queue.
const shorthand = ref('');
const parsed = computed(() => parseShorthand(shorthand.value));

function quickBatchComplete(batch: ScrewBatch): boolean {
  const noLength = batch.head !== null && LENGTHLESS_HEADS.has(batch.head);
  return batch.thread !== null && (noLength || batch.lengthMm !== null);
}

const quickBatches = computed(() => parsed.value.batches.filter(quickBatchComplete));

const quickHint = computed(() => {
  if (shorthand.value.trim() === '') return '';
  if (quickBatches.value.length === 0) return '';
  const parts = quickBatches.value.map((batch) => {
    const params = binParamsFor(batch);
    const qty = batch.quantity > 1 ? ` x${batch.quantity}` : '';
    return `${params.labelText}${qty} (${sizeText(params)})`;
  });
  return `${parts.join(', ')}. Enter adds to queue.`;
});

function commitShorthand(): void {
  if (quickBatches.value.length === 0 || parsed.value.errors.length > 0) return;
  const cleanNotes = store.notes.trim();
  for (const batch of quickBatches.value) {
    const id = queue.add(binParamsFor(batch), batch.quantity);
    if (cleanNotes !== '') queue.update(id, { notes: cleanNotes });
  }
  addedText.value = `Added ${quickBatches.value.length} ${
    quickBatches.value.length === 1 ? 'bin' : 'bins'
  } to the queue.`;
  addedSnackbar.value = true;
  shorthand.value = '';
}

// The preview follows the quick-input line while it parses to something,
// otherwise the picker form.
const previewParams = computed(() =>
  quickBatches.value.length > 0 ? binParamsFor(quickBatches.value[0]) : formBinParams.value,
);

const { meshes, errorMessage } = useBinPreview(() => previewParams.value);
</script>

<template>
  <v-row>
    <v-col cols="12" md="6">
      <div class="text-caption text-medium-emphasis mb-1">Screw</div>
      <div class="d-flex flex-wrap ga-2">
        <v-select
          v-model="thread"
          :items="THREAD_ITEMS"
          label="Thread"
          density="comfortable"
          hide-details
          class="screw-field"
          style="min-width: 125px"
        />
        <v-select
          v-model="head"
          :items="HEAD_TYPES"
          label="Head"
          density="comfortable"
          hide-details
          class="screw-field"
          style="min-width: 150px"
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
          :disabled="lengthless"
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
          class="screw-field"
          style="min-width: 90px; max-width: 120px"
        />
      </div>
      <p v-if="!lengthValid" class="text-error text-body-2 mt-2 mb-0">
        The length must be a whole number between {{ MIN_LENGTH_MM }} and
        {{ MAX_LENGTH_MM }} mm.
      </p>

      <MoreOptions :per-bin-fields="false" />

      <v-btn
        color="primary"
        variant="flat"
        size="large"
        block
        class="mt-4"
        :disabled="!formValid"
        @click="addFormBin"
      >
        Add to queue
      </v-btn>
      <p class="text-caption text-medium-emphasis mt-2 mb-0">
        The form keeps its values after adding.
      </p>

      <v-divider class="mt-4 mb-3" />
      <div class="text-caption text-medium-emphasis mb-1">Quick input</div>
      <v-text-field
        v-model="shorthand"
        density="comfortable"
        placeholder="m3x20 fhcs x5, then Enter"
        prepend-inner-icon="mdi-pencil-outline"
        hide-details
        @keydown.enter.prevent="commitShorthand"
      />
      <p v-if="quickHint !== ''" class="text-caption text-medium-emphasis mt-1 mb-0">
        {{ quickHint }}
      </p>
      <p v-else class="text-caption text-medium-emphasis mt-1 mb-0">
        Separate screws with commas; imperial works too (#8 x 1-1/2" wood).
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
      <p class="text-caption text-medium-emphasis mt-2 mb-0">
        Resulting bin: {{ previewParams.labelText }} ({{ sizeText(previewParams) }}).
      </p>
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
