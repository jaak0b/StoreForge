import type { PaperCorners, PaperKind, TracedTool, ToolPlacement } from '../trace/types';
import type { HeadType } from './screwListImport';

/**
 * Tool pockets sunk into a bin's interior, as designed on the Tool trace tab.
 * Plain JSON throughout so it serializes with the plan file. Each placement's
 * pocketDepthMm carries the depth, so no separate depth field lives here.
 */
export interface BinPockets {
  /** The traced (or primitive) tools the placements refer to. */
  tools: TracedTool[];
  /** Where each tool's pocket sits in the bin, with its depth. */
  placements: ToolPlacement[];
}

/**
 * The reference-sheet setup a traced bin's photo was rectified with. Stored
 * on the entry so re-tracing from the stored photo can skip corner detection
 * and reproduce the exact rectified image the tool clicks refer to.
 */
export interface TracePaper {
  /** Sheet corners in photo pixels, as confirmed by the user. */
  corners: PaperCorners;
  /** The reference sheet size the corners were rectified as. */
  kind: PaperKind;
}

/**
 * The canonical screw description of a screw-entry bin, in the screw parser's
 * normalized representation (see screwListImport), so the Screw entry tab can
 * rehydrate its breakdown form exactly. The shorthand string itself is not
 * stored: composeShorthand regenerates it from these fields and is the
 * documented round-trip inverse of the parser.
 */
export interface ScrewSpec {
  /** Thread size, normalized like 'M3', '#8' or '1/4-20'. */
  thread: string;
  /** Length in whole millimetres, or null for a lengthless head (nut, washer, insert). */
  lengthMm: number | null;
  /** Canonical head type, or null when unspecified. */
  head: HeadType | null;
  /** The length as entered for an imperial screw ('1-1/2"'), display only. */
  enteredLengthText: string | null;
}

/**
 * Exhaustiveness helper: a switch over a discriminated union in this module
 * calls this in its default branch, so adding a new case fails to compile in
 * every consumer.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Label content
// ---------------------------------------------------------------------------

/**
 * The printed content of one label insert: what gets printed on the small
 * swappable part that clips into a bin's label slot. Embossing labels
 * directly onto a bin body is no longer supported; every bin has the slot,
 * and the slot either holds a printed insert or is left empty.
 */
export interface LabelContent {
  /** Main label text. An empty string means no text. */
  text: string;
  /** Optional smaller second text line under the first. Empty means none. */
  text2: string;
  /** Name of the label icon shown left of the text, or null for no icon. */
  icon: string | null;
}

// ---------------------------------------------------------------------------
// Bin envelope and origin
// ---------------------------------------------------------------------------

/**
 * The physical envelope shared by every bin, regardless of how it was
 * designed. The label slot itself is not modeled here: its dimensions are
 * derived from gridX wherever an insert is printed for the bin, and its
 * geometry is interchangeable with the label slot on the Printables model
 * "Gridfinity bin with printable label by Pred" (printables.com/model/592545).
 */
export interface BinEnvelope {
  /** Number of grid cells along X (42 mm pitch each). Integer, at least 1. */
  gridX: number;
  /** Number of grid cells along Y (42 mm pitch each). Integer, at least 1. */
  gridY: number;
  /** Bin height in Gridfinity height units (7 mm each). Integer, at least 2. */
  heightUnits: number;
  /** Whether the bin has magnet holes under each foot. */
  magnetHoles: boolean;
}

/** A bin designed by hand on the Manual bin tab, with divider walls. */
export interface ManualBin extends BinEnvelope {
  origin: 'manual';
  /** Number of divider walls perpendicular to the X axis. Integer, at least 0. */
  dividerCountX: number;
  /** Number of divider walls perpendicular to the Y axis. Integer, at least 0. */
  dividerCountY: number;
}

