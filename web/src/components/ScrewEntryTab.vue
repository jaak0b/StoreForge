<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinDesigner } from '../stores/binDesigner';
import { useBinQueue } from '../stores/binQueue';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { previewBinParams } from '../engine/plan/geometry';
import {
  binOf,
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
  screwBinWidthUnits,
  isLengthlessHead,
  HEAD_ALIASES,
  HEAD_ICON_NAME,
  parseShorthand,
  type HeadType,
  type ScrewBatch,
} from '../engine/plan/screwListImport';
import { applySuggestion, suggestShorthand, type ScrewSuggestion } from '../engine/plan/screwSuggest';
import BinViewport from './BinViewport.vue';
import ProductSelect from './ProductSelect.vue';
import MoreOptions from './MoreOptions.vue';

/**
 * The Screw entry tab of the add-bin card: one shorthand field ("m3x20 fhcs
 * x5") with an autocomplete menu of field completions and a live hint line
 * reflecting the parse, with the resulting product (computed size, label,
 * icon) previewing live beside it. A comma-separated shorthand list adds every
 * parsed screw at once; the hint line then lists each entry. The product
 * choice decides the packaging: a bin, a bin with its label insert, or just
 * the insert (a label for a screw bin that already exists).
 */

const app = useApp();
const queue = useBinQueue();
const store = useBinDesigner();
const { productChoice, fused } = storeToRefs(store);
const { smAndDown } = useDisplay();

/** Default bin height for a screw entry when nothing else determines it; the
 * engine does not derive a minimum height from screw length, so this is a
 * plain starting value the user can raise. */
const DEFAULT_HEIGHT_UNITS = 6;

const heightUnits = ref(DEFAULT_HEIGHT_UNITS);
const shorthand = ref('M3x20 fhcs x1');
const shorthandFocused = ref(false);

const previewLoaded = ref(!smAndDown.value);

const insertOnly = computed(() => productChoice.value === 'insert');

const HEIGHT_INVALID_MESSAGE = 'The height must be a whole number of at least 2 height units.';

const heightValid = computed(() => Number.isInteger(heightUnits.value) && heightUnits.value >= 2);

const heightRules = [
  (v: number) => (Number.isInteger(v) && v >= 2) || HEIGHT_INVALID_MESSAGE,
];

function headIconPath(headType: HeadType): string {
  return iconByName(HEAD_ICON_NAME[headType]).path;
}

/** The fastener silhouette for a head suggestion, or null when it has none. The
 * head alias is the last whitespace-separated token of the insert, since a
 * compact suggestion prepends the already-typed thread and length. */
