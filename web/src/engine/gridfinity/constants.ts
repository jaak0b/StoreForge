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
 * Wall thickness of the hollowed foot's outer shell, plus the magnet boss
 * walls and the divider root strips. Measured from the Pred reference bin
 * (gridfinitybin_1x1x6_d1_l12_s10, printables.com/model/592545): its foot
 * outer wall is 3.05 to 3.14 mm at the first layer (a plan slice at the bed +
 * 0.1 mm shows the ring 3.14 mm across at a cell mid-edge), thickening as the
 * foot chamfer flares. Our previous value was a thinner 1.42 mm printability
 * choice, which left the first layer as sparse lines with poor bed adhesion;
 * the reference's thicker shell gives the first layer roughly 75 percent more
 * contact area. The bin walls above the base keep WALL_THICKNESS.
 */
export const BASE_WALL_THICKNESS = 3.05;

/**
 * Thickness of the internal lattice ribs standing inside the hollowed foot:
 * the per-cell central "+" cross and the two diagonal ribs. Measured from the
 * same Pred reference bin (first-layer plan slice): the central cross arm is
 * 0.78 mm, the diagonal ribs are 0.70 mm, both about 0.8 mm (roughly two
 * 0.4 mm extrusion lines). The reference fills the foot with a diamond-void
 * lattice of these thin ribs; we reproduce the outer shell, the central cross
 * and the two cell diagonals at the measured rib width, which reproduces the
 * measured first-layer solid area (about 499 mm squared per cell) within a
 * couple of percent. See binGenerator's buildBasePocket for what the lattice
 * simplifies relative to the reference's full diamond pattern.
 */
export const BASE_RIB_THICKNESS = 0.8;

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

/**
 * Stacking lip inner seat profile, bottom to top, from the nominal bin top
 * upward. Ported from kennetek/gridfinity-rebuilt-openscad
 * (src/core/standard.scad, STACKING_LIP_LINE, per the published Gridfinity
 * spec): a 45 degree outward taper (rise equals run), a vertical band, and a
 * second 45 degree outward taper reaching the outer face. The seat is the
 * negative of the stacking foot (0.8 / 1.8 / 2.15), leaving 0.1 to 0.35 mm
 * of nesting clearance per side.
 */
export const LIP_LOWER_TAPER = 0.7;
export const LIP_SEAT_VERTICAL = 1.8;
export const LIP_UPPER_TAPER = 1.9;

/** Stacking lip total height above the nominal bin top (kennetek STACKING_LIP_HEIGHT). */
export const LIP_HEIGHT = LIP_LOWER_TAPER + LIP_SEAT_VERTICAL + LIP_UPPER_TAPER;

/**
 * How far the lip tip protrudes into the bin from the outer face, wall
 * thickness included (kennetek STACKING_LIP_SIZE.x = 2.6).
 */
export const LIP_DEPTH = LIP_LOWER_TAPER + LIP_UPPER_TAPER;

/**
 * Height of the vertical band directly under the lip tip, below the nominal
 * bin top, before the 45 degree support taper widens the interior back to
 * the wall face (kennetek STACKING_LIP_SUPPORT_HEIGHT = 1.2, with its
 * 45 degree support underneath).
 */
export const LIP_SUPPORT_HEIGHT = 1.2;

/**
 * Fillet radius rounding off the lip crest, where the seat's upper taper
 * would otherwise meet the outer face in a knife edge (kennetek
 * STACKING_LIP_FILLET_RADIUS = 0.6; the measured crest of the Pred reference
 * bin, printables.com/model/592545, matches: apex 3.551 mm above the nominal
 * top with the outer face vertical up to 2.951).
 */
export const LIP_FILLET_RADIUS = 0.6;

/**
 * Height of the filleted crest apex above the nominal bin top: the fillet is
 * tangent to the vertical outer face and the 45 degree upper taper, placing
 * the apex LIP_FILLET_RADIUS * sqrt(2) below the theoretical knife edge.
 */
export const LIP_CREST_HEIGHT = LIP_HEIGHT - LIP_FILLET_RADIUS * Math.SQRT2;

/**
 * Recessed band around the outer face at the rim, measured from the Pred
 * reference bin (gridfinitybin_1x1x6_d1_l12_s1, vertical cross-section at
 * mid-depth): the outer face steps inward 0.7 mm over a 45 degree chamfer,
 * runs vertical for 1.0 mm ending at the nominal bin top, and returns to the
 * outer face over a 45 degree chamfer ending 0.7 mm above the nominal top
 * (measured z 35.55 / 36.25 / 37.25 / 37.95 against the 37.25 nominal top).
 * The band runs continuously around the whole perimeter, through the label
 * slot corners.
 */
export const LIP_GROOVE_INSET = 0.7;
export const LIP_GROOVE_VERTICAL = 1.0;

/**
 * Radius of the scoop: the circular fillet sweeping the interior floor up
 * into the wall opposite the label slot, so small parts can be swept out
 * with a finger. Measured from the Pred reference bin
 * (gridfinitybin_1x1x6_d1_l12_s10, printables.com/model/592545): a vertical
 * cross-section at mid-width shows a circular arc of radius 10.000 mm
 * tangent to the interior floor (z 1.200) at 10 mm from the wall and tangent
 * to the interior wall face (y 1.750) at 10 mm above the floor, running the
 * full interior width wall to wall (straight across at every height, bounded
 * by the wall faces at its ends: plan slices through the scoop band keep the
 * bin's outer corner arcs unchanged). On low bins the radius is clamped to the vertical
 * interior wall height so the fillet stays tangent to a real wall face.
 */
export const SCOOP_RADIUS = 10.0;

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

/**
 * Clear opening in mm at the very top of the bin along one axis: the
 * narrowest width an object dropped in through the top must pass. With a
 * stacking lip the lip tip overhangs the interior, LIP_DEPTH in from the
 * outer face per side; without one the opening is the interior itself. The
 * single home for this figure.
 */
export function binTopOpeningMm(cells: number, stackingLip: boolean = true): number {
  if (!stackingLip) return binInteriorSizeMm(cells);
  return binOuterSizeMm(cells) - 2 * LIP_DEPTH;
}
