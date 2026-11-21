import type { DividerWall } from '../gridfinity/dividerModel';
import { binProduct, type ProductChoice } from './manualProduct';
import {
  composeLabelText,
  HEAD_ICON_NAME,
  isLengthlessHead,
  screwBinWidthUnits,
  type HeadType,
  type ScrewBatch,
} from './screwListImport';
import { assertNever, type LabelContent, type Product, type ScrewSpec } from './types';

/**
 * The single home for turning parsed screw shorthand batches into queue
 * products: completeness, bin sizing (with the user's size override), label
 * text and icon, the screw description, the product packaging and the height
 * rule. The parser itself stays in screwListImport; this module consumes its
 * batches. Pure functions, no Vue or DOM.
 */

/**
 * Default bin height for a screw entry when nothing else determines it. Bin
 * sizing does not derive a minimum height from the screw length, so this is a
 * plain starting value; a comma-separated list always uses it.
 */
export const DEFAULT_SCREW_HEIGHT_UNITS = 6;

/** A screw bin is one grid cell deep unless the user's size override says otherwise. */
export const SCREW_BIN_DEPTH_UNITS = 1;

export const SCREW_HEIGHT_INVALID_MESSAGE =
  'The height must be a number of at least 2 height units.';

export const SCREW_SIZE_INVALID_MESSAGE =
  'The bin width and depth must be whole numbers of at least 1 grid unit.';

/** A screw bin footprint in grid units. */
export interface ScrewBinSize {
  width: number;
  depth: number;
}

/** Whether a height in height units is acceptable for a screw bin. */
export function isValidScrewHeight(heightUnits: number): boolean {
  return Number.isFinite(heightUnits) && heightUnits >= 2;
}

/** Whether a screw bin footprint is whole grid units of at least 1 on both axes. */
export function isValidScrewBinSize(size: ScrewBinSize): boolean {
  return (
    Number.isInteger(size.width) &&
    size.width >= 1 &&
    Number.isInteger(size.depth) &&
    size.depth >= 1
  );
}

/** The field a batch still lacks before it can become a product. */
export type MissingScrewField = 'thread' | 'length';

/**
 * The first field a batch lacks, in the order a screw is described, or null
 * when it is complete. A thread is always required; a length is required
 * unless the head carries none (nut, washer, threaded insert).
 */
export function missingScrewField(batch: ScrewBatch): MissingScrewField | null {
  if (batch.thread === null) return 'thread';
  if (!isLengthlessHead(batch.head) && batch.lengthMm === null) return 'length';
  return null;
}

/** Whether a parsed batch has everything needed to become a product. */
export function isScrewBatchComplete(batch: ScrewBatch): boolean {
  return missingScrewField(batch) === null;
}

/** What a batch has so far, as plain prose ('M3, countersunk screw, 20 mm'). Empty when nothing. */
export function recognizedScrewFields(batch: ScrewBatch): string {
  const parts: string[] = [];
  if (batch.thread !== null) parts.push(batch.thread);
  if (batch.head !== null) parts.push(batch.head);
  if (!isLengthlessHead(batch.head) && batch.lengthMm !== null) {
    parts.push(batch.enteredLengthText ?? `${batch.lengthMm} mm`);
  }
  return parts.join(', ');
}

/**
 * The guidance caption for an incomplete batch: one sentence of what is
 * recognized, one sentence naming the next missing field. Empty for a complete
 * batch.
 */
export function incompleteScrewBatchHint(batch: ScrewBatch): string {
  const missing = missingScrewField(batch);
  if (missing === null) return '';
  let instruction: string;
  switch (missing) {
    case 'thread':
      instruction = 'Add a thread size.';
      break;
    case 'length':
      instruction = 'Add a length.';
      break;
    default:
      return assertNever(missing);
  }
  const state = recognizedScrewFields(batch);
  return state === '' ? instruction : `${state}. ${instruction}`;
}

/**
 * The imperial length text a batch prints on its label. When an existing
 * screw is being edited, its inch text survives only while the length is
 * unchanged; a changed length drops the stale inch text and falls back to
 * whatever the shorthand parses.
 */
