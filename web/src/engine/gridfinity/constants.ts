/**
 * Gridfinity standard dimensions, ported from the MIT-licensed
 * kennetek/gridfinity-rebuilt-openscad (src/core/standard.scad).
 * All values in millimetres.
 */

/** Grid pitch: centre-to-centre spacing of grid cells. */
export const PITCH = 42.0;

/** Side length of the base footprint at the top of the stacking foot (0.25 mm clearance per side). */
export const BASE_TOP_SIZE = 41.5;

/** Height of one Gridfinity height unit. */
export const HEIGHT_UNIT = 7.0;

/** Corner radius of the bin body outer wall. */
export const OUTER_CORNER_RADIUS = 4.0;

/** Corner radius of the base footprint at the top of the stacking foot. */
export const BASE_TOP_RADIUS = 3.75;

/** Stacking foot profile, bottom to top (each chamfer is 45 degrees, rise equals run). */
export const FOOT_LOWER_CHAMFER = 0.8;
export const FOOT_VERTICAL = 1.8;
export const FOOT_UPPER_CHAMFER = 2.15;

/** Total height of the stacking foot profile. */
export const FOOT_HEIGHT =
  FOOT_LOWER_CHAMFER + FOOT_VERTICAL + FOOT_UPPER_CHAMFER;

/** Bin wall thickness (d_wall = 0.95 in kennetek's src/core/standard.scad). */
export const WALL_THICKNESS = 0.95;

/**
 * Wall thickness of everything inside the hollowed base region: the foot
 * shells, the magnet boss walls, the divider root strips, and the per-cell
 * cross walls. Our own printability choice, not a spec value: three 0.45 mm
 * extrusion lines are 1.35 mm, plus a small allowance so slicers with a
 * little line overlap still place three full perimeters; 1.5 x WALL_THICKNESS
 * gives 1.425 mm, rounded to 1.42. The bin walls above the base keep
 * WALL_THICKNESS.
 */
export const BASE_WALL_THICKNESS = 1.42;

/**
 * Height of the top of the interior floor above the bed. The floor spans from
 * the top of the feet (4.75 mm) up to one full base height (7 mm), matching
 * kennetek's BASE_HEIGHT.
 */
export const FLOOR_TOP = 7.0;

/**
 * Thickness of the solid floor plate kept above the hollowed base pocket
 * (h_bot = 2.2, the bin bottom thickness in kennetek's src/core/standard.scad).
 * The plate's top face sits at FLOOR_TOP; everything below it, down through
 * the inside of each stacking foot, is pocketed like kennetek's lite base.
 */
export const FLOOR_PLATE_THICKNESS = 2.2;

/** Stacking lip total height above the nominal bin top. */
export const LIP_HEIGHT = 4.4;

/** Height of the straight (vertical) part of the simplified stacking lip. */
export const LIP_VERTICAL = 3.9;

/** Wall thickness at the very top of the simplified stacking lip rim. */
export const LIP_TOP_THICKNESS = 0.7;

/** Magnet hole dimensions (MAGNET_HOLE_RADIUS = 3.25, depth 2.4). */
export const MAGNET_HOLE_DIAMETER = 6.5;
export const MAGNET_HOLE_DEPTH = 2.4;

/** Magnet hole centre distance from the edge of a grid cell (d_hole_from_side = 8). */
export const MAGNET_HOLE_FROM_CELL_EDGE = 8.0;

/** Number of segments used to approximate each quarter-circle corner arc. */
export const CORNER_SEGMENTS = 12;

/**
 * Thickness of an interior divider wall. Matches the 1.2 mm divider width
 * used by kennetek/gridfinity-rebuilt-openscad (d_div in src/core/standard.scad).
 */
export const DIVIDER_THICKNESS = 1.2;

/**
 * Outer footprint size in mm of a bin spanning `cells` grid cells along one
 * axis: the grid pitch per cell minus the shared footprint clearance
 * (PITCH - BASE_TOP_SIZE, a quarter millimetre per side). The single home for
 * this figure; every module needing the bin's outer width or depth derives it
 * from here.
 */
export function binOuterSizeMm(cells: number): number {
  return cells * PITCH - (PITCH - BASE_TOP_SIZE);
}

/**
 * Clear interior size in mm between the bin walls along one axis. The single
 * home for this figure.
 */
export function binInteriorSizeMm(cells: number): number {
  return binOuterSizeMm(cells) - 2 * WALL_THICKNESS;
}
