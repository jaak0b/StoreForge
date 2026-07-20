import type { PaperCorners, PaperKind, TracedTool, ToolPlacement } from '../trace/types';
import type { DividerWall } from '../gridfinity/dividerModel';
import type { ModelPlacement, SizeMm } from '../cutout/cutoutBin';
import type { HeadType } from './screwListImport';
import type { BaseplateMagnets } from '../baseplate/constants';

export type { DividerWall, ModelPlacement, SizeMm };

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

/** A bin designed by hand on the Manual bin tab, with free divider walls. */
export interface ManualBin extends BinEnvelope {
  origin: 'manual';
  /** Free interior divider wall segments in bin-local mm. Empty for none. */
  walls: DividerWall[];
}

/** A bin created from a screw description on the Screw entry tab, with free divider walls. */
export interface ScrewBin extends BinEnvelope {
  origin: 'screw';
  /** Free interior divider wall segments in bin-local mm. Empty for none. */
  walls: DividerWall[];
  /** The screw the bin was sized for. */
  screw: ScrewSpec;
}

/**
 * A bin with tool pockets from the Tool trace tab. The pocket generator
 * rejects divider walls, so a traced bin deliberately carries no divider
 * fields at all: walls is only legal on ManualBin and ScrewBin.
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

/**
 * One imported model carved out of a cutout bin's interior. The model's
 * triangles are not stored here: they live in this device's model store under
 * modelSourceId, because a single 10000-triangle STL is about 665 KB as base64
 * and the whole localStorage plan has 5 MB to work with.
 */
export interface CutoutModel {
  /** Stable unique identifier within the bin. */
  id: string;
  /** The uploaded file's name, shown in the model list. */
  name: string;
  /**
   * Key of the model's STL bytes in this device's model store. An opaque key,
   * never a path: a plan imported from another device has the id but not the
   * bytes, and the bin is then listed but cannot be generated until the model
   * is uploaded again.
   */
  modelSourceId: string;
  /** Triangle count as imported, for the diagnostic readout. */
  triangleCount: number;
  /**
   * Multiplier taking the file's own coordinates to millimetres. STL carries
   * no unit declaration at all, so this is the user's answer to a question the
   * file cannot answer: 1 for a file already in mm, 25.4 for one authored in
   * inches, 1000 for one in metres. Stored so the choice round-trips in the
   * plan rather than having to be made again on every load.
   */
  unitScale: number;
  /**
   * Size of the model's own bounding box in mm after unitScale is applied,
   * before any rotation.
   */
  sizeMm: SizeMm;
  /** Where the model sits in the bin. */
  placement: ModelPlacement;
  /**
   * How far this model's pocket is dilated beyond the model surface, in mm, as
   * a true 3D offset. Per model, not per bin: a socket set and a wrench in one
   * tray do not want the same fit.
   *
   * Deliberately a sibling of placement rather than a field inside it. A
   * placement change is cheap (a lazy transform of a cached solid); a clearance
   * change is expensive (it invalidates that cache and re-runs the Minkowski
   * sum). Keeping them apart lets the difference between two model records
   * answer whether a change was cheap or expensive with no extra bookkeeping.
   */
  clearanceMm: number;
  /**
   * Whether this model's pocket is swept straight up and out of the bin instead
   * of carved to the exact dilated shape, so a model with an undercut can still
   * drop in. Applied after placement rotation, so it is not part of the cached
   * import and does not key the prepared solid.
   */
  sweepEnabled: boolean;
  /**
   * How far the swept pocket walls lean outward toward the top, in degrees. 0 is
   * a straight vertical sweep; larger angles flare the walls for easier insertion
   * and removal. Ignored when sweepEnabled is false.
   */
  draftAngleDeg: number;
}

/**
 * A bin whose interior is carved by imported models, as designed on the Cutout
 * bin tab. Like a traced bin it carries no divider walls: the interior is
 * filled solid for the carve, so walls have nothing to divide.
 */
export interface CutoutBin extends BinEnvelope {
  origin: 'cutout';
  /** The models carved out of the interior. Empty means an uncarved solid interior. */
  models: CutoutModel[];
}

/** A bin body of any origin. Discriminated by origin, naming the tab that owns its interior features. */
export type Bin = ManualBin | ScrewBin | TracedBin | CutoutBin;

// ---------------------------------------------------------------------------
// Products: what a queue row orders
// ---------------------------------------------------------------------------

