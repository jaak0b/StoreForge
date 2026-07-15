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

/** Bin wall thickness. (kennetek uses d_wall = 0.95; stage 1 uses 1.2 per spec.) */
export const WALL_THICKNESS = 1.2;

/**
 * Height of the top of the interior floor above the bed. The floor spans from
 * the top of the feet (4.75 mm) up to one full base height (7 mm), matching
 * kennetek's BASE_HEIGHT.
 */
export const FLOOR_TOP = 7.0;

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
