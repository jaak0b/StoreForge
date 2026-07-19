// The single home for interior divider wall logic: the free-segment model
// that replaces the old evenly-spaced divider counts. A divider wall is a
// straight segment in bin-local mm (bin centred on the origin, matching
// buildDividers), full height and DIVIDER_THICKNESS wide, at an arbitrary
// position, length and angle. Framework-agnostic: no Vue, no Pinia, no DOM.
// Every counts-to-walls conversion (the designer store, plan file legacy
// load) goes through evenDividerWalls so there is one spacing source; every
// generation and edit path validates through validateWalls.
import { binInteriorSizeMm, DIVIDER_THICKNESS, MIN_COMPARTMENT_MM, PITCH } from './constants';

/**
 * One interior divider wall: a free segment in bin-local mm (bin centred on
 * origin, matching buildDividers), full height, DIVIDER_THICKNESS wide.
 * Arbitrary angle: the wall runs from (x1,y1) to (x2,y2).
 */
export interface DividerWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The evenly-spaced divider walls a count pair describes: countX walls
 * perpendicular to the X axis splitting the width into countX + 1 equal
 * compartments, and likewise countY along Y. Each wall spans the full
 * interior of the bin, welding into the perimeter walls where it reaches
 * them. Reproduces exactly the spacing the count-based buildDividers used
 * (positions -inner/2 + i*inner/(count+1)); the single counts-to-walls
 * source so every consumer agrees.
 */
export function evenDividerWalls(
  gridX: number,
  gridY: number,
  countX: number,
  countY: number,
): DividerWall[] {
  const innerWidth = binInteriorSizeMm(gridX);
  const innerDepth = binInteriorSizeMm(gridY);
  const walls: DividerWall[] = [];
  for (let i = 1; i <= countX; i++) {
    const x = -innerWidth / 2 + (i * innerWidth) / (countX + 1);
    walls.push({ x1: x, y1: -innerDepth / 2, x2: x, y2: innerDepth / 2 });
  }
  for (let i = 1; i <= countY; i++) {
    const y = -innerDepth / 2 + (i * innerDepth) / (countY + 1);
    walls.push({ x1: -innerWidth / 2, y1: y, x2: innerWidth / 2, y2: y });
  }
  return walls;
}

/** Length of a divider wall's centreline segment. */
export function wallLength(wall: DividerWall): number {
  return Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
}

/**
 * Direction of a divider wall in degrees, measured from the +X axis towards
 * +Y, in the range (-180, 180]. The single home for the figure, so the
 * editor's readout and the snapping math cannot disagree about it.
 */
export function wallAngleDeg(wall: DividerWall): number {
  return (Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1) * 180) / Math.PI;
}

/**
 * Editor snapping settings. A single global editor setting, not a per wall
 * property: it constrains how an edit is applied, and leaves no trace on the
 * wall it produced, so a wall drawn with snapping on is an ordinary free
 * segment afterwards.
 */
export interface SnapOptions {
  enabled: boolean;
}

/** Snapping off: the identity setting, so callers can always pass something. */
export const SNAP_OFF: SnapOptions = { enabled: false };

/**
 * How many equal parts of the Gridfinity grid pitch a snapped position may
 * land on. Quarters of the 42 mm pitch put every cell boundary on the lattice
 * for both odd and even footprints (the bin is centred on the origin, so
 * boundaries fall on multiples of half the pitch), and add two intermediate
 * positions per cell. Derived from PITCH; never a literal spacing.
 */
export const SNAP_PITCH_DIVISIONS = 4;

/** Spacing in mm of the position snapping lattice. */
export const SNAP_STEP_MM = PITCH / SNAP_PITCH_DIVISIONS;

/**
 * Angle increment in degrees a snapped wall's direction lands on. 15 degrees
 * covers the axis-aligned and diagonal cases (0, 45, 90) and the common
 * thirds (30, 60) in one step size.
 */
export const SNAP_ANGLE_STEP_DEG = 15;