export function enteredLengthTextFor(
  batch: ScrewBatch,
  keepEnteredLengthFrom: ScrewSpec | null,
): string | null {
  if (keepEnteredLengthFrom !== null && batch.lengthMm === keepEnteredLengthFrom.lengthMm) {
    return keepEnteredLengthFrom.enteredLengthText;
  }
  return batch.enteredLengthText;
}

/** The label text a batch prints, complete or not. */
export function screwBatchLabelText(
  batch: ScrewBatch,
  keepEnteredLengthFrom: ScrewSpec | null,
): string {
  return composeLabelText(
    batch.thread,
    isLengthlessHead(batch.head) ? null : batch.lengthMm,
    batch.head,
    enteredLengthTextFor(batch, keepEnteredLengthFrom),
  );
}

/**
 * The screw description a complete batch turns into. A batch without a thread
 * is not complete, so passing one is a broken invariant and throws.
 */
export function screwSpecFor(
  batch: ScrewBatch,
  keepEnteredLengthFrom: ScrewSpec | null,
): ScrewSpec {
  if (batch.thread === null) {
    throw new Error('A screw description needs a thread; check isScrewBatchComplete first.');
  }
  return {
    thread: batch.thread,
    lengthMm: isLengthlessHead(batch.head) ? null : batch.lengthMm,
    head: batch.head,
    enteredLengthText: enteredLengthTextFor(batch, keepEnteredLengthFrom),
  };
}

/** The automatic footprint of a screw bin, from the engine's single sizing entry point. */
export function suggestedScrewBinSize(
  batch: Pick<ScrewBatch, 'thread' | 'lengthMm' | 'head'> | null,
): ScrewBinSize {
  return {
    width: screwBinWidthUnits({
      thread: batch?.thread ?? null,
      lengthMm: batch?.lengthMm ?? null,
      head: batch?.head ?? null,
    }),
    depth: SCREW_BIN_DEPTH_UNITS,
  };
}

/** Everything besides the batches that decides the products a screw entry creates. */
export interface ScrewProductOptions {
  /**
   * The packaging. 'insert' makes a standalone insert for an existing screw
   * bin; every other choice makes a bin with its insert, because a screw bin is
   * printed to carry the label naming its fastener and is never ordered bare.
   */
  productChoice: ProductChoice;
  /** Bin height for a single screw. A list of several batches uses DEFAULT_SCREW_HEIGHT_UNITS. */
  heightUnits: number;
  /** The user's chosen footprint, applied to every batch, or null to size each screw automatically. */
  sizeOverride: ScrewBinSize | null;
  magnetHoles: boolean;
  /** Whether a bin with its insert prints as one fused piece. */
  fused: boolean;
  /** Divider walls in bin-local mm, copied into every bin. */
  walls: readonly DividerWall[];
  /** The screw of the entry being edited, whose imperial length text survives an unchanged length. */
  keepEnteredLengthFrom?: ScrewSpec | null;
}

/** A batch that produced no product, with the user-worded reason. */
export interface SkippedScrewBatch {
  /** 0-based position of the batch in the parsed list. */
  index: number;
  /** What the batch had, as plain prose; empty when nothing was recognized. */
  recognized: string;
  missing: MissingScrewField;
  /** A complete sentence naming the entry and the field it lacks. */
  reason: string;
}

export interface ScrewProductsResult {
  /** One product per complete batch, in list order. */
  products: { product: Product; quantity: number }[];
  /** Every incomplete batch, never dropped silently. */
  skipped: SkippedScrewBatch[];
  /**
   * Why no product could be built from the complete batches (an invalid height
   * for a single screw, or an invalid size override), or null. When set,
   * products is empty.
   */
  problem: string | null;
}

function skipReason(index: number, recognized: string, missing: MissingScrewField): string {
  const entry = recognized === '' ? `Entry ${index + 1}` : `Entry ${index + 1} (${recognized})`;
  switch (missing) {
    case 'thread':
      return `${entry} has no thread size.`;
    case 'length':
      return `${entry} has no length.`;
    default:
      return assertNever(missing);
  }
}

/** The fields sizing and the label read, which a preview may have only partly. */
interface ScrewFields {
  thread: string | null;
  lengthMm: number | null;
  head: HeadType | null;
  enteredLengthText: string | null;
}