function headIconForSuggestion(s: ScrewSuggestion): string | null {
  const alias = s.insert.split(/\s+/).pop() ?? '';
  const headType = HEAD_ALIASES[alias];
  return headType !== undefined ? headIconPath(headType) : null;
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
  const noLength = isLengthlessHead(batch.head);
  const effectiveLength = noLength ? null : batch.lengthMm;
  // Bins are sized from the overall length through the engine's single sizing
  // entry point: for heads measured under the head the head height is added,
  // and for heads measured overall (like countersunk) the nominal length is
  // used as is.
  return {
    cells: screwBinWidthUnits({
      thread: batch.thread,
      lengthMm: batch.lengthMm,
      head: batch.head,
    }),
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
  const bin = binOf(product);
  // This tab only ever composes insert and bin-bearing products.
  if (bin === null) return '';
  return `${bin.gridX} x ${bin.gridY} x ${bin.heightUnits}`;
}

function productLabelText(product: Product): string {
  return describeProduct(product).title;
}

// Parsing the shorthand field is the single source of truth for every derived
// value on this tab: there are no breakdown pickers to keep in sync.
const parsed = computed(() => parseShorthand(shorthand.value));
const isMultiple = computed(() => parsed.value.batches.length > 1);
const firstBatch = computed<ScrewBatch | null>(() => parsed.value.batches[0] ?? null);

function quickBatchComplete(batch: ScrewBatch): boolean {
  const noLength = isLengthlessHead(batch.head);
  return batch.thread !== null && (noLength || batch.lengthMm !== null);
}

const completeBatches = computed(() => parsed.value.batches.filter(quickBatchComplete));

// The autocomplete menu. The caret position drives which field of the segment
// under it the engine suggests completions for; the component holds no grammar
// knowledge of its own. `menuDismissed` lets Escape hide the menu until the
// next keystroke without blurring the field.
const shorthandWrap = ref<HTMLElement | null>(null);
const cursorPos = ref(0);
const highlightIndex = ref(0);
const menuDismissed = ref(false);

const suggestions = computed(() => suggestShorthand(shorthand.value, cursorPos.value));
const menuVisible = computed(
  () => shorthandFocused.value && !menuDismissed.value && suggestions.value.length > 0,
);

function inputEl(): HTMLInputElement | null {
  return shorthandWrap.value?.querySelector('input') ?? null;
}

function syncCursor(): void {
  const el = inputEl();
  if (el !== null) cursorPos.value = el.selectionStart ?? el.value.length;
}

function onShorthandInput(): void {
  menuDismissed.value = false;
  highlightIndex.value = 0;
  syncCursor();
}

function chooseSuggestion(s: ScrewSuggestion): void {
  const el = inputEl();
  const cursor = el?.selectionStart ?? cursorPos.value;
  const applied = applySuggestion(shorthand.value, cursor, s);
  shorthand.value = applied.value;
  highlightIndex.value = 0;
  void nextTick(() => {
    const restored = inputEl();
    if (restored !== null) {
      restored.focus();
      restored.setSelectionRange(applied.cursor, applied.cursor);
    }
    cursorPos.value = applied.cursor;
  });
}

function onShorthandKeydown(e: KeyboardEvent): void {
  if (menuVisible.value) {
    const count = suggestions.value.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        highlightIndex.value = (highlightIndex.value + 1) % count;
        return;
      case 'ArrowUp':
        e.preventDefault();
        highlightIndex.value = (highlightIndex.value - 1 + count) % count;
        return;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        chooseSuggestion(suggestions.value[highlightIndex.value] ?? suggestions.value[0]);
        return;
      case 'Escape':
        e.preventDefault();
        menuDismissed.value = true;
        return;
      default:
        return;
    }
  }
  if (e.key === 'Enter') addToQueue();
}

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
  const bin = binOf(product);
  return bin !== null && bin.origin === 'screw' ? bin.screw : null;
});

/**
 * The imperial length text a batch prints on its label. The loaded entry's
 * inch text survives only while the length is unchanged; editing the length
 * drops the stale inch text and falls back to whatever the shorthand parses.
 */
function enteredTextFor(batch: ScrewBatch): string | null {
  const screw = editingScrew.value;
  if (screw !== null && batch.lengthMm === screw.lengthMm) return screw.enteredLengthText;
  return batch.enteredLengthText;
}

// Editing a screw queue row rehydrates the breakdown, height and shared
// options from the entry's stored screw description.
watch(
  () => (app.editingKind === 'screw' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null || originOf(entry.product) !== 'screw') return;
    const product = entry.product;
    const bin = binOf(product);
    const screw =
      product.kind === 'insert'
        ? (product.origin === 'screw' ? product.screw : null)
        : bin !== null && bin.origin === 'screw'
          ? bin.screw
          : null;
    if (screw === null) return;
    if (bin !== null) heightUnits.value = bin.heightUnits;
    shorthand.value = composeShorthand(screw.thread, screw.lengthMm, screw.head, entry.quantity);
    const patch: Record<string, unknown> = {
      // The tab offers only these two choices, and a stored screw bin without
      // its insert is repaired to one on load, so nothing else can arrive.
      productChoice: product.kind === 'insert' ? 'insert' : 'binWithInsert',
      fused: product.kind === 'binWithInsert' ? product.fused ?? false : false,
      notes: entry.notes ?? '',
    };
    if (bin !== null && bin.origin === 'screw') {
      patch.magnetHoles = bin.magnetHoles;
      // The loaded entry's walls become the editor's walls, so editing a screw
      // bin that has dividers shows them rather than starting from empty.
      patch.walls = bin.walls.map((wall: DividerWall) => ({ ...wall }));
      patch.selectedWallIndex = null;
    }
    store.$patch(patch);
  },
  { immediate: true },
);

/** The screw description a complete parsed batch turns into. */
function screwFor(batch: ScrewBatch): ScrewSpec {
  const noLength = isLengthlessHead(batch.head);
  return {
    thread: batch.thread!,
    lengthMm: noLength ? null : batch.lengthMm,
    head: batch.head,
    enteredLengthText: enteredTextFor(batch),
  };
}