/** Rounds a value to the nearest multiple of step. */
function roundToMultiple(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * The nearest point on the position snapping lattice, which is anchored on
 * the bin's centre (the origin of the wall model's coordinates). Returns the
 * point unchanged when snapping is off.
 */
export function snapPoint(
  x: number,
  y: number,
  options: SnapOptions,
): { x: number; y: number } {
  if (!options.enabled) return { x, y };
  return { x: roundToMultiple(x, SNAP_STEP_MM), y: roundToMultiple(y, SNAP_STEP_MM) };
}

/**
 * How a snapped edit is anchored. Translating a whole wall keeps its
 * direction, so only its position snaps; reshaping pivots about the endpoint
 * that is staying put, so its direction snaps as well.
 */
export type SnapAnchor = 'translate' | 1 | 2;

/**
 * A bin footprint in grid cells: everything the interior rectangle derives
 * from. Snapping takes one so the interior boundary can be a snap target;
 * DividerState satisfies it, so the editor paths pass their own state.
 */
export interface BinFootprint {
  gridX: number;
  gridY: number;
}

/** Tolerance for the degenerate direction and boundary containment tests. */
const SNAP_EPS = 1e-9;

/**
 * Tolerance in mm for the interior boundary tests: whether an endpoint counts
 * as containment (validateWalls) and whether it counts as lying on the
 * boundary (wallEndsOnInteriorBoundary). One constant so the validator and
 * the generator cannot disagree about where the boundary is.
 */
export const WALL_BOUNDARY_EPS = 1e-6;

/**
 * The distances along a ray at which a dragged endpoint may legitimately come
 * to rest: the ray's crossings with the position snapping lattice's grid
 * lines (standard ray/axis-aligned-line intersection, only the two crossings
 * per axis bracketing the drag distance, since a farther one can never be the
 * nearest), plus, when the footprint is known, the ray's intersections with
 * the interior rectangle's boundary. The boundary belongs in the set because
 * it is where a full span wall terminates, exactly as evenDividerWalls places
 * its endpoints. Candidates behind the anchor, and any landing outside the
 * interior, are dropped.
 */
function snapStopsAlongRay(
  anchor: { x: number; y: number },
  ux: number,
  uy: number,
  dragLength: number,
  footprint?: BinFootprint,
): number[] {
  const axes = [
    { origin: anchor.x, direction: ux },
    { origin: anchor.y, direction: uy },
  ];
  const stops: number[] = [];
  for (const axis of axes) {
    if (Math.abs(axis.direction) < SNAP_EPS) continue;
    const at = axis.origin + dragLength * axis.direction;
    const line = at / SNAP_STEP_MM;
    for (const k of [Math.floor(line), Math.ceil(line)]) {
      stops.push((k * SNAP_STEP_MM - axis.origin) / axis.direction);
    }
  }
  if (footprint) {
    const { hx, hy } = interiorHalfExtents(footprint);
    const edges = [
      { origin: anchor.x, direction: ux, at: hx },
      { origin: anchor.x, direction: ux, at: -hx },
      { origin: anchor.y, direction: uy, at: hy },
      { origin: anchor.y, direction: uy, at: -hy },
    ];
    for (const edge of edges) {
      if (Math.abs(edge.direction) < SNAP_EPS) continue;
      stops.push((edge.at - edge.origin) / edge.direction);
    }
  }
  return stops.filter((t) => {
    if (!(t > SNAP_EPS)) return false;
    if (!footprint) return true;
    const { hx, hy } = interiorHalfExtents(footprint);
    return (
      Math.abs(anchor.x + t * ux) <= hx + SNAP_EPS &&
      Math.abs(anchor.y + t * uy) <= hy + SNAP_EPS
    );
  });
}

