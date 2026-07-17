import type { LabeledBinParams } from '../gridfinity/types';
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
 * Fields shared by every kind of queue entry. Every queue entry is pending by
 * definition: printed amounts leave the plan through a print batch
 * confirmation and are not kept as history.
 */
export interface BinEntryBase {
  /** Stable unique identifier (UUID). */
  id: string;
  /** Number of grid cells along X (42 mm pitch each). Integer, at least 1. */
  gridX: number;
  /** Number of grid cells along Y (42 mm pitch each). Integer, at least 1. */
  gridY: number;
  /** Bin height in Gridfinity height units (7 mm each). Integer, at least 2. */
  heightUnits: number;
  /** Whether the bin has the stacking lip on top of the walls. */
  stackingLip: boolean;
  /** Whether the bin has magnet holes under each foot. */
  magnetHoles: boolean;
  /** Text embossed on the label shelf. An empty string means no text. */
  labelText: string;
  /** Optional smaller second text line under the first. Empty means none. */
  labelText2: string;
  /** Name of the label icon shown left of the text, or null for no icon. */
  labelIcon: string | null;
  /** How many copies of this bin the plan calls for. Integer, at least 1. */
  quantity: number;
  /** ISO 8601 timestamp of when the entry was created. */
  createdAt: string;
  /** Free-form notes on the entry. */
  notes?: string;
}

/** A bin designed by hand on the Manual bin tab. */
export interface ManualBin extends BinEntryBase {
  kind: 'manual';
  /** Number of divider walls perpendicular to the X axis. Integer, at least 0. */
  dividerCountX: number;
  /** Number of divider walls perpendicular to the Y axis. Integer, at least 0. */
  dividerCountY: number;
}

/** A bin created from a screw description on the Screw entry tab. */
export interface ScrewBin extends BinEntryBase {
  kind: 'screw';
  /** Number of divider walls perpendicular to the X axis. Integer, at least 0. */
  dividerCountX: number;
  /** Number of divider walls perpendicular to the Y axis. Integer, at least 0. */
  dividerCountY: number;
  /** The screw the bin was sized and labeled for. */
  screw: ScrewSpec;
}

/**
 * A bin with tool pockets from the Tool trace tab. The pocket generator
 * rejects divider walls, so a traced bin carries no divider fields at all.
 */
export interface TracedBin extends BinEntryBase {
  kind: 'traced';
  /** The tool pockets sunk into the bin. */
  pockets: BinPockets;
  /**
   * Key of the original trace photo in this device's photo store. Absent for
   * plans imported from elsewhere or entries saved before photo storage; the
   * entry is then layout-only editable.
   */
  traceSourceId?: string;
  /** The reference-sheet setup the photo was rectified with, when known. */
  paper?: TracePaper;
}

/** One bin in the print queue, with its design parameters, by origin tab. */
export type BinEntry = ManualBin | ScrewBin | TracedBin;

/** The discriminant of BinEntry, naming the tab that owns the entry. */
export type BinKind = BinEntry['kind'];

/**
 * Exhaustiveness helper: a switch over BinEntry kinds calls this in its
 * default branch, so adding a new kind fails to compile in every consumer.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled bin kind: ${String(value)}`);
}

/**
 * Partial changes applicable to a queue entry. The kind itself is never
 * changed; each tab only writes the kind-specific fields it owns, so the
 * merged entry stays consistent with its kind.
 */
export type BinEntryUpdate = Partial<Omit<BinEntryBase, 'id' | 'createdAt'>> & {
  dividerCountX?: number;
  dividerCountY?: number;
  screw?: ScrewSpec;
  pockets?: BinPockets;
  traceSourceId?: string;
  paper?: TracePaper;
};

/**
 * One row of a print batch. The bin design parameters are embedded as a
 * snapshot (not referenced by entry id): a batch describes what was sent to
 * the printer, so it must survive edits to or deletion of the queue entry it
 * was created from. The optional sourceEntryId is only a hint for returning
 * failed amounts to the same queue row when it still exists.
 */
export interface BatchItem {
  /** Stable unique identifier (UUID) within the plan. */
  id: string;
  /** Snapshot of the bin design parameters at batch creation time. */
  params: LabeledBinParams;
  /** How many copies of this bin the batch holds. Integer, at least 1. */
  count: number;
  /** Id of the queue entry the item was created from, if it still exists. */
  sourceEntryId?: string;
  /** Snapshot of the entry's tool pockets, when it was a traced bin. */
  pockets?: BinPockets;
  /** Snapshot of the traced entry's photo-store key, so a failed print stays fully editable. */
  traceSourceId?: string;
  /** Snapshot of the traced entry's reference-sheet setup. */
  paper?: TracePaper;
  /** Snapshot of the entry's screw description, when it was a screw bin. */
  screw?: ScrewSpec;
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
  /** Envelope format version. Currently 2. */
  version: 2;
  /** All bin entries in the queue. */
  entries: BinEntry[];
  /** All open print batches. */
  batches: PrintBatch[];
}

/** The current envelope format version. */
export const PLAN_FILE_VERSION = 2;