/** A bin created from a screw description on the Screw entry tab, with divider walls. */
export interface ScrewBin extends BinEnvelope {
  origin: 'screw';
  /** Number of divider walls perpendicular to the X axis. Integer, at least 0. */
  dividerCountX: number;
  /** Number of divider walls perpendicular to the Y axis. Integer, at least 0. */
  dividerCountY: number;
  /** The screw the bin was sized for. */
  screw: ScrewSpec;
}

/**
 * A bin with tool pockets from the Tool trace tab. The pocket generator
 * rejects divider walls, so a traced bin deliberately carries no divider
 * fields at all: dividerCountX/Y are only legal on ManualBin and ScrewBin.
 */
export interface TracedBin extends BinEnvelope {
  origin: 'traced';
  /** The tool pockets sunk into the bin. */
  pockets: BinPockets;
  /**
   * Key of the original trace photo in this device's photo store. Absent for
   * plans imported from elsewhere or bins saved before photo storage; the
   * bin is then layout-only editable.
   */
  traceSourceId?: string;
  /** The reference-sheet setup the photo was rectified with, when known. */
  paper?: TracePaper;
}

/** A bin body of any origin. Discriminated by origin, naming the tab that owns its interior features. */
export type Bin = ManualBin | ScrewBin | TracedBin;

// ---------------------------------------------------------------------------
// Products: what a queue row orders
// ---------------------------------------------------------------------------

/**
 * A queue row that orders a bin body alone. labelSlot decides whether the
 * body gets the swappable-insert channel (an empty slot to print inserts for
 * later) or stays a plain bin with no label feature at all. The flag lives
 * only on this product kind: a bin ordered with its insert always has the
 * slot, so "insert but no slot" is not representable.
 */
export interface BinProduct {
  kind: 'bin';
  /** The bin body's design parameters. */
  bin: Bin;
  /** Whether the body carries the empty label insert slot. */
  labelSlot: boolean;
}

/**
 * A queue row that orders a bin body together with the label insert that
 * clips into its slot. The insert's width is never stored here: it is always
 * bin.gridX, so the insert stays the same width as the slot it clips into.
 * Use insertOf to derive the printed insert.
 */
export interface BinWithInsertProduct {
  kind: 'binWithInsert';
  /** The bin body's design parameters. */
  bin: Bin;
  /** The insert's printed content. Its width is bin.gridX. */
  insert: LabelContent;
}

/**
 * A standalone label insert entry, printed for a slotted bin that already
 * exists elsewhere in the plan or was already printed, sized by hand on the
 * Manual bin tab. There is no traced insert variant: a standalone insert has
 * no bin interior to hold pockets, so tracing has nothing to size it against.
 */
export interface ManualInsertProduct {
  kind: 'insert';
  origin: 'manual';
  /** Width of the insert in grid cells (42 mm pitch each). */
  cells: number;
  /** The text and icon printed on the insert. */
  content: LabelContent;
}

/**
 * A standalone label insert entry sized and labeled from a screw description,
 * for a slotted bin that already exists.
 */
export interface ScrewInsertProduct {
  kind: 'insert';
  origin: 'screw';
  /** Width of the insert in grid cells (42 mm pitch each). */
  cells: number;
  /** The text and icon printed on the insert. */
  content: LabelContent;
  /** The screw the insert was sized and labeled for. */
  screw: ScrewSpec;
}

/** A standalone label insert product of either origin. */
export type InsertProduct = ManualInsertProduct | ScrewInsertProduct;

/**
 * What one queue row orders: a bin with an empty slot, a bin with its
 * matching insert, or a standalone insert for a bin that already exists.
 * Two orthogonal axes are folded into this single discriminated union: the
 * product kind ('bin' vs 'binWithInsert' vs 'insert') and, independently,
 * the origin tab that designed the bin or sized the insert ('manual',
 * 'screw' or 'traced', carried on Bin.origin for the first two kinds and on
 * the insert product itself for the third).
 */
export type Product = BinProduct | BinWithInsertProduct | InsertProduct;

/**
 * Returns the insert a product prints, or null when the product has no
 * insert. The single place that derives a paired insert's width from
 * bin.gridX; no other code should recompute it.
 */