/** What Add to queue will do, driving both the hint line and the button's
 * enabled state. A comma list uses every complete parsed batch verbatim at the
 * default height; a single screw uses the editable Height field. While
 * editing, only a single screw is valid, since one queue row is being
 * updated. */
const pending = computed<{
  batches: Array<{ product: Product; quantity: number }>;
}>(() => {
  if (editingEntry.value !== null) {
    const batch = firstBatch.value;
    if (isMultiple.value || batch === null || !quickBatchComplete(batch) || !heightValid.value) {
      return { batches: [] };
    }
    const screw = screwFor(batch);
    return { batches: [{ product: productFor(screw, screw, heightUnits.value), quantity: batch.quantity }] };
  }
  const complete = completeBatches.value;
  if (complete.length === 0) return { batches: [] };
  if (!isMultiple.value && !heightValid.value) return { batches: [] };
  const height = isMultiple.value ? DEFAULT_HEIGHT_UNITS : heightUnits.value;
  return {
    batches: complete.map((batch) => {
      const screw = screwFor(batch);
      return { product: productFor(screw, screw, height), quantity: batch.quantity };
    }),
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
      .map(({ product }) => binOf(product)?.gridX ?? null)
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

/** One label-text summary per parsed batch, for the multi-screw hint list. */
const batchSummaries = computed(() =>
  parsed.value.batches.map((batch) => {
    const noLength = isLengthlessHead(batch.head);
    return {
      text: composeLabelText(
        batch.thread,
        noLength ? null : batch.lengthMm,
        batch.head,
        enteredTextFor(batch),
      ),
      quantity: batch.quantity,
    };
  }),
);

/** The next field a single incomplete batch still needs, in the order a screw
 * is described: a thread, then a length (unless the head carries none), then a
 * head type. Null once the batch is complete. */
function nextMissingField(batch: ScrewBatch): string | null {
  if (batch.thread === null) return 'Add a thread size.';
  const noLength = isLengthlessHead(batch.head);
  if (!noLength && batch.lengthMm === null) return 'Add a length.';
  if (batch.head === null) return 'Add a head type.';
  return null;
}

/** What a single incomplete batch has so far, as plain prose. */
function recognizedState(batch: ScrewBatch): string {
  const parts: string[] = [];
  if (batch.thread !== null) parts.push(batch.thread);
  if (batch.head !== null) parts.push(batch.head);
  const noLength = isLengthlessHead(batch.head);
  if (!noLength && batch.lengthMm !== null) {
    parts.push(batch.enteredLengthText ?? `${batch.lengthMm} mm`);
  }
  return parts.join(', ');
}

/**
 * The caption under the textbox for an incomplete single batch: one sentence
 * of what is recognized, one sentence naming the next missing field. Empty for
 * a complete batch (resultText covers it) and for a multi-screw list.
 */
const incompleteHint = computed(() => {
  if (isMultiple.value) return '';
  const batch = firstBatch.value;
  if (batch === null || quickBatchComplete(batch)) return '';
  const missing = nextMissingField(batch);
  const state = recognizedState(batch);
  if (missing === null) return '';
  return state === '' ? missing : `${state}. ${missing}`;
});

/** The single hint caption: the resulting bin, the multi-add count, or the
 * incomplete-batch guidance, whichever applies. */
const hintText = computed(() => (resultText.value !== '' ? resultText.value : incompleteHint.value));

const formValid = computed(() => pending.value.batches.length > 0 && wallProblem.value === null);

const addedSnackbar = ref(false);
const addedText = ref('');
// The queue's refusal of an invalid entry, shown beside the add button.
const saveError = ref<string | null>(null);

function addToQueue(): void {
  if (!formValid.value) return;
  saveError.value = null;
  const cleanNotes = store.notes.trim();
  const editing = editingEntry.value;
  if (editing !== null) {
    const { product, quantity } = pending.value.batches[0];
    saveError.value = queue.update(editing.id, {
      product,
      quantity,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    if (saveError.value !== null) return;
    addedText.value = `Updated ${productLabelText(product)} in the queue.`;
    addedSnackbar.value = true;
    app.stopEditing();
    return;
  }
  for (const { product, quantity } of pending.value.batches) {
    saveError.value = queue.add(product, quantity, cleanNotes);
    if (saveError.value !== null) return;
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

// The preview follows whichever product Add to queue would create first; while
// the batch is still incomplete it previews from whatever has parsed so far.
const previewProduct = computed<Product>(() => {
  const ready = pending.value.batches[0]?.product;
  if (ready !== undefined) return ready;
  const batch = firstBatch.value;
  const noLength = isLengthlessHead(batch?.head);
  return productFor(
    {
      thread: batch?.thread ?? null,
      lengthMm: noLength ? null : batch?.lengthMm ?? null,
      head: batch?.head ?? null,
      enteredLengthText: batch?.enteredLengthText ?? null,
    },
    {
      thread: batch?.thread ?? '',
      lengthMm: noLength ? null : batch?.lengthMm ?? null,
      head: batch?.head ?? null,
      enteredLengthText: batch?.enteredLengthText ?? null,
    },
    heightUnits.value,
  );
});

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
      <div ref="shorthandWrap" class="shorthand-wrap">
        <v-text-field
          v-model="shorthand"
          label="Screw"
          placeholder="m3x20 fhcs x5"
          prepend-inner-icon="mdi-pencil-outline"
          density="comfortable"
          hide-details
          autocomplete="off"
          @focus="shorthandFocused = true"
          @blur="shorthandFocused = false"
          @input="onShorthandInput"
          @click="syncCursor"
          @keyup="syncCursor"
          @keydown="onShorthandKeydown"
        />
        <v-list
          v-if="menuVisible"
          class="suggest-menu"
          density="compact"
          elevation="6"
          role="listbox"
        >
          <v-list-item
            v-for="(s, i) in suggestions"
            :key="`${s.kind}-${s.insert}`"
            :active="i === highlightIndex"
            role="option"
            @mousedown.prevent="chooseSuggestion(s)"
          >
            <template v-if="s.kind === 'head'" #prepend>
              <svg
                v-if="headIconForSuggestion(s) !== null"
                width="18"
                height="18"
                viewBox="0 0 100 100"
                class="mr-2"
                aria-hidden="true"
              >
                <path
                  :d="headIconForSuggestion(s) ?? ''"
                  fill="currentColor"
                  fill-rule="evenodd"
                />
              </svg>
            </template>
            <v-list-item-title>{{ s.label }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </div>
      <p class="text-caption text-medium-emphasis mt-1 mb-0">
        Separate screws with commas; imperial works too (#8 x 1-1/2" wood).
      </p>

      <p v-if="isMultiple && editingEntry !== null" class="text-error text-body-2 mt-3 mb-0">
        Remove the extra comma-separated screws to save; an edit updates one queue row.
      </p>

      <div v-if="hintText !== ''" class="d-flex align-center mt-3">
        <p class="text-caption text-medium-emphasis mb-0 mr-1">{{ hintText }}</p>
        <span class="d-inline-flex align-center">
          <v-icon icon="mdi-help-circle-outline" size="small" class="length-help" />
          <v-tooltip activator="parent" location="top" max-width="280">
            Bin width is sized from the screw's overall length. For head types that are measured
            overall, like countersunk screws, the nominal length is used as is. For head types
            measured under the head, the head height is added.
          </v-tooltip>
        </span>
      </div>
      <ul v-if="isMultiple" class="text-caption text-medium-emphasis mt-1 mb-0 ps-4">
        <li v-for="(s, i) in batchSummaries" :key="i">{{ s.text }} x {{ s.quantity }}</li>
      </ul>

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

      <v-alert
        v-if="!insertOnly && !isMultiple && !heightValid"
        type="warning"
        density="compact"
        variant="tonal"
        class="mt-2"
      >
        {{ HEIGHT_INVALID_MESSAGE }}
      </v-alert>

      <ProductSelect v-model="productChoice" v-model:fused="fused" hide-bin-alone class="mt-4" />

      <MoreOptions
        :per-bin-fields="false"
        :insert-only="insertOnly"
        :divider-notice="dividerNotice"
      >
        <template #fields>
          <v-text-field
            v-if="!insertOnly"
            v-model.number="heightUnits"
            type="number"
            min="2"
            step="1"
            label="Height"
            density="comfortable"
            :disabled="isMultiple"
            :rules="heightRules"
          />
        </template>
      </MoreOptions>

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
      <v-alert v-if="saveError" type="error" density="compact" class="mt-2">
        {{ saveError }}
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

.shorthand-wrap {
  position: relative;
}

.suggest-menu {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  max-height: 260px;
  overflow-y: auto;
  border-radius: 4px;
}
</style>
