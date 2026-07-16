/** Parameters describing a Gridfinity bin. */
export interface BinParams {
  /** Number of grid cells along X (42 mm pitch each). Integer, at least 1. */
  gridX: number;
  /** Number of grid cells along Y (42 mm pitch each). Integer, at least 1. */
  gridY: number;
  /** Bin height in Gridfinity height units (7 mm each). Integer, at least 2. */
  heightUnits: number;
  /** Whether to add the stacking lip on top of the walls. */
  stackingLip: boolean;
  /** Whether to subtract magnet holes from the underside of each foot. */
  magnetHoles: boolean;
  /** Number of divider walls perpendicular to the X axis. Integer, at least 0. */
  dividerCountX: number;
  /** Number of divider walls perpendicular to the Y axis. Integer, at least 0. */
  dividerCountY: number;
}

/** Parameters describing a Gridfinity bin with an optional embossed label. */
export interface LabeledBinParams extends BinParams {
  /** Text embossed on the front wall. An empty string means no text. */
  labelText: string;
  /** Optional smaller second text line under the first. Empty means none. */
  labelText2: string;
  /** Name of the label icon shown left of the text, or null for no icon. */
  labelIcon: string | null;
  /**
   * Resolved SVG path data for a custom labelIcon. Custom icons live in the
   * browser's localStorage, which the geometry worker cannot reach, so the UI
   * resolves the path before the worker call and passes it here. Transient:
   * never persisted, and absent when labelIcon names a built-in icon.
   */
  labelIconPath?: string;
}

/** Triangle mesh in flat typed arrays, ready to transfer between threads. */
export interface MeshData {
  /** Vertex positions, three floats (x, y, z) per vertex. */
  vertices: Float32Array;
  /** Triangle vertex indices, three per triangle. */
  indices: Uint32Array;
}

/** The two parts of a labeled bin, kept separate for per-part coloring. */
export interface LabeledBinMeshes {
  /** The bin body. */
  body: MeshData;
  /** The embossed label, welded into the front wall, or null when unlabeled. */
  label: MeshData | null;
}
