import { MAGNET_HOLE_DEPTH, MAGNET_HOLE_DIAMETER } from '../gridfinity/constants';

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
