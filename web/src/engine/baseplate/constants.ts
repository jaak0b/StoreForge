import {
  BASEPLATE_LOWER_CHAMFER,
  MAGNET_HOLE_DEPTH,
  MAGNET_HOLE_DIAMETER,
} from '../gridfinity/constants';

/*
 * Bounds, defaults and parameter shapes of the baseplate module. The plan
 * validator, the form controls and the generator all bind to these exports,
 * so the file format and the UI can never disagree about what is a legal
 * baseplate. The measured geometry constants land beside them with the
 * generator itself.
 */

/** Largest cell count per axis. A 20 by 20 plate is already 840 mm square. */
export const BASEPLATE_UNITS_MAX = 20;

/** Smallest legal shortened span of a last column or row, in mm. */
export const CUSTOM_SPAN_MIN = 1;

/** Magnet pocket diameter bounds, in mm. */
export const MAGNET_DIAMETER_MIN = 2;
export const MAGNET_DIAMETER_MAX = 8.2;

/**
 * The default plate magnet is by definition the bin's magnet: a re-export of
 * the bin constant, not a copied literal, so the two cannot drift apart.
 */
export const MAGNET_DIAMETER_DEFAULT = MAGNET_HOLE_DIAMETER;

/** Magnet pocket depth bounds, in mm. */
export const MAGNET_HEIGHT_MIN = 1;
export const MAGNET_HEIGHT_MAX = 4;

/** Re-export of the bin's magnet hole depth, for the same reason as the diameter. */
export const MAGNET_HEIGHT_DEFAULT = MAGNET_HOLE_DEPTH;

/** Connection clip tolerance bounds and default, in mm per mating face. */
export const CLIP_TOLERANCE_MIN = 0;
export const CLIP_TOLERANCE_MAX = 0.5;
export const CLIP_TOLERANCE_DEFAULT = 0;

/*
 * Measured baseplate constants. Every value below traces to a named reference
 * measurement (design document section 4.9) or is derived from one; none is a
 * tuned number.
 */

/** Solid floor kept under a magnet pocket, in mm. Measured 2x2-magnets-full.stl. */
export const BASEPLATE_MAGNET_FLOOR = 0.9;

/**
 * Default riser height under the socket when magnets or screws are on:
 * derived, MAGNET_HOLE_DEPTH + BASEPLATE_MAGNET_FLOOR = 3.3 (the reference
 * measured 3.0 with its shallower 2.1 pocket, not adopted). The base case of
 * baseplateRiserMm, used as-is when screws are on and magnets are off.
 */
export const BASEPLATE_RISER_HEIGHT = MAGNET_HOLE_DEPTH + BASEPLATE_MAGNET_FLOOR;

/**
 * Wall kept around a magnet pocket by its boss, in mm. Measured: the boss
 * fillet radius 4.5000 minus the reference magnet radius 3.1.
 */
export const BASEPLATE_BOSS_WALL = 1.4;

/** Screw hole diameter, in mm. Measured 2x2-screws-full.stl. */
export const BASEPLATE_SCREW_DIAMETER = 3.5;

/** Connector slot length along the plate edge, in mm. Measured 2x2-connectable.stl. */
export const CONNECTOR_SLOT_LENGTH = 20.0;

/**
 * Height of the slot floor above the plate bottom, in mm. Derived, equals
 * BASEPLATE_LOWER_CHAMFER; measured 0.7000 (the slot floor coincides with the
 * socket profile's lower-chamfer breakpoint on the plain plate).
 */
export const CONNECTOR_SLOT_FLOOR = BASEPLATE_LOWER_CHAMFER;

/** Retained outer skin below the rib ramp, in mm. Measured. */
export const CONNECTOR_RIB_ROOT_SKIN = 1.0;

/** Retained outer skin above the rib ramp, in mm. Measured. */
export const CONNECTOR_RIB_HEAD_SKIN = 1.3;

/** Bottom of the rib ramp above the plate bottom, in mm. Measured. */
export const CONNECTOR_RIB_RAMP_BOTTOM = 1.1;

/** Top of the rib ramp above the plate bottom, in mm. Measured. */
export const CONNECTOR_RIB_RAMP_TOP = 1.5;

/** Top of the retained rib; the wall is removed through its full thickness above. Measured. */
export const CONNECTOR_RIB_TOP = 2.0;

/** Slope of the rib and groove ramps, run over rise. Measured on both mating parts independently. */
export const CONNECTOR_RAMP_SLOPE = 0.75;

/** Connection clip length, in mm. Measured connector.stl. */
export const CONNECTOR_LENGTH = 19.6;

/** Half width of the clip's groove mouth, in mm. Measured. */
export const CONNECTOR_GROOVE_MOUTH_HALF = 1.05;

/** Half width of the clip's groove interior, in mm. Measured. */
export const CONNECTOR_GROOVE_HALF = 1.45;

/** Height of the parallel groove mouth above the clip's bottom face, in mm. Measured. */
export const CONNECTOR_GROOVE_MOUTH_HEIGHT = 0.25;

/** Depth of the clip's groove from its bottom face, in mm. Measured. */
export const CONNECTOR_GROOVE_DEPTH = 1.35;

/** Height of the clip's vertical body flank, in mm. Measured. */
export const CONNECTOR_FLANK_HEIGHT = 1.65;

/** Radius of the fillet rounding the clip's crest, in mm. Measured (tangent 0.2121 = 0.3 / sqrt(2)). */
export const CONNECTOR_CREST_RADIUS = 0.3;

/** Magnet pocket dimensions. Declared once, beside its bounds; the plan layer imports it. */
export interface BaseplateMagnets {
  /** Magnet pocket diameter in mm, MAGNET_DIAMETER_MIN to MAGNET_DIAMETER_MAX. */
  diameterMm: number;
  /** Magnet pocket depth in mm, MAGNET_HEIGHT_MIN to MAGNET_HEIGHT_MAX. */
  heightMm: number;
}

export interface BaseplateParams {
  /** Cells along X, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsX: number;
  /** Cells along Y, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsY: number;
  /** Length of the last column along X in mm, or null when it keeps the full pitch. */
  customXMm: number | null;
  /** Depth of the last row along Y in mm, or null when it keeps the full pitch. */
  customYMm: number | null;
  /**
   * Grid pitch in mm: centre-to-centre cell spacing and the plate's footprint per cell.
   * Defaults to PITCH, valid 41.5 to 60. Not exposed in the UI; threaded so a control can be
   * added without touching geometry.
   */
  pitchMm?: number;
  /** Magnet pockets in every cell corner, opening into the socket floor, or null for none. */
  magnets: BaseplateMagnets | null;
  /** Through screw holes concentric with the magnet positions. */
  screwHoles: boolean;
  /** Connector slots on all four outer edges, one per cell per edge. */
  connectable: boolean;
}

export interface ConnectionClipParams {
  /**
   * Extra clearance in mm applied per mating face, added to the nominal fit measured from
   * the reference connector. 0 reproduces the nominal fit; valid CLIP_TOLERANCE_MIN to
   * CLIP_TOLERANCE_MAX. Positive values shrink the clip; the plate's slot is never altered.
   */
  toleranceMm: number;
}
