/** Parameters describing a Gridfinity bin. */
export interface BinParams {
  /** Number of grid cells along X (42 mm pitch each). Integer, at least 1. */
  gridX: number;
  /** Number of grid cells along Y (42 mm pitch each). Integer, at least 1. */
  gridY: number;
  /** Bin height in Gridfinity height units (7 mm each). Integer, at least 2. */
  heightUnits: number;
  /** Whether to subtract magnet holes from the underside of each foot. */
  magnetHoles: boolean;
  /** Number of divider walls perpendicular to the X axis. Integer, at least 0. */
  dividerCountX: number;
  /** Number of divider walls perpendicular to the Y axis. Integer, at least 0. */
  dividerCountY: number;
  /**
   * Whether the interior gets the scoop: the measured circular fillet
   * sweeping the floor up into the back wall (opposite the label slot).
   * Standard bins always have it (omitted means true, matching the Pred
   * reference bin); pocket bins pass false because their interior is filled
   * solid for tool pockets and a scoop belongs to loose-part bins.
   */
  scoop?: boolean;
}

/**
 * The printed content of a label insert, in the geometry layer's own shape so
 * the engine does not depend on the plan layer. Structurally compatible with
 * the plan layer's LabelContent, plus the transient resolved icon path.
 */
export interface InsertContentParams {
  /** Main label text. An empty string means no text. */
  text: string;
  /** Optional smaller second text line under the first. Empty means none. */
  text2: string;
  /** Name of the label icon shown left of the text, or null for no icon. */
  icon: string | null;
  /**
   * Resolved SVG path data for a custom icon. Custom icons live in the
   * browser's localStorage, which the geometry worker cannot reach, so the UI
   * resolves the path before the worker call and passes it here. Transient:
   * never persisted, and absent when icon names a built-in icon.
   */
  iconPath?: string;
}

/**
 * Parameters describing a bin to generate. labelSlot decides whether the
 * body gets the swappable label insert channel or stays a plain bin; insert
 * carries the paired insert's content for the preview (shown resting in the
 * slot), or null for a bin previewed without one. A paired insert implies
 * the slot. Exports always generate the insert as its own separately placed
 * part.
 */
export interface SlottedBinParams extends BinParams {
  /** Whether the body carries the label insert slot. */
  labelSlot: boolean;
  /** Content of the paired label insert, or null for a bin alone. */
  insert: InsertContentParams | null;
}

/** Parameters describing a standalone label insert to generate. */
export interface InsertParams {
  /** Width of the insert in grid cells (42 mm pitch each). Integer, at least 1. */
  cells: number;
  /** The text and icon printed on the insert. */
  content: InsertContentParams;
}

/** Triangle mesh in flat typed arrays, ready to transfer between threads. */
export interface MeshData {
  /** Vertex positions, three floats (x, y, z) per vertex. */
  vertices: Float32Array;
  /** Triangle vertex indices, three per triangle. */
  indices: Uint32Array;
}

/** The two preview meshes of a generated part, kept separate for coloring. */
export interface PartMeshes {
  /** The main body: the bin, or the insert plate. */
  body: MeshData;
  /**
   * The second-filament mesh: the insert (plate and inlay) resting in the
   * bin's slot for a bin previewed with its insert, or the label inlay of a
   * standalone insert. Null when there is nothing to show in a second color.
   */
  label: MeshData | null;
}
