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

/**
 * Fewest height units a bin can be printed at. One height unit is entirely
 * taken up by the base (FLOOR_TOP is exactly HEIGHT_UNIT), so a one-unit bin
 * has no interior at all and nothing to carve, divide or drop a part into.
 * The plan file validator enforces the same floor when it reads a stored bin.
 */
export const MIN_HEIGHT_UNITS = 2;

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
 * Wall thickness of the hollowed foot's outer shell, and of the magnet boss
 * walls. Measured from the Pred reference bin (gridfinitybin_1x1x6_d1_l12_s10,
 * printables.com/model/592545): its foot
 * outer wall is 3.05 to 3.14 mm at the first layer (a plan slice at the bed +
 * 0.1 mm shows the ring 3.14 mm across at a cell mid-edge), thickening as the
 * foot chamfer flares. Our previous value was a thinner 1.42 mm printability
 * choice, which left the first layer as sparse lines with poor bed adhesion;
 * the reference's thicker shell gives the first layer roughly 75 percent more
 * contact area. The bin walls above the base keep WALL_THICKNESS.
 */
export const BASE_WALL_THICKNESS = 3.05;

/**
 * Extra thickness added to the inner foot wall of bins without magnet holes:
 * the owner's bed-adhesion choice of two 0.4 mm extrusion lines. Bins with
 * magnet holes keep solid magnet bosses in every foot corner, which already
 * give their first layer enough contact area to print fine without it; bins
 * without magnet holes lack those corner bosses and get the two extra lines
 * instead. A deliberate printability decision, not a value fitted to a scan.
 */
export const BASE_WALL_ADHESION_EXTRA = 0.8;

/**
 * Thickness of the hollowed foot's shell for a bin: the measured
 * BASE_WALL_THICKNESS with magnet holes, plus BASE_WALL_ADHESION_EXTRA
 * without. The single source for sizing the base pocket.
 */
export function baseWallThickness(magnetHoles: boolean): number {
  return magnetHoles ? BASE_WALL_THICKNESS : BASE_WALL_THICKNESS + BASE_WALL_ADHESION_EXTRA;
}

/**
 * Thickness of the internal lattice ribs standing inside the hollowed foot:
 * the per-cell central "+" cross and the two diagonal ribs. The Pred reference
 * bin (first-layer plan slice) measures these ribs at about 0.8 mm (central
 * cross arm 0.78 mm, diagonals 0.70 mm, roughly two 0.4 mm extrusion lines);
 * that reference-measured 0.8 mm is the origin of this dimension. The owner
 * has deliberately doubled it to 1.6 mm, four 0.4 mm extrusion lines wide, so
 * the sliced first layer lays each rib as four solid perimeters instead of
 * two: a stiffer base lattice that adheres better to the build plate. This is
 * a printability decision by the owner, not a fudge fitted to make one scan's
 * numbers match; the reference remains the origin, the doubling is the choice.
 * See binGenerator's buildBasePocket for what the lattice simplifies relative
 * to the reference's full diamond pattern.
 */
