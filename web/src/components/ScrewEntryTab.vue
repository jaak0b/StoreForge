<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { previewBinParams } from '../engine/plan/geometry';
import {
  originOf,
  type LabelContent,
  type Product,
  type QueueEntry,
  type ScrewSpec,
} from '../engine/plan/types';
import { useBinPreview } from '../composables/useBinPreview';
import { generateInsert, generateSlottedBin } from '../workerClient';
import type { PartMeshes } from '../engine/gridfinity/types';
import { validateWalls, type DividerWall } from '../engine/gridfinity/dividerModel';
import { iconByName } from '../engine/label/icons';
import {
  composeLabelText,
  composeShorthand,
  computeBinWidthUnits,
  overallLengthMm,
  HEAD_ICON_NAME,
  HEAD_TYPES,
  IMPERIAL_THREADS,
  LENGTHLESS_HEADS,
  MAX_LENGTH_MM,
  METRIC_THREADS,
  MIN_LENGTH_MM,
  parseShorthand,
  type HeadType,
  type ScrewBatch,
} from '../engine/plan/screwListImport';
import BinViewport from './BinViewport.vue';
import ProductSelect from './ProductSelect.vue';
import MoreOptions from './MoreOptions.vue';

/**
 * The Screw entry tab of the add-bin card: one shorthand field ("m3x20 fhcs
 * x5") that parses live into a synced Thread/Head/Length/Count/Height
 * breakdown, with the resulting product (computed size, label, icon)
 * previewing live beside it. A comma-separated shorthand list adds every
 * parsed screw at once; the breakdown then shows the first entry and
 * disables editing, since there is no single set of fields to edit. The
 * product choice decides the packaging: a bin, a bin with its label insert,
 * or just the insert (a label for a screw bin that already exists).
 */

const app = useApp();
const queue = useBinQueue();
const store = useBinDesigner();
const { productChoice, fused } = storeToRefs(store);
const { smAndDown } = useDisplay();

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
const count = ref(1);
const heightUnits = ref(DEFAULT_HEIGHT_UNITS);
const shorthand = ref('M3x20 fhcs x1');
const shorthandFocused = ref(false);

const previewLoaded = ref(!smAndDown.value);

const insertOnly = computed(() => productChoice.value === 'insert');

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

/**
 * The divider walls of a screw bin live in the designer store, the same place
 * the Manual bin tab edits them, so both tabs share one editor and one wall
 * list. This tab derives the bin footprint from the screw rather than from a
 * field, and a comma list can produce bins of several widths at once. A wall
 * list is authored against one interior, so it is only meaningful when the
 * pending submit yields a single footprint: see singleFootprint below, which
 * gates both the editor and the submit.
 *
 * The walls are passed through as entered and never filtered here: a wall the
 * derived footprint cannot hold blocks the submit with the validator's own
 * message (see wallProblem) rather than disappearing on save.
 */
function wallsFor(): DividerWall[] {
  // Detached plain objects: the walls travel to the geometry worker by
  // structured clone, which cannot clone the store's reactive proxies.
  return store.walls.map((wall) => ({ ...wall }));
}

/** The width in cells and label content a screw batch turns into. */
function sizedContentFor(batch: {
  thread: string | null;
  lengthMm: number | null;
  head: HeadType | null;
  enteredLengthText?: string | null;
}): { cells: number; content: LabelContent } {
  const noLength = batch.head !== null && LENGTHLESS_HEADS.has(batch.head);
  const effectiveLength = noLength ? null : batch.lengthMm;
  // Bins are sized from the overall length: the head height is added for every
  // head type but the countersunk one, which is already measured overall.
  const overall = overallLengthMm({
    thread: batch.thread,
    lengthMm: effectiveLength,
    head: batch.head,
  });
  return {
    cells: overall !== null ? computeBinWidthUnits(overall) : 1,
    content: {
      text: composeLabelText(
        batch.thread,
        effectiveLength,
        batch.head,
        batch.enteredLengthText ?? null,
      ),
      text2: '',
      icon: batch.head !== null ? HEAD_ICON_NAME[batch.head] : null,
    },
  };
}

/** The product a screw batch turns into, per the current product choice. */
function productFor(
  batch: {
    thread: string | null;
    lengthMm: number | null;
    head: HeadType | null;
    enteredLengthText?: string | null;
  },
  screw: ScrewSpec,
  binHeightUnits: number,
): Product {
  const { cells, content } = sizedContentFor(batch);
  if (insertOnly.value) {
    return { kind: 'insert', origin: 'screw', cells, content, screw };
  }
  const bin = {
    origin: 'screw' as const,
    gridX: cells,
    gridY: 1,
    heightUnits: binHeightUnits,
    magnetHoles: store.magnetHoles,
    walls: wallsFor(),
    screw,
  };
  // A screw bin is printed to carry its label, so the tab offers no bin-alone
  // choice and never produces one.
  const product: Product = { kind: 'binWithInsert', bin, insert: content };
  if (store.fused) product.fused = true;
  return product;
}

