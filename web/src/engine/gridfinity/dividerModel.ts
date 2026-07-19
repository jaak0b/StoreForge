// The single home for interior divider wall logic: the free-segment model
// that replaces the old evenly-spaced divider counts. A divider wall is a
// straight segment in bin-local mm (bin centred on the origin, matching
// buildDividers), full height and DIVIDER_THICKNESS wide, at an arbitrary
// position, length and angle. Framework-agnostic: no Vue, no Pinia, no DOM.
// Every counts-to-walls conversion (the designer store, plan file legacy
// load) goes through evenDividerWalls so there is one spacing source; every
// generation and edit path validates through validateWalls.
import { binInteriorSizeMm, DIVIDER_THICKNESS, MIN_COMPARTMENT_MM } from './constants';

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
  const eps = 1e-6;
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
export interface DividerState {
  walls: DividerWall[];
  gridX: number;
  gridY: number;
}

/** Half-extents of a footprint's interior rectangle, in bin-local mm. */
function interiorHalfExtents(state: DividerState): { hx: number; hy: number } {
  return {
    hx: binInteriorSizeMm(state.gridX) / 2,
    hy: binInteriorSizeMm(state.gridY) / 2,
  };
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
export function addWall(state: DividerState, wall: DividerWall): DividerWall {
  state.walls.push(clampWall(state, wall));
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
 * Translates both endpoints of the wall at index. The delta is reduced per
 * axis to the largest shift that keeps every endpoint inside the interior, so
 * a wall dragged against the bin wall stops rigid instead of deforming.
 */
export function moveWall(state: DividerState, index: number, dxMm: number, dyMm: number): void {
  if (index < 0 || index >= state.walls.length) return;
  const wall = state.walls[index];
  let dx = dxMm;
  let dy = dyMm;
  for (const end of [
    { x: wall.x1, y: wall.y1 },
    { x: wall.x2, y: wall.y2 },
  ]) {
    const clamped = clampPoint(state, end.x + dxMm, end.y + dyMm);
    const ex = clamped.x - end.x;
    const ey = clamped.y - end.y;
    if (Math.abs(ex) < Math.abs(dx)) dx = ex;
    if (Math.abs(ey) < Math.abs(dy)) dy = ey;
  }
  wall.x1 += dx;
  wall.y1 += dy;
  wall.x2 += dx;
  wall.y2 += dy;
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
): void {
  if (index < 0 || index >= state.walls.length) return;
  const wall = state.walls[index];
  const p = clampPoint(state, xMm, yMm);
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