export const BASE_RIB_THICKNESS = 1.6;

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
 * How far a stacked bin's foot sinks below the nominal top of the bin it
 * stands on: the depth below that plane at which the foot's bottom face comes
 * to rest. Derived from the foot profile (buildFoot) and the lip seat profile
 * (the interior cutter), not measured.
 *
 * The foot's lower chamfer and the lip's lower taper are both 45 degrees
 * (rise equals run), and both outlines follow every inset with their corner
 * radii shrinking by the same amount, so the foot slides down until its
 * chamfer lies on the taper, and it sinks below the lip tip plane (the
 * nominal top) by exactly the narrowest plan clearance between the foot's
 * bottom outline and the lip tip outline. The foot footprint and the bin's
 * outer face share the same footprint clearance to the pitch, so both
 * outlines are measured inward from one outer face.
 *
 * Both outlines are rounded rectangles, so the narrowest clearance is the
 * smaller of the straight-side clearance and the clearance along the corner
 * diagonal. Along a side it is the difference of the two insets. At a corner
 * the two arcs are nested circles whose centres lie on the diagonal: their
 * narrowest gap is the difference of the radii less the distance between the
 * centres (sqrt 2 times their inset difference), attained on that diagonal.
 * When the foot's corner centre does not lie further out than the tip's, the
 * corner is no closer than the sides. With the published profiles the corner
 * governs: 1.4 - 0.8 - 0.25 * sqrt(2), about 0.246 mm, against 0.35 mm along
 * the sides.
 *
 * Throws when the profiles no longer meet on the two 45-degree faces (no
 * clearance at all, or a sink deeper than the foot's lower chamfer), which is
 * the premise of this derivation.
 */
export function stackedFootSeatDepthMm(): number {
  const footBottomInset = FOOT_UPPER_CHAMFER + FOOT_LOWER_CHAMFER;
  const footBottomRadius = Math.max(0, BASE_TOP_RADIUS - footBottomInset);
  const lipTipRadius = Math.max(0, OUTER_CORNER_RADIUS - LIP_DEPTH);
  const sideClearance = footBottomInset - LIP_DEPTH;
  // Corner arc centres, measured inward from the outer face along each axis.
  // A positive offset puts the foot's corner centre further out than the tip's.
  const centreOffset =
    LIP_DEPTH + lipTipRadius - (footBottomInset + footBottomRadius);
  const cornerClearance =
    centreOffset > 0
      ? lipTipRadius - footBottomRadius - Math.SQRT2 * centreOffset
      : sideClearance;
  const depth = Math.min(sideClearance, cornerClearance);
  if (!(depth > 0 && depth <= FOOT_LOWER_CHAMFER)) {
    throw new Error(
      `The foot and lip profiles no longer meet on their 45-degree faces (seat depth ${depth} mm).`,
    );
  }
  return depth;
}

/**
 * How far below the nominal bin top every feature inside the stacking lip
 * stops: the label slot (channel, end stop, inserted label face), the fused
 * label, divider walls and the carved fill surface. A stacked bin's foot sinks
 * stackedFootSeatDepthMm (about 0.25 mm) below the nominal top, so anything
 * reaching that plane inside the lip props the upper bin up or tilts it. The
 * owner's choice is two 0.2 mm layers: after the slicer rounds heights to its
 * layers (a 0.25 mm first layer, then 0.2 mm layers) the printed top of
 * anything inside the lip still stays below the seat. A printability decision,
 * not a value fitted to a scan.
 */
export const STACK_SEAT_CLEARANCE_DROP = 0.4;

/**
 * Highest z any feature inside the stacking lip may reach, for a bin of the
 * given height: the nominal bin top lowered by STACK_SEAT_CLEARANCE_DROP. The
 * single home for this figure; the label slot, the fused label, the divider
 * walls and the carved fill all stop here.
 */
export function interiorFeatureTopZ(heightUnits: number): number {
  return heightUnits * HEIGHT_UNIT - STACK_SEAT_CLEARANCE_DROP;
}

/**
 * Fewest whole height units (at least MIN_HEIGHT_UNITS) whose
 * interiorFeatureTopZ reaches `topZ`: the inverse of interiorFeatureTopZ, for
 * a flow that sizes a bin's height to what it has to hold.
 */
export function heightUnitsForInteriorTopZ(topZ: number): number {
  if (!Number.isFinite(topZ)) {
    throw new RangeError(`topZ must be finite, got ${topZ}`);
  }
  let units = MIN_HEIGHT_UNITS;
  while (interiorFeatureTopZ(units) < topZ) units += 1;
  return units;
}

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
 * Baseplate socket profile, bottom to top: a 45 degree lower chamfer, a
 * vertical band, and a 45 degree upper chamfer opening to the plate top.
 * Measured from the reference baseplate (1x1-default.stl); the socket is the
 * stacking lip seat opened out by the footprint clearance, so each band
 * equals an existing bin constant rather than being a new number.
 */
/** Equals LIP_LOWER_TAPER (0.70); measured 0.7000 on the reference socket. */
export const BASEPLATE_LOWER_CHAMFER = LIP_LOWER_TAPER;

/** Equals LIP_SEAT_VERTICAL (1.80); measured 1.8000 on the reference socket. */
export const BASEPLATE_VERTICAL = LIP_SEAT_VERTICAL;

/** Equals FOOT_UPPER_CHAMFER (2.15); measured 2.1500 on the reference socket. */
export const BASEPLATE_UPPER_CHAMFER = FOOT_UPPER_CHAMFER;

/** Total socket depth, the height of a plate without magnets or screws (4.65). */
export const BASEPLATE_HEIGHT =
  BASEPLATE_LOWER_CHAMFER + BASEPLATE_VERTICAL + BASEPLATE_UPPER_CHAMFER;

/**
 * How far the socket opens beyond the bin's base footprint per side. Measured
 * 0.25 (socket top 42.000 against BASE_TOP_SIZE 41.5, per side); equals
 * (PITCH - BASE_TOP_SIZE) / 2 at the standard pitch, the Gridfinity footprint
 * clearance the bin already keeps to the pitch.
 */
export const BASEPLATE_SOCKET_CLEARANCE = (PITCH - BASE_TOP_SIZE) / 2;

/**
 * Thickness of an interior divider wall. Matches the 1.2 mm divider width
 * used by kennetek/gridfinity-rebuilt-openscad (d_div in src/core/standard.scad).
 */
export const DIVIDER_THICKNESS = 1.2;

/**
 * Smallest usable compartment gap between two separate divider walls: the
 * minimum clear distance the validator requires between two walls that do not
 * touch or cross, so a compartment stays wide enough to be usable. Owner-set
 * value, not a measured constant.
 */
export const MIN_COMPARTMENT_MM = 2;

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
 * Fewest grid cells along one axis whose clear interior spans `extentMm`.
 *
 * The inverse of binInteriorSizeMm and the single home for the question every
 * flow that grows a bin to hold something has to ask: a traced layout sizing
 * itself to its pockets, and a cutout bin fitted to its placed models. Both
 * must answer it identically, so both derive it here.
 *
 * The interior is treated as its bounding rectangle; the rounded corners are
 * not modelled, and the carve's exact containment check stays the authority
 * over whether a given shape actually fits.
 */
export function cellsForInteriorMm(extentMm: number): number {
  if (!Number.isFinite(extentMm)) {
    throw new RangeError(`extentMm must be finite, got ${extentMm}`);
  }
  let cells = 1;
  while (binInteriorSizeMm(cells) < extentMm) cells += 1;
  return cells;
}

/**
 * Clear opening in mm at the very top of the bin along one axis: the
 * narrowest width an object dropped in through the top must pass. The
 * stacking lip tip overhangs the interior, LIP_DEPTH in from the outer face
 * per side, so it and not the interior sets the opening. The single home for
 * this figure.
 */
export function binTopOpeningMm(cells: number): number {
  return binOuterSizeMm(cells) - 2 * LIP_DEPTH;
}