function productSizeText(product: Product): string {
  if (product.kind === 'insert') return `${product.cells}u insert`;
  const bin = product.bin;
  return `${bin.gridX} x ${bin.gridY} x ${bin.heightUnits}`;
}

function productLabelText(product: Product): string {
  return describeProduct(product).title;
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

/** The queue entry being edited on this tab, or null when designing a new one. */
const editingEntry = computed<QueueEntry | null>(() => {
  if (app.editingKind !== 'screw' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && originOf(entry.product) === 'screw' ? entry : null;
});

/** The screw description stored on the entry being edited, or null. */
const editingScrew = computed<ScrewSpec | null>(() => {
  const entry = editingEntry.value;
  if (entry === null) return null;
  const product = entry.product;
  if (product.kind === 'insert') return product.origin === 'screw' ? product.screw : null;
  return product.bin.origin === 'screw' ? product.bin.screw : null;
});

/**
 * The loaded entry's imperial length text stays on the label only while the
 * length itself is unchanged; editing the length drops the stale inch text.
 */
const keptEnteredText = computed(() =>
  editingScrew.value !== null && lengthMm.value === editingScrew.value.lengthMm
    ? editingScrew.value.enteredLengthText
    : null,
);

// Editing a screw queue row rehydrates the breakdown, height and shared
// options from the entry's stored screw description.
watch(
  () => (app.editingKind === 'screw' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null || originOf(entry.product) !== 'screw') return;
    const product = entry.product;
    const screw =
      product.kind === 'insert'
        ? (product.origin === 'screw' ? product.screw : null)
        : product.bin.origin === 'screw'
          ? product.bin.screw
          : null;
    if (screw === null) return;
    internalUpdate = true;
    thread.value = screw.thread;
    head.value = screw.head;
    lengthMm.value = screw.lengthMm;
    count.value = entry.quantity;
    if (product.kind !== 'insert') heightUnits.value = product.bin.heightUnits;
    shorthand.value = composeShorthand(screw.thread, screw.lengthMm, screw.head, entry.quantity);
    internalUpdate = false;
    const patch: Record<string, unknown> = {
      // The tab offers only these two choices, and a stored screw bin without
      // its insert is repaired to one on load, so nothing else can arrive.
      productChoice: product.kind === 'insert' ? 'insert' : 'binWithInsert',
      fused: product.kind === 'binWithInsert' ? product.fused ?? false : false,
      notes: entry.notes ?? '',
    };
    if (product.kind !== 'insert' && product.bin.origin === 'screw') {
      patch.magnetHoles = product.bin.magnetHoles;
      // The loaded entry's walls become the editor's walls, so editing a screw
      // bin that has dividers shows them rather than starting from empty.
      patch.walls = product.bin.walls.map((wall: DividerWall) => ({ ...wall }));
      patch.selectedWallIndex = null;
    }
    store.$patch(patch);
  },
  { immediate: true },
);

/** What Add to queue will do, driving both the summary caption and the
 * button's enabled state. A single screw uses the breakdown fields (which
 * stay editable and independently validated); a comma list uses every
 * complete parsed batch verbatim. While editing, only a single screw is
 * valid, since one queue row is being updated. */
const pending = computed<{
  batches: Array<{ product: Product; quantity: number }>;
}>(() => {
  if (isMultiple.value) {
    if (editingEntry.value !== null) return { batches: [] };
    return {
      batches: completeBatches.value.map((batch) => ({
        product: productFor(
          batch,
          {
            thread: batch.thread!,
            lengthMm:
              batch.head !== null && LENGTHLESS_HEADS.has(batch.head) ? null : batch.lengthMm,
            head: batch.head,
            enteredLengthText: batch.enteredLengthText,
          },
          DEFAULT_HEIGHT_UNITS,
        ),
        quantity: batch.quantity,
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
        product: productFor(screw, screw, heightUnits.value),
        quantity: count.value,
      },
    ],
  };
});

/**
 * The distinct bin widths in cells the pending submit would produce. Divider
 * walls are bin-local millimetres against one interior, so a submit that
 * yields several widths has no single interior to author them against.
 */
const pendingFootprints = computed<number[]>(() => [
  ...new Set(
    pending.value.batches
      .map(({ product }) => (product.kind === 'insert' ? null : product.bin.gridX))
      .filter((cells): cells is number => cells !== null),
  ),
]);

/** The one footprint the pending submit produces, or null when it is not one. */
const singleFootprint = computed<number | null>(() =>
  pendingFootprints.value.length === 1 ? pendingFootprints.value[0] : null,
);

// The divider editor draws the interior from the store's footprint, so the
// derived screw footprint is published there. gridY is 1 because a screw bin
// is always one cell deep.
watch(
  singleFootprint,
  (cells) => {
    if (cells === null) return;
    store.gridX = cells;
    store.gridY = 1;
  },
  { immediate: true },
);

/**
 * Why the divider editor is unavailable, or null when it is offered. Walls
 * already entered are never discarded behind the user's back: while this is
 * set, the submit is blocked instead (see wallProblem).
 */
const dividerNotice = computed<string | null>(() => {
  if (insertOnly.value || singleFootprint.value !== null) return null;
  return 'Divider walls apply to one bin size. Enter a single screw to add them.';
});

/**
 * Why the entered divider walls stop the submit, or null when they are fine.
 * Walls are never dropped behind the user's back: either they go into every
 * bin the submit creates, or the submit says why they cannot. A wall list the
 * derived footprint cannot hold reports the divider validator's own message.
 */
const wallProblem = computed<string | null>(() => {
  if (insertOnly.value || store.walls.length === 0) return null;
  if (singleFootprint.value === null) {
    return (
      'The divider walls you entered fit one bin size, and this list produces bins of ' +
      'several widths. Enter one screw at a time, or delete the walls, to continue.'
    );
  }
  return validateWalls(store.walls, singleFootprint.value, 1);
});

const resultText = computed(() => {
  if (isMultiple.value) {
    const n = completeBatches.value.length;
    return n > 0 ? `Adds ${n} ${n === 1 ? 'entry' : 'entries'}.` : '';
  }
  if (pending.value.batches.length === 0) return '';
  const product = pending.value.batches[0].product;
  if (product.kind === 'insert') {
    return `Resulting label insert: ${product.content.text} (${product.cells}u wide).`;
  }
  return `Resulting bin: ${productLabelText(product)} (${productSizeText(product)}).`;
});

const formValid = computed(() => pending.value.batches.length > 0 && wallProblem.value === null);

const addedSnackbar = ref(false);
const addedText = ref('');

function addToQueue(): void {
  if (!formValid.value) return;
  const cleanNotes = store.notes.trim();
  const editing = editingEntry.value;
  if (editing !== null) {
    const { product, quantity } = pending.value.batches[0];
    queue.update(editing.id, {
      product,
      quantity,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    addedText.value = `Updated ${productLabelText(product)} in the queue.`;
    addedSnackbar.value = true;
    app.stopEditing();
    return;
  }
  for (const { product, quantity } of pending.value.batches) {
    queue.add(product, quantity, cleanNotes);
  }
  const n = pending.value.batches.length;
  addedText.value =
    n === 1
      ? `Added ${productLabelText(pending.value.batches[0].product)} to the queue.`
      : `Added ${n} entries to the queue.`;
  addedSnackbar.value = true;
  if (isMultiple.value) shorthand.value = '';
}

function cancelEdit(): void {
  app.stopEditing();
}

// The preview follows whichever product Add to queue would create first.
const previewProduct = computed<Product>(
  () =>
    pending.value.batches[0]?.product ??
    productFor(
      { thread: null, lengthMm: null, head: null },
      { thread: thread.value, lengthMm: null, head: null, enteredLengthText: null },
      heightUnits.value,
    ),
);

function generatePreview(product: Product): Promise<PartMeshes> {
  if (product.kind === 'insert') {
    return generateInsert({ cells: product.cells, content: product.content });
  }
  // The plan layer already derives a product's preview parameters, including
  // which origins carry divider walls; deriving them a second time here is how
  // the two would drift apart.
  return generateSlottedBin(previewBinParams(product)!);
}

const { meshes, errorMessage } = useBinPreview(() => previewProduct.value, generatePreview);
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
          style="min-width: 110px; max-width: 160px"
        >
          <template #append-inner>
            <v-icon icon="mdi-help-circle-outline" size="small" class="length-help" />
            <v-tooltip activator="parent" location="top" max-width="280">
              Bin width is sized from the screw's overall length. Countersunk screws (FHCS) are
              measured overall, so the nominal length is used as is. Other head types are measured
              under the head, so the head height is added.
            </v-tooltip>
          </template>
        </v-text-field>
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
          v-if="!insertOnly"
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

      <ProductSelect v-model="productChoice" v-model:fused="fused" hide-bin-alone class="mt-4" />

      <MoreOptions
        :per-bin-fields="false"
        :insert-only="insertOnly"
        :divider-notice="dividerNotice"
      />

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
      <v-alert v-if="wallProblem" type="warning" variant="tonal" density="compact" class="mt-2">
        {{ wallProblem }}
      </v-alert>
      <v-alert
        v-if="editingEntry !== null"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        Editing "{{ productLabelText(editingEntry.product) }}"; saving updates the queue row.
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