export function insertOf(product: Product): { cells: number; content: LabelContent } | null {
  switch (product.kind) {
    case 'bin':
      return null;
    case 'binWithInsert':
      return { cells: product.bin.gridX, content: product.insert };
    case 'insert':
      return { cells: product.cells, content: product.content };
    default:
      return assertNever(product);
  }
}

/** Returns the bin a product orders, or null for a standalone insert product. */
export function binOf(product: Product): Bin | null {
  switch (product.kind) {
    case 'bin':
    case 'binWithInsert':
      return product.bin;
    case 'insert':
      return null;
    default:
      return assertNever(product);
  }
}

/** The origin tab of a product: the tab that created it and owns its edit. */
export type ProductOrigin = 'manual' | 'screw' | 'traced';

/**
 * Returns the origin tab of any product, for routing an edit to the tab that
 * created it. A bin-bearing product's origin lives on its bin; a standalone
 * insert product carries its own origin directly.
 */
export function originOf(product: Product): ProductOrigin {
  switch (product.kind) {
    case 'bin':
    case 'binWithInsert':
      return product.bin.origin;
    case 'insert':
      return product.origin;
    default:
      return assertNever(product);
  }
}

// ---------------------------------------------------------------------------
// Queue entries
// ---------------------------------------------------------------------------

/**
 * One row in the print queue: how many copies of a product the plan calls
 * for. Every queue entry is pending by definition: printed amounts leave the
 * plan through a print batch confirmation and are not kept as history.
 */
export interface QueueEntry {
  /** Stable unique identifier (UUID). */
  id: string;
  /** How many copies of the product the plan calls for. Integer, at least 1. */
  quantity: number;
  /** ISO 8601 timestamp of when the entry was created. */
  createdAt: string;
  /** Free-form notes on the entry. */
  notes?: string;
  /** What the entry orders. */
  product: Product;
}

/**
 * Partial changes applicable to a queue entry. Per-product editing happens
 * by replacing product wholesale rather than patching into it: since Product
 * is a discriminated union, assigning a whole new product is the only way to
 * change its kind or origin without producing a value that mixes fields from
 * two different variants. The id and createdAt are never changed by an
 * update.
 */
export type QueueEntryUpdate = Partial<Pick<QueueEntry, 'quantity' | 'notes' | 'product'>>;

// ---------------------------------------------------------------------------
// Print batches
// ---------------------------------------------------------------------------

/**
 * One row of a print batch. The product is embedded directly (not referenced
 * by entry id): a batch describes what was sent to the printer, so it must
 * survive edits to or deletion of the queue entry it was created from.
 * Product is a plain data structure, so storing it here is already a
 * snapshot frozen at batch time; no separate snapshot type is needed. The
 * optional sourceEntryId is only a hint for returning failed amounts to the
 * same queue row when it still exists.
 */
export interface BatchItem {
  /** Stable unique identifier (UUID) within the plan. */
  id: string;
  /** The product this batch row prints, snapshotted at batch creation time. */
  product: Product;
  /** How many copies of the product the batch holds. Integer, at least 1. */
  count: number;
  /** Id of the queue entry the item was created from, if it still exists. */
  sourceEntryId?: string;
}

/** A named set of bins sent to a printer as one build plate. */
export interface PrintBatch {
  /** Stable unique identifier (UUID). */
  id: string;
  /** User-editable display name, for example the printer it was sent to. */
  name: string;
  /** The bins in the batch. A batch with no items left is removed. */
  items: BatchItem[];
  /** ISO 8601 timestamp of when the batch was created. */
  createdAt: string;
}

/** Versioned envelope the whole plan is persisted and exported as. */
export interface PlanFile {
  /** Envelope format version. Currently 4. */
  version: 4;
  /** All queue entries. */
  entries: QueueEntry[];
  /** All open print batches. */
  batches: PrintBatch[];
}

/** The current envelope format version. */
export const PLAN_FILE_VERSION = 4;
