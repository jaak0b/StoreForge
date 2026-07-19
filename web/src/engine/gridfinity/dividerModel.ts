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

/**
 * The count pair equivalent to a set of axis-aligned walls: vertical walls
 * (x1 == x2) count toward countX, horizontal walls (y1 == y2) toward countY.
 * Temporary bridge for the designer store, whose editing representation is
 * still the two count fields until the Stage 2 canvas editor lands; the store
 * only ever holds walls produced by evenDividerWalls, all axis-aligned, so
 * this recovers the counts exactly. A wall that is neither vertical nor
 * horizontal (only reachable once Stage 2 can author them) counts toward
 * neither axis.
 */
export function dividerCountsOf(walls: DividerWall[]): { countX: number; countY: number } {
  let countX = 0;
  let countY = 0;
  for (const wall of walls) {
    if (wall.x1 === wall.x2) countX += 1;
    else if (wall.y1 === wall.y2) countY += 1;
  }
  return { countX, countY };
}

/** Length of a divider wall's centreline segment. */
export function wallLength(wall: DividerWall): number {
  return Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
}

/** Standard 2D distance from point p to the segment a-b. */
function pointSegmentDistance(
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