/** The width in cells and label content a screw turns into, honoring the size override. */
function sizedContent(
  fields: ScrewFields,
  sizeOverride: ScrewBinSize | null,
): { cells: number; content: LabelContent } {
  const effectiveLength = isLengthlessHead(fields.head) ? null : fields.lengthMm;
  return {
    // Sized from the overall length through the engine's single sizing entry
    // point; a user-chosen size overrides the suggestion for every batch.
    cells: sizeOverride?.width ?? suggestedScrewBinSize(fields).width,
    content: {
      text: composeLabelText(fields.thread, effectiveLength, fields.head, fields.enteredLengthText),
      text2: '',
      icon: fields.head !== null ? HEAD_ICON_NAME[fields.head] : null,
    },
  };
}

function buildScrewProduct(
  fields: ScrewFields,
  screw: ScrewSpec,
  heightUnits: number,
  options: ScrewProductOptions,
): Product {
  const { cells, content } = sizedContent(fields, options.sizeOverride);
  switch (options.productChoice) {
    case 'insert':
      return { kind: 'insert', origin: 'screw', cells, content, screw };
    case 'binWithInsert':
    case 'bin':
    case 'plainBin':
      // A screw bin is printed to carry the label naming its fastener, so every
      // bin choice packages it with its insert.
      return binProduct(
        {
          origin: 'screw',
          gridX: cells,
          gridY: options.sizeOverride?.depth ?? SCREW_BIN_DEPTH_UNITS,
          heightUnits,
          magnetHoles: options.magnetHoles,
          // Detached plain objects: products travel to the geometry worker by
          // structured clone and must never share walls with the form.
          walls: options.walls.map((wall) => ({ ...wall })),
          screw,
        },
        'binWithInsert',
        content,
        options.fused,
      );
    default:
      return assertNever(options.productChoice);
  }
}

/**
 * Turns parsed screw batches into the products a screw entry queues. Every
 * complete batch becomes one product at the batch's quantity; every incomplete
 * batch is listed in skipped with its reason. A single batch uses the given
 * height; a list of several batches uses DEFAULT_SCREW_HEIGHT_UNITS for every
 * bin. The size override, when set, applies to every batch.
 */
export function screwProducts(
  batches: readonly ScrewBatch[],
  options: ScrewProductOptions,
): ScrewProductsResult {
  const keep = options.keepEnteredLengthFrom ?? null;
  const complete: ScrewBatch[] = [];
  const skipped: SkippedScrewBatch[] = [];
  batches.forEach((batch, index) => {
    const missing = missingScrewField(batch);
    if (missing === null) {
      complete.push(batch);
      return;
    }
    const recognized = recognizedScrewFields(batch);
    skipped.push({ index, recognized, missing, reason: skipReason(index, recognized, missing) });
  });
  if (complete.length === 0) return { products: [], skipped, problem: null };
  const multiple = batches.length > 1;
  if (!multiple && !isValidScrewHeight(options.heightUnits)) {
    return { products: [], skipped, problem: SCREW_HEIGHT_INVALID_MESSAGE };
  }
  if (options.sizeOverride !== null && !isValidScrewBinSize(options.sizeOverride)) {
    return { products: [], skipped, problem: SCREW_SIZE_INVALID_MESSAGE };
  }
  const height = multiple ? DEFAULT_SCREW_HEIGHT_UNITS : options.heightUnits;
  return {
    products: complete.map((batch) => {
      const screw = screwSpecFor(batch, keep);
      return { product: buildScrewProduct(screw, screw, height, options), quantity: batch.quantity };
    }),
    skipped,
    problem: null,
  };
}

/**
 * The product a preview shows while a batch is still incomplete: built from
 * whatever has parsed so far (no thread gives an empty thread), at the given
 * height. Not for queueing; screwProducts is the queueing path.
 */
export function previewScrewProduct(
  batch: ScrewBatch | null,
  options: ScrewProductOptions,
): Product {
  const lengthMm = isLengthlessHead(batch?.head) ? null : (batch?.lengthMm ?? null);
  const fields: ScrewFields = {
    thread: batch?.thread ?? null,
    lengthMm,
    head: batch?.head ?? null,
    enteredLengthText: batch?.enteredLengthText ?? null,
  };
  const screw: ScrewSpec = { ...fields, thread: fields.thread ?? '' };
  return buildScrewProduct(fields, screw, options.heightUnits, options);
}