/**
 * The snapped form of a wall for the edit that produced it.
 *
 * Translating ('translate') moves both endpoints by the offset that puts the
 * first endpoint on the lattice, which leaves the length and the angle exactly
 * as they were. Reshaping (1 or 2, the endpoint being dragged) holds the other
 * endpoint fixed, rounds the direction to SNAP_ANGLE_STEP_DEG, and then places
 * the dragged endpoint at the legitimate stopping point along that ray nearest
 * the drag: a lattice crossing, or the interior boundary, so a wall can span
 * the interior exactly. The endpoint's position is what quantizes; the length
 * follows from it and is never quantized as a proxy.
 *
 * Passing the footprint makes the interior boundary a snap target and keeps
 * the result inside the interior; without it only the lattice applies.
 *
 * Returns a copy of the wall unchanged when snapping is off. Pure: standard
 * rounding, atan2, rotation about a point and ray/line intersection, with no
 * tuned constants.
 */
export function snapWall(
  wall: DividerWall,
  anchor: SnapAnchor,
  options: SnapOptions,
  footprint?: BinFootprint,
): DividerWall {
  if (!options.enabled) return { ...wall };
  if (anchor === 'translate') {
    const snapped = snapPoint(wall.x1, wall.y1, options);
    const dx = snapped.x - wall.x1;
    const dy = snapped.y - wall.y1;
    return {
      x1: wall.x1 + dx,
      y1: wall.y1 + dy,
      x2: wall.x2 + dx,
      y2: wall.y2 + dy,
    };
  }
  const fixed = anchor === 1 ? { x: wall.x2, y: wall.y2 } : { x: wall.x1, y: wall.y1 };
  const moved = anchor === 1 ? { x: wall.x1, y: wall.y1 } : { x: wall.x2, y: wall.y2 };
  const dragLength = Math.hypot(moved.x - fixed.x, moved.y - fixed.y);
  if (dragLength === 0) return { ...wall };
  const angle = Math.atan2(moved.y - fixed.y, moved.x - fixed.x);
  const step = (SNAP_ANGLE_STEP_DEG * Math.PI) / 180;
  const snappedAngle = roundToMultiple(angle, step);
  const ux = Math.cos(snappedAngle);
  const uy = Math.sin(snappedAngle);
  const stops = snapStopsAlongRay(fixed, ux, uy, dragLength, footprint);
  // With no stop reachable (an anchor already outside the interior), the drag
  // distance stands and the caller's clamp is what bounds the wall.
  let distance = dragLength;
  let best = Infinity;
  for (const stop of stops) {
    const error = Math.abs(stop - dragLength);
    if (error < best) {
      best = error;
      distance = stop;
    }
  }
  const end = {
    x: fixed.x + distance * ux,
    y: fixed.y + distance * uy,
  };
  return anchor === 1
    ? { x1: end.x, y1: end.y, x2: fixed.x, y2: fixed.y }
    : { x1: fixed.x, y1: fixed.y, x2: end.x, y2: end.y };
}

/**
 * Standard 2D distance from point p to the segment a-b. Exported as the one
 * segment hit-test primitive: the top-down canvas composable picks walls,
 * tools and finger holes with it rather than keeping its own copy.
 */
export function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Orientation sign of the ordered triple (a, b, c): +1 ccw, -1 cw, 0 colinear. */
function orientation(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

/** Whether point c, known colinear with a-b, lies on the segment a-b. */
function onSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  return (
    Math.min(ax, bx) <= cx &&
    cx <= Math.max(ax, bx) &&
    Math.min(ay, by) <= cy &&
    cy <= Math.max(ay, by)
  );
}

/** Whether two segments p1-p2 and p3-p4 intersect (standard orientation test). */
function segmentsIntersect(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  p4x: number,
  p4y: number,
): boolean {
  const o1 = orientation(p1x, p1y, p2x, p2y, p3x, p3y);
  const o2 = orientation(p1x, p1y, p2x, p2y, p4x, p4y);
  const o3 = orientation(p3x, p3y, p4x, p4y, p1x, p1y);
  const o4 = orientation(p3x, p3y, p4x, p4y, p2x, p2y);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1x, p1y, p2x, p2y, p3x, p3y)) return true;
  if (o2 === 0 && onSegment(p1x, p1y, p2x, p2y, p4x, p4y)) return true;
  if (o3 === 0 && onSegment(p3x, p3y, p4x, p4y, p1x, p1y)) return true;
  if (o4 === 0 && onSegment(p3x, p3y, p4x, p4y, p2x, p2y)) return true;
  return false;
}

