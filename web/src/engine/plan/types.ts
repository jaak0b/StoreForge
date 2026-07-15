/** Lifecycle status of a bin entry in the print plan. */
export type BinStatus = 'queued' | 'printed';

/** One bin in the print plan, with its design parameters and lifecycle state. */
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
  /** Name of the label icon shown left of the text, or null for no icon. */
  labelIcon: string | null;
  /** How many copies of this bin the plan calls for. Integer, at least 1. */
  quantity: number;
  /** Whether the bin still needs printing or has been printed. */
  status: BinStatus;
  /** ISO 8601 timestamp of when the entry was created. */
  createdAt: string;
  /** ISO 8601 timestamp of when the entry was marked printed, if it was. */
  printedAt?: string;
  /** Free-form notes on the entry. */
  notes?: string;
}

/** Versioned envelope the whole plan is persisted and exported as. */
export interface PlanFile {
  /** Envelope format version. Currently always 1. */
  version: 1;
  /** All bin entries in the plan. */
  entries: BinEntry[];
}

/** The current envelope format version. */
export const PLAN_FILE_VERSION = 1;
