import type { LabeledBinParams } from '../gridfinity/types';
import type { TracedTool, ToolPlacement } from '../trace/types';

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
 * One bin in the print queue, with its design parameters. Every queue entry
 * is pending by definition: printed amounts leave the plan through a print
 * batch confirmation and are not kept as history.
 */
export interface BinEntry {
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
  /** Number of divider walls perpendicular to the X axis. Integer, at least 0. */
  dividerCountX: number;
  /** Number of divider walls perpendicular to the Y axis. Integer, at least 0. */
  dividerCountY: number;
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
  /** Tool pockets sunk into the bin, when the entry came from a tool trace. */
  pockets?: BinPockets;
}

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
  /** Snapshot of the entry's tool pockets, when it had any. */
  pockets?: BinPockets;
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