/**
 * A queue row that orders a bin body alone. labelSlot decides whether the
 * body gets the swappable-insert channel (an empty slot to print inserts for
 * later) or stays a plain bin with no label feature at all. The flag lives
 * only on this product kind: a bin ordered with its insert always has the
 * slot, so "insert but no slot" is not representable.
 *
 * A screw-origin bin is deliberately excluded: a screw bin exists to carry
 * the label naming its fastener, so it is always ordered with its insert.
 * Plans that still hold one are repaired on load (see planFile).
 */
export interface BinProduct {
  kind: 'bin';
  /** The bin body's design parameters. */
  bin: ManualBin | TracedBin | CutoutBin;
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
  /**
   * When true, the bin and its label print as one fused piece: no insert slot
   * is cut into the bin and no separate insert part is printed; instead the
   * label content is raised directly on the bin's top face at the position the
   * insert label would occupy. Absent or false keeps the swappable-insert
   * packaging. Applies to bins of every origin (manual, screw, traced, cutout), since
   * they all order the label through this product kind.
   */
  fused?: boolean;
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
 * A queue row that orders a Gridfinity baseplate, the tray a bin's feet drop
 * into. Sized in whole grid units, except that the last column and the last
 * row may be shortened so the plate fits a drawer that is not a whole number
 * of cells deep. Only those two may shrink: every interior cell keeps the
 * full pitch, because a bin has to seat in each of them.
 */
export interface BaseplateProduct {
  kind: 'baseplate';
  /** Cells along X, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsX: number;
  /** Cells along Y, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsY: number;
  /**
   * Length of the last column along X in mm, or null when it keeps the full pitch.
   * Above 0 and at most the pitch. Total width is (unitsX - 1) * pitch + (customXMm ?? pitch).
   */
  customXMm: number | null;
  /** Depth of the last row along Y, same range and meaning. */
  customYMm: number | null;
  /**
   * Magnet pocket dimensions, imported from the baseplate module so they
   * travel with their bounds, or null when the plate has none: a plate
   * without magnets carries no dimensions at all rather than dead ones.
   */
  magnets: BaseplateMagnets | null;
  screwHoles: boolean;
  connectable: boolean;
}

/**
 * A queue row that orders the printed clip joining two connectable baseplates
 * edge to edge. The clip's geometry does not depend on any baseplate option:
 * its own tolerance parameter is the whole of its configurability.
 */
export interface ConnectionClipProduct {
  kind: 'clip';
  /**
   * Extra clearance in mm applied per mating face to the clip only, never to
   * the plate's slot. Valid CLIP_TOLERANCE_MIN to CLIP_TOLERANCE_MAX;
   * CLIP_TOLERANCE_DEFAULT (0) is the nominal fit. Raise it when the clip
   * prints too tight to push into the joint.
   */
  toleranceMm: number;
}

/**
 * What one queue row orders: a bin with an empty slot, a bin with its
 * matching insert, or a standalone insert for a bin that already exists.
 * Two orthogonal axes are folded into this single discriminated union: the
 * product kind ('bin' vs 'binWithInsert' vs 'insert') and, independently,
 * the origin tab that designed the bin or sized the insert ('manual',
 * 'screw', 'traced' or 'cutout', carried on Bin.origin for the first two kinds and on
 * the insert product itself for the third). A baseplate and a connection clip
 * carry no bin at all; their kind alone implies their origin tab.
 */
export type Product =
  | BinProduct
  | BinWithInsertProduct
  | InsertProduct
  | BaseplateProduct
  | ConnectionClipProduct;

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
    case 'baseplate':
    case 'clip':
      return null;
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
    case 'baseplate':
    case 'clip':
      return null;
    default:
      return assertNever(product);
  }
}

/**
 * The origin tab of a product: the tab that created it and owns its edit. A
 * baseplate and a connection clip are both edited on the Baseplate tab, which
 * the tab mapping collapses.
 */
export type ProductOrigin = 'manual' | 'screw' | 'traced' | 'cutout' | 'baseplate' | 'clip';

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
    case 'baseplate':
      return 'baseplate';
    case 'clip':
      return 'clip';
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
  /**
   * Envelope format version. Currently 8, which is version 7 plus the
   * baseplate and connection clip product kinds. The change is purely
   * additive: no field of an earlier version changes meaning, so versions 1
   * to 7 are read exactly as they were before; they simply contain no
   * baseplate or clip rows.
   */
  version: 8;
  /** All queue entries. */
  entries: QueueEntry[];
  /** All open print batches. */
  batches: PrintBatch[];
}

/** The current envelope format version. */
export const PLAN_FILE_VERSION = 8;