/** Standard shortest distance between two segments; 0 when they intersect. */
export function segmentSegmentDistance(a: DividerWall, b: DividerWall): number {
  if (segmentsIntersect(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)) return 0;
  return Math.min(
    pointSegmentDistance(a.x1, a.y1, b.x1, b.y1, b.x2, b.y2),
    pointSegmentDistance(a.x2, a.y2, b.x1, b.y1, b.x2, b.y2),
    pointSegmentDistance(b.x1, b.y1, a.x1, a.y1, a.x2, a.y2),
    pointSegmentDistance(b.x2, b.y2, a.x1, a.y1, a.x2, a.y2),
  );
}

/**
 * Validate a set of divider walls against a bin's interior, returning a
 * user-worded message naming the first problem or null when every wall is
 * acceptable. Checks:
 *  - each wall's centreline lies within the interior rectangle (a wall may
 *    reach the perimeter walls to weld into them, so the interior boundary is
 *    inclusive; its own half-thickness is allowed to sink into the wall);
 *  - each wall is at least DIVIDER_THICKNESS long, so it prints as a wall and
 *    not a sliver;
 *  - two walls that neither touch nor cross keep at least MIN_COMPARTMENT_MM
 *    of clear distance between them, so no unusably thin compartment is left.
 *    Touching walls and crossings (T-junctions, intersections) are allowed and
 *    exempt from the gap rule.
 */
export function validateWalls(
  walls: DividerWall[],
  gridX: number,
  gridY: number,
): string | null {
  const eps = WALL_BOUNDARY_EPS;
  const hx = binInteriorSizeMm(gridX) / 2;
  const hy = binInteriorSizeMm(gridY) / 2;
  for (const wall of walls) {
    if (
      !Number.isFinite(wall.x1) ||
      !Number.isFinite(wall.y1) ||
      !Number.isFinite(wall.x2) ||
      !Number.isFinite(wall.y2)
    ) {
      return 'A divider wall has an invalid coordinate.';
    }
    if (
      Math.abs(wall.x1) > hx + eps ||
      Math.abs(wall.x2) > hx + eps ||
      Math.abs(wall.y1) > hy + eps ||
      Math.abs(wall.y2) > hy + eps
    ) {
      return 'A divider wall runs outside the bin interior.';
    }
    if (wallLength(wall) < DIVIDER_THICKNESS - eps) {
      return 'A divider wall is shorter than the minimum wall length.';
    }
  }
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const distance = segmentSegmentDistance(walls[i], walls[j]);
      if (distance > eps && distance < MIN_COMPARTMENT_MM - eps) {
        return `Two divider walls are closer than the ${MIN_COMPARTMENT_MM} mm minimum compartment gap.`;
      }
    }
  }
  return null;
}

/**
 * The state the divider editor's mutations operate on, mutated in place: the
 * wall list plus the footprint that bounds it. Mirrors the trace layout
 * model's LayoutState, and the designer store satisfies it structurally, so
 * the store's actions are one-to-one wrappers with no logic of their own.
 */
export interface DividerState extends BinFootprint {
  walls: DividerWall[];
}

/** Half-extents of a footprint's interior rectangle, in bin-local mm. */
function interiorHalfExtents(footprint: BinFootprint): { hx: number; hy: number } {
  return {
    hx: binInteriorSizeMm(footprint.gridX) / 2,
    hy: binInteriorSizeMm(footprint.gridY) / 2,
  };
}

/**
 * Whether one endpoint of a wall lies on the interior rectangle's boundary,
 * that is against a perimeter wall's interior face, within
 * WALL_BOUNDARY_EPS. The single home for the question: the generator asks it
 * to decide which wall ends must be extended into the perimeter so they weld
 * into it (the ends evenDividerWalls places there), and which ends are free
 * and must be built exactly where the user drew them.
 */
export function endpointOnInteriorBoundary(
  footprint: BinFootprint,
  x: number,
  y: number,
): boolean {
  const { hx, hy } = interiorHalfExtents(footprint);
  return (
    Math.abs(Math.abs(x) - hx) <= WALL_BOUNDARY_EPS ||
    Math.abs(Math.abs(y) - hy) <= WALL_BOUNDARY_EPS
  );
}

