import type { LabeledBinParams } from '../gridfinity/types';

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
  /** Whether the floor is cut away in a grid of perforation holes. */
  perforatedBase: boolean;
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

/** A named, reusable set of bin design parameters. */
export interface BinTemplate {
  /** Stable unique identifier (UUID). */
  id: string;
  /** User-chosen display name of the template. */
  name: string;
  /** The saved bin design parameters. */
  params: LabeledBinParams;
  /** ISO 8601 timestamp of when the template was saved. */
  createdAt: string;
}

/** Versioned envelope the templates are persisted as. */
export interface TemplateFile {
  /** Envelope format version. Currently always 1. */
  version: 1;
  /** All saved templates. */
  templates: BinTemplate[];
}

/** The current template envelope format version. */
export const TEMPLATE_FILE_VERSION = 1;