/**
 * Which of a wall's two endpoints lie on the interior boundary, in the
 * endpoint order (x1,y1) then (x2,y2).
 */
export function wallEndsOnInteriorBoundary(
  wall: DividerWall,
  footprint: BinFootprint,
): [boolean, boolean] {
  return [
    endpointOnInteriorBoundary(footprint, wall.x1, wall.y1),
    endpointOnInteriorBoundary(footprint, wall.x2, wall.y2),
  ];
}

/**
 * The nearest point inside the interior rectangle. Every mutation runs its
 * endpoints through this, so a drag can never author a wall that leaves the
 * bin: validateWalls stays the reportable authority, but the interactive
 * paths do not rely on the user to steer back into a valid state.
 */
function clampPoint(state: DividerState, x: number, y: number): { x: number; y: number } {
  const { hx, hy } = interiorHalfExtents(state);
  return {
    x: Math.min(Math.max(x, -hx), hx),
    y: Math.min(Math.max(y, -hy), hy),
  };
}

/** A wall with both endpoints clamped into the interior. */
function clampWall(state: DividerState, wall: DividerWall): DividerWall {
  const a = clampPoint(state, wall.x1, wall.y1);
  const b = clampPoint(state, wall.x2, wall.y2);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/**
 * Where the editor's "add a wall" action drops a new wall: a full-depth
 * vertical wall on one of the evenly spaced slot positions the interior
 * affords, cycling through them by the number of walls already placed so
 * repeated adds do not stack on one another. The positions are
 * evenDividerWalls' own spacing, so this introduces no second spacing source;
 * the slot count is the largest whose spacing (inner / (slots + 1)) still
 * clears MIN_COMPARTMENT_MM, so filling a whole cycle stays printable.
 */
export function nextDefaultWall(state: DividerState): DividerWall {
  const innerWidth = binInteriorSizeMm(state.gridX);
  const slots = Math.max(1, Math.floor(innerWidth / MIN_COMPARTMENT_MM) - 1);
  const positions = evenDividerWalls(state.gridX, state.gridY, slots, 0);
  return positions[state.walls.length % slots];
}

/**
 * Appends a wall, clamped into the interior, and returns the stored wall (the
 * reactive instance when the state is a store).
 */
export function addWall(
  state: DividerState,
  wall: DividerWall,
  snap: SnapOptions = SNAP_OFF,
): DividerWall {
  // Snapping a new wall puts its first endpoint on the lattice and then
  // rebuilds the second about it, so both the position and the angle are
  // clean; with snapping off both passes are the identity.
  const positioned = snapWall(wall, 'translate', snap);
  state.walls.push(clampWall(state, snapWall(positioned, 2, snap, state)));
  return state.walls[state.walls.length - 1];
}

/** Removes the wall at index; an index outside the list is ignored. */
export function deleteWall(state: DividerState, index: number): void {
  if (index < 0 || index >= state.walls.length) return;
  state.walls.splice(index, 1);
}

/**
 * Appends a copy of the wall at index, offset along the wall's normal by the
 * minimum compartment width so the copy is both visible and separated by a
 * printable compartment rather than landing on the original. Returns the copy,
 * or null when the index is outside the list.
 */
export function duplicateWall(state: DividerState, index: number): DividerWall | null {
  if (index < 0 || index >= state.walls.length) return null;
  const source = state.walls[index];
  const length = wallLength(source);
  // A degenerate wall has no normal; offset it along X instead.
  const nx = length === 0 ? 1 : -(source.y2 - source.y1) / length;
  const ny = length === 0 ? 0 : (source.x2 - source.x1) / length;
  return addWall(state, {
    x1: source.x1 + nx * MIN_COMPARTMENT_MM,
    y1: source.y1 + ny * MIN_COMPARTMENT_MM,
    x2: source.x2 + nx * MIN_COMPARTMENT_MM,
    y2: source.y2 + ny * MIN_COMPARTMENT_MM,
  });
}

/**
 * Translates the wall at index by a delta measured from `origin`, the wall as
 * it stood when the gesture began (defaulting to where the wall is now, which
 * is the whole gesture for a single discrete move such as a keyboard nudge).
 *
 * The delta is taken from the origin rather than from the wall's present
 * position because snapping quantizes the result: a pointer drag arrives as
 * many small deltas, and re-snapping each one from the already snapped
 * position rounds every increment back to zero, so the wall never moves. With
 * the origin held for the gesture, the snapped position is a function of the
 * origin plus the total delta, so the wall follows the pointer and still lands
 * on the lattice. With snapping off the two formulations agree exactly.
 *
 * The delta is reduced per axis to the largest shift that keeps every endpoint
 * inside the interior, so a wall dragged against the bin wall stops rigid
 * instead of deforming.
 */
export function moveWall(
  state: DividerState,
  index: number,
  dxMm: number,
  dyMm: number,
  snap: SnapOptions = SNAP_OFF,
  origin?: DividerWall,
): void {
  if (index < 0 || index >= state.walls.length) return;
  const wall = state.walls[index];
  const from = origin ?? { x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2 };
  const shifted = snapWall(
    { x1: from.x1 + dxMm, y1: from.y1 + dyMm, x2: from.x2 + dxMm, y2: from.y2 + dyMm },
    'translate',
    snap,
  );
  const requestedDx = shifted.x1 - from.x1;
  const requestedDy = shifted.y1 - from.y1;
  let dx = requestedDx;
  let dy = requestedDy;
  for (const end of [
    { x: from.x1, y: from.y1 },
    { x: from.x2, y: from.y2 },
  ]) {
    const clamped = clampPoint(state, end.x + requestedDx, end.y + requestedDy);
    const ex = clamped.x - end.x;
    const ey = clamped.y - end.y;
    if (Math.abs(ex) < Math.abs(dx)) dx = ex;
    if (Math.abs(ey) < Math.abs(dy)) dy = ey;
  }
  wall.x1 = from.x1 + dx;
  wall.y1 = from.y1 + dy;
  wall.x2 = from.x2 + dx;
  wall.y2 = from.y2 + dy;
}

/**
 * Moves one endpoint of the wall at index to an absolute bin-local position,
 * clamped into the interior, leaving the other endpoint where it is: the
 * length and the angle both follow the drag.
 */
export function moveWallEndpoint(
  state: DividerState,
  index: number,
  endpoint: 1 | 2,
  xMm: number,
  yMm: number,
  snap: SnapOptions = SNAP_OFF,
): void {
  if (index < 0 || index >= state.walls.length) return;
  const wall = state.walls[index];
  // The endpoint that is staying put anchors the snap, so the wall pivots
  // about it onto a clean angle instead of drifting.
  const dragged =
    endpoint === 1
      ? { x1: xMm, y1: yMm, x2: wall.x2, y2: wall.y2 }
      : { x1: wall.x1, y1: wall.y1, x2: xMm, y2: yMm };
  // The footprint goes with it, so the snapped position can land on the
  // interior boundary and a full span wall is reachable with snapping on.
  const snapped = snapWall(dragged, endpoint, snap, state);
  const target =
    endpoint === 1
      ? { x: snapped.x1, y: snapped.y1 }
      : { x: snapped.x2, y: snapped.y2 };
  const p = clampPoint(state, target.x, target.y);
  if (endpoint === 1) {
    wall.x1 = p.x;
    wall.y1 = p.y;
  } else {
    wall.x2 = p.x;
    wall.y2 = p.y;
  }
}

/**
 * Replaces the wall at index outright, clamped into the interior: the path
 * exact numeric entry takes.
 */
export function setWall(state: DividerState, index: number, wall: DividerWall): void {
  if (index < 0 || index >= state.walls.length) return;
  const clamped = clampWall(state, wall);
  const target = state.walls[index];
  target.x1 = clamped.x1;
  target.y1 = clamped.y1;
  target.x2 = clamped.x2;
  target.y2 = clamped.y2;
}
