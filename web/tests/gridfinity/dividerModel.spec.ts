import { describe, expect, it } from 'vitest';
import {
  addWall,
  deleteWall,
  duplicateWall,
  evenDividerWalls,
  moveWall,
  moveWallEndpoint,
  nextDefaultWall,
  pointSegmentDistance,
  snapPoint,
  snapWall,
  segmentSegmentDistance,
  setWall,
  validateWalls,
  wallAngleDeg,
  wallLength,
  type DividerState,
} from '../../src/engine/gridfinity/dividerModel';
import {
  binInteriorSizeMm,
  DIVIDER_THICKNESS,
  MIN_COMPARTMENT_MM,
} from '../../src/engine/gridfinity/constants';

/** A fresh editor state for a footprint, optionally pre-populated. */
function state(gridX: number, gridY: number, walls: DividerState['walls'] = []): DividerState {
  return { gridX, gridY, walls: walls.map((wall) => ({ ...wall })) };
}

describe('evenDividerWalls', () => {
  it('places walls at the same spacing the count-based generator used', () => {
    const gridX = 1;
    const gridY = 1;
    const countX = 2;
    const walls = evenDividerWalls(gridX, gridY, countX, 0);
    const inner = binInteriorSizeMm(gridX);
    const innerDepth = binInteriorSizeMm(gridY);
    expect(walls).toHaveLength(2);
    for (let i = 1; i <= countX; i++) {
      const x = -inner / 2 + (i * inner) / (countX + 1);
      const wall = walls[i - 1];
      expect(wall.x1).toBeCloseTo(x, 9);
      expect(wall.x2).toBeCloseTo(x, 9);
      // A vertical wall spans the full interior depth.
      expect(wall.y1).toBeCloseTo(-innerDepth / 2, 9);
      expect(wall.y2).toBeCloseTo(innerDepth / 2, 9);
    }
  });

  it('emits vertical walls for countX and horizontal walls for countY', () => {
    const walls = evenDividerWalls(2, 2, 1, 1);
    expect(walls.filter((w) => w.x1 === w.x2)).toHaveLength(1);
    expect(walls.filter((w) => w.y1 === w.y2)).toHaveLength(1);
  });
});

describe('validateWalls', () => {
  it('accepts the walls evenDividerWalls produces', () => {
    expect(validateWalls(evenDividerWalls(2, 1, 1, 0), 2, 1)).toBeNull();
    expect(validateWalls(evenDividerWalls(2, 2, 2, 2), 2, 2)).toBeNull();
    expect(validateWalls([], 1, 1)).toBeNull();
  });

  it('rejects a wall running outside the interior', () => {
    const message = validateWalls([{ x1: -100, y1: 0, x2: 100, y2: 0 }], 1, 1);
    expect(message).toMatch(/outside the bin interior/);
  });

  it('rejects a wall shorter than the minimum length', () => {
    const tiny = DIVIDER_THICKNESS / 4;
    const message = validateWalls([{ x1: 0, y1: 0, x2: tiny, y2: 0 }], 2, 2);
    expect(message).toMatch(/shorter than the minimum/);
  });

  it('rejects two near-parallel walls closer than the compartment gap', () => {
    const walls = [
      { x1: 0, y1: -10, x2: 0, y2: 10 },
      { x1: 3, y1: -10, x2: 3, y2: 10 },
    ];
    const message = validateWalls(walls, 3, 1);
    expect(message).toMatch(/minimum compartment gap/);
  });

  it('allows a T-junction where one wall touches another', () => {
    const walls = [
      { x1: -20, y1: 0, x2: 20, y2: 0 },
      { x1: 0, y1: 0, x2: 0, y2: 18 },
    ];
    expect(validateWalls(walls, 2, 2)).toBeNull();
  });
});

describe('segment geometry', () => {
  it('reports zero distance for crossing segments', () => {
    const a = { x1: -5, y1: 0, x2: 5, y2: 0 };
    const b = { x1: 0, y1: -5, x2: 0, y2: 5 };
    expect(segmentSegmentDistance(a, b)).toBeCloseTo(0, 9);
  });

  it('reports the clear gap between parallel segments', () => {
    const a = { x1: 0, y1: -5, x2: 0, y2: 5 };
    const b = { x1: 4, y1: -5, x2: 4, y2: 5 };
    expect(segmentSegmentDistance(a, b)).toBeCloseTo(4, 9);
  });

  it('measures wall length as the segment length', () => {
    expect(wallLength({ x1: 0, y1: 0, x2: 3, y2: 4 })).toBeCloseTo(5, 9);
  });
});

describe('divider editor mutations', () => {
  const hx = binInteriorSizeMm(3) / 2;
  const hy = binInteriorSizeMm(2) / 2;

  it('clamps a wall drawn past the bin wall back into the interior', () => {
    const s = state(3, 2);
    addWall(s, { x1: -500, y1: -500, x2: 500, y2: 500 });
    expect(s.walls[0]).toEqual({ x1: -hx, y1: -hy, x2: hx, y2: hy });
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('deletes the wall at the index and leaves the others in order', () => {
    const s = state(3, 2, [
      { x1: -20, y1: -10, x2: -20, y2: 10 },
      { x1: 0, y1: -10, x2: 0, y2: 10 },
      { x1: 20, y1: -10, x2: 20, y2: 10 },
    ]);
    deleteWall(s, 1);
    expect(s.walls.map((w) => w.x1)).toEqual([-20, 20]);
    // An index outside the list must not remove anything.
    deleteWall(s, 7);
    deleteWall(s, -1);
    expect(s.walls).toHaveLength(2);
  });

  it('offsets a duplicate far enough that the pair stays printable', () => {
    const s = state(3, 2, [{ x1: 0, y1: -15, x2: 0, y2: 15 }]);
    const copy = duplicateWall(s, 0);
    expect(copy).not.toBeNull();
    expect(s.walls).toHaveLength(2);
    // A copy landing on the original, or merely nudged off it, would leave an
    // unprintable compartment; validateWalls is the authority on that.
    expect(s.walls[1]).not.toEqual(s.walls[0]);
    expect(segmentSegmentDistance(s.walls[0], s.walls[1])).toBeCloseTo(MIN_COMPARTMENT_MM, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('offsets a duplicate of a diagonal wall along its own normal', () => {
    const s = state(3, 2, [{ x1: -10, y1: -10, x2: 10, y2: 10 }]);
    duplicateWall(s, 0);
    expect(segmentSegmentDistance(s.walls[0], s.walls[1])).toBeCloseTo(MIN_COMPARTMENT_MM, 9);
  });

  it('translates a wall rigidly and keeps its length when it hits the bin wall', () => {
    const s = state(3, 2, [{ x1: 0, y1: -10, x2: 0, y2: 10 }]);
    const before = wallLength(s.walls[0]);
    moveWall(s, 0, 5, 0);
    expect(s.walls[0]).toEqual({ x1: 5, y1: -10, x2: 5, y2: 10 });
    // Pushed far past the wall: the wall stops at the boundary without
    // stretching or collapsing.
    moveWall(s, 0, 500, 0);
    expect(s.walls[0].x1).toBeCloseTo(hx, 9);
    expect(s.walls[0].x2).toBeCloseTo(hx, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(before, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('keeps a diagonal wall rigid when only one endpoint would leave the bin', () => {
    const s = state(3, 2, [{ x1: -10, y1: 0, x2: 10, y2: hy - 1 }]);
    const before = wallLength(s.walls[0]);
    moveWall(s, 0, 0, 500);
    expect(wallLength(s.walls[0])).toBeCloseTo(before, 9);
    expect(s.walls[0].y2).toBeCloseTo(hy, 9);
  });

  it('moves one endpoint and leaves the other one where it was', () => {
    const s = state(3, 2, [{ x1: -10, y1: 0, x2: 10, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 10, 12);
    expect(s.walls[0]).toEqual({ x1: -10, y1: 0, x2: 10, y2: 12 });
    moveWallEndpoint(s, 0, 1, -12, -4);
    expect(s.walls[0]).toEqual({ x1: -12, y1: -4, x2: 10, y2: 12 });
  });

  it('clamps a dragged endpoint to the interior', () => {
    const s = state(3, 2, [{ x1: -10, y1: 0, x2: 10, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 500, -500);
    expect(s.walls[0].x2).toBeCloseTo(hx, 9);
    expect(s.walls[0].y2).toBeCloseTo(-hy, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('replaces a wall in place and clamps it', () => {
    const s = state(3, 2, [{ x1: -10, y1: 0, x2: 10, y2: 0 }]);
    const wall = s.walls[0];
    setWall(s, 0, { x1: 0, y1: -500, x2: 0, y2: 500 });
    // Mutated in place, so a canvas holding the wall keeps tracking it.
    expect(s.walls[0]).toBe(wall);
    expect(s.walls[0]).toEqual({ x1: 0, y1: -hy, x2: 0, y2: hy });
  });

  it('lands repeated default walls on distinct positions', () => {
    const s = state(3, 2);
    for (let i = 0; i < 4; i++) addWall(s, nextDefaultWall(s));
    const positions = new Set(s.walls.map((w) => w.x1));
    // Stacked adds would look like a single wall and be impossible to select
    // apart, so every add inside one cycle must land somewhere new.
    expect(positions.size).toBe(4);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('keeps default walls inside the interior on the smallest footprint', () => {
    const s = state(1, 1);
    addWall(s, nextDefaultWall(s));
    expect(validateWalls(s.walls, 1, 1)).toBeNull();
  });
});

/**
 * The pull radius every snapping expectation below is read against, in mm. A
 * real editor derives it from a fixed pixel radius and its own view scale: the
 * divider canvas converts 8 css px into roughly 2.2 mm on a one by one bin and
 * 4.9 mm on a three by three one, so 2 mm sits just under the range it
 * produces. Stated once, because a magnetic assist has no meaning without the
 * radius it acts over.
 */
const TOLERANCE_MM = 2;

// The snapping lattice is a quarter of the 42 mm Gridfinity pitch, so a
// snapped coordinate is a multiple of 10.5 mm, and a snapped direction is a
// multiple of 15 degrees. Snapping is magnetic: those targets attract only
// from within TOLERANCE_MM and everything else is left exactly where it was
// dragged. Every expectation below is hand-computed ground truth written out,
// never rederived from the production constants.
describe('snapping', () => {
  const on = { enabled: true, toleranceMm: TOLERANCE_MM };
  const off = { enabled: false, toleranceMm: TOLERANCE_MM };

  it('attracts a point that is within reach of the quarter pitch lattice', () => {
    const p = snapPoint(11.9, -1.7, on);
    expect(p.x).toBeCloseTo(10.5, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });

  it('leaves a point between lattice lines exactly where it is', () => {
    // 5.25 mm is the midpoint between two lattice lines, 5.25 mm from each and
    // so far outside the 2 mm pull of either. A quantizing snap would drag it
    // onto a line regardless and make every value in between unreachable.
    const p = snapPoint(5.25, 16.1, on);
    expect(p.x).toBe(5.25);
    expect(p.y).toBe(16.1);
  });

  it('attracts each axis of a point independently', () => {
    // X is in reach of a lattice line and Y is not, so the point is pulled
    // onto the line and stays free along the other axis.
    const p = snapPoint(20.4, 16.1, on);
    expect(p.x).toBeCloseTo(21, 9);
    expect(p.y).toBe(16.1);
  });

  it('rounds a near horizontal wall to exactly zero degrees', () => {
    const snapped = snapWall({ x1: 0, y1: 0, x2: 21, y2: 1.3 }, 2, on);
    expect(snapped.x1).toBeCloseTo(0, 9);
    expect(snapped.y1).toBeCloseTo(0, 9);
    expect(snapped.x2).toBeCloseTo(21, 9);
    // Exactly zero, not merely small: the wall must come out axis aligned.
    expect(snapped.y2).toBeCloseTo(0, 9);
  });

  it('lets a position target outrank the angle lock', () => {
    // A 21 mm wall at 28 degrees from the origin. Its end is 0.64 mm below the
    // 10.5 lattice line and 2.46 mm from the 21 line, so Y is captured and X
    // is left free. Locking to 30 degrees was also within reach here, and the
    // two would have disagreed about where the end goes; the position target
    // wins outright and the angle simply falls out of it, which is the rule
    // that keeps the assists from fighting.
    const snapped = snapWall({ x1: 0, y1: 0, x2: 18.5419, y2: 9.8589 }, 2, on);
    expect(snapped.x2).toBe(18.5419);
    expect(snapped.y2).toBeCloseTo(10.5, 9);
  });

  it('pivots about the endpoint that is not being dragged', () => {
    const snapped = snapWall({ x1: -7.3, y1: 4.1, x2: 13.6, y2: 5.2 }, 2, on);
    // The fixed end keeps its exact coordinates, however untidy they are.
    expect(snapped.x1).toBe(-7.3);
    expect(snapped.y1).toBe(4.1);
    // Nothing is within 2 mm of the dragged end (the nearest lattice column is
    // 10.5, which is 3.1 mm away), but the direction is 3.01 degrees off
    // horizontal and a 20.93 mm wall pivots only 1.10 mm to reach 0, so the
    // angle locks and the length is left exactly as it was dragged.
    expect(snapped.y2).toBeCloseTo(4.1, 9);
    expect(snapped.x2).toBeCloseTo(-7.3 + 20.928927, 6);
  });

  it('spans the whole interior of a one wide bin when dragged just short of it', () => {
    // A one wide bin's interior is 39.6 mm deep, which is not a multiple of
    // the 10.5 mm lattice step. Stopping 1.2 mm short of the bin wall is the
    // gesture that discriminates: an overshooting drag comes back to the
    // boundary whatever snapping does, so it proves nothing, and so does a
    // drag that stops a whisker short, because the lattice line 1.2 mm outside
    // the bin wall catches it and it is brought back in. From 18.6 the
    // boundary at 19.8 is the only target in reach: 21 is 2.4 mm away and 10.5
    // is 8.1 mm away, both outside the 2 mm pull.
    const s = state(1, 1, [{ x1: 0, y1: -19.8, x2: 0, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 0, 18.6, on);
    expect(s.walls[0].x2).toBeCloseTo(0, 9);
    expect(s.walls[0].y2).toBeCloseTo(19.8, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(39.6, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('spans the whole interior of a one wide bin when the drag overshoots it', () => {
    const s = state(1, 1, [{ x1: 0, y1: -19.8, x2: 0, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 0, 500, on);
    expect(s.walls[0].y2).toBeCloseTo(19.8, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(39.6, 9);
  });

  it('spans the whole interior of a three wide bin when dragged just short of it', () => {
    // A three wide bin's interior is 123.6 mm across, again not a whole
    // number of 10.5 mm steps. From 60.6 the boundary at 61.8 is 1.2 mm away
    // and the nearest lattice lines, 63 and 52.5, are 2.4 mm and 8.1 mm away.
    const s = state(3, 2, [{ x1: -61.8, y1: 0, x2: 0, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 60.6, 0, on);
    expect(s.walls[0].y2).toBeCloseTo(0, 9);
    expect(s.walls[0].x2).toBeCloseTo(61.8, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(123.6, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('spans the whole interior of a three wide bin when the drag overshoots it', () => {
    const s = state(3, 2, [{ x1: -61.8, y1: 0, x2: 0, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 500, 0, on);
    expect(s.walls[0].x2).toBeCloseTo(61.8, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(123.6, 9);
  });

  it('takes the lattice crossing when the drag stops short of the bin wall', () => {
    // Dragged to 12 mm, well inside the bin, so the boundary at 19.8 mm is
    // not the nearest stopping point and the lattice wins.
    const s = state(1, 1, [{ x1: 0, y1: -19.8, x2: 0, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 0, 12, on);
    expect(s.walls[0].y2).toBeCloseTo(10.5, 9);
  });

  it('keeps the angle of a wall that is only being translated', () => {
    const snapped = snapWall({ x1: 3.2, y1: 1.1, x2: 9.7, y2: 25.4 }, 'translate', on);
    // Both ends probe the targets and each axis takes the smaller correction
    // either of them asks for. Along X the second end is 0.8 mm from 10.5 and
    // the first is 3.2 mm from 0, out of reach, so the wall shifts +0.8; along
    // Y the first end is 1.1 mm from 0 and the second is 4.4 mm from 21, so it
    // shifts -1.1.
    expect(snapped.x1).toBeCloseTo(4.0, 9);
    expect(snapped.y1).toBeCloseTo(0, 9);
    // Both endpoints shifted by the same offset, so the free angle survives.
    expect(snapped.x2).toBeCloseTo(10.5, 9);
    expect(snapped.y2).toBeCloseTo(24.3, 9);
    expect(snapped.x2 - snapped.x1).toBeCloseTo(6.5, 9);
    expect(snapped.y2 - snapped.y1).toBeCloseTo(24.3, 9);
  });

  it('leaves a translated wall exactly where it was dragged when nothing is near', () => {
    // Both ends sit mid-cell on both axes, far outside the 2 mm pull of any
    // lattice line, so the wall must not be nudged at all.
    const wall = { x1: 5.25, y1: 5.25, x2: 5.25, y2: 15.75 };
    expect(snapWall(wall, 'translate', on)).toEqual(wall);
  });

  it('leaves a wall untouched when snapping is disabled', () => {
    const wall = { x1: 3.2, y1: 1.1, x2: 9.7, y2: 25.4 };
    expect(snapWall(wall, 2, off)).toEqual(wall);
    expect(snapWall(wall, 'translate', off)).toEqual(wall);
    expect(snapPoint(11.9, -2.0, off)).toEqual({ x: 11.9, y: -2.0 });
  });

  it('lands a dragged wall on the lattice without deforming it', () => {
    const s = state(3, 2, [{ x1: 0, y1: -10, x2: 0, y2: 10 }]);
    // 4.2 mm is out of reach of every lattice line, so the wall goes exactly
    // where it was dragged along X; its 0.5 mm off lattice Y is within reach
    // and is pulled on.
    moveWall(s, 0, 4.2, 0, on);
    expect(s.walls[0].x1).toBeCloseTo(4.2, 9);
    expect(s.walls[0].y1).toBeCloseTo(-10.5, 9);
    // Past half a step, so it lands on the next lattice position.
    moveWall(s, 0, 6, 0, on);
    expect(s.walls[0].x1).toBeCloseTo(10.5, 9);
    expect(s.walls[0].x2).toBeCloseTo(10.5, 9);
    // The 20 mm length is unchanged: a translate never deforms the wall.
    expect(s.walls[0].y1).toBeCloseTo(-10.5, 9);
    expect(s.walls[0].y2).toBeCloseTo(9.5, 9);
  });

  it('accumulates a snapped drag delivered as many small deltas', () => {
    // A real mouse emits increments far smaller than the lattice step. Each
    // is applied against the wall as it stood when the drag began, so the
    // total is what snaps.
    const start = { x1: 0, y1: -10.5, x2: 0, y2: 10.5 };
    const many = state(3, 2, [start]);
    const origin = { ...start };
    const steps = 60;
    for (let i = 1; i <= steps; i++) {
      moveWall(many, 0, (i * 12) / steps, 0, on, origin);
    }
    const one = state(3, 2, [start]);
    moveWall(one, 0, 12, 0, on, { ...start });
    expect(many.walls[0]).toEqual(one.walls[0]);
    // And it actually moved, onto the lattice position nearest 12 mm.
    expect(many.walls[0].x1).toBeCloseTo(10.5, 9);
    expect(many.walls[0].x2).toBeCloseTo(10.5, 9);
    // The length is untouched: a translate never deforms the wall.
    expect(many.walls[0].y2 - many.walls[0].y1).toBeCloseTo(21, 9);
  });

  it('snaps a freshly drawn wall at both ends', () => {
    const s = state(3, 2);
    // Drawn a little off true: the rigid pass shifts it by -0.8 on both axes,
    // the reshape pass then pulls the second end onto the lattice as well.
    addWall(s, { x1: 0.8, y1: -9.7, x2: 1.3, y2: 9.5 }, on);
    expect(s.walls[0].x1).toBeCloseTo(0, 9);
    expect(s.walls[0].y1).toBeCloseTo(-10.5, 9);
    expect(s.walls[0].x2).toBeCloseTo(0, 9);
    expect(s.walls[0].y2).toBeCloseTo(10.5, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('keeps the snapped angle when the drag runs past the bin wall', () => {
    // A 3x1 bin is much wider than it is deep, so clamping a 45 degree drag
    // into the interior would stop X at 61.8 mm and Y at 19.8 mm and leave
    // the wall at some arbitrary shallow angle.
    const s = state(3, 1, [{ x1: 0, y1: 0, x2: 10.5, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 400, 400, on);
    const wall = s.walls[0];
    // Shortened by whole steps instead, so the run and the rise stay equal
    // and the wall is still at exactly 45 degrees.
    expect(wall.x2 - wall.x1).toBeCloseTo(wall.y2 - wall.y1, 9);
    expect(wall.y2).toBeLessThanOrEqual(19.8);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('drags an endpoint freely when snapping is disabled', () => {
    const s = state(3, 2, [{ x1: -10, y1: 0, x2: 10, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 11.3, 2.7, off);
    expect(s.walls[0]).toEqual({ x1: -10, y1: 0, x2: 11.3, y2: 2.7 });
  });
});

/**
 * The interior half-extents of the footprints the property tests sweep, in
 * bin-local mm. Hand-calculated once from the Gridfinity standard, not from
 * the production helper: a bin spanning n cells is n * 42 mm of pitch less the
 * 0.5 mm shared footprint clearance, less a 0.95 mm wall on each side, so the
 * clear interior is n * 42 - 2.4 mm and the half-extent is half of that.
 *
 * Every one of these half-extents is deliberately NOT a whole multiple of the
 * 10.5 mm snap step. That is the point of the matrix: a defect that quantized
 * a wall's length to the lattice instead of its endpoint's position survived
 * review because every footprint tried happened to make a full span reachable.
 */
const FOOTPRINTS = [
  { gridX: 1, gridY: 1, halfX: 19.8, halfY: 19.8 },
  { gridX: 1, gridY: 2, halfX: 19.8, halfY: 40.8 },
  { gridX: 2, gridY: 2, halfX: 40.8, halfY: 40.8 },
  { gridX: 3, gridY: 2, halfX: 61.8, halfY: 40.8 },
  { gridX: 3, gridY: 3, halfX: 61.8, halfY: 61.8 },
] as const;

const SNAP_ON = { enabled: true, toleranceMm: TOLERANCE_MM };
const SNAP_DISABLED = { enabled: false, toleranceMm: TOLERANCE_MM };

describe('interior half-extents the snapping matrix rests on', () => {
  it.each(FOOTPRINTS)(
    'a $gridX by $gridY bin has the hand-calculated interior half-extents',
    ({ gridX, gridY, halfX, halfY }) => {
      expect(binInteriorSizeMm(gridX) / 2).toBeCloseTo(halfX, 9);
      expect(binInteriorSizeMm(gridY) / 2).toBeCloseTo(halfY, 9);
    },
  );

  it.each(FOOTPRINTS)(
    'the interior boundary of a $gridX by $gridY bin is off the snap lattice',
    ({ halfX, halfY }) => {
      // Rounding the boundary to the lattice moves it, so the boundary is only
      // reachable because snapping treats it as a stop in its own right. If
      // this ever became a lattice multiple the full-span tests below would
      // pass for the wrong reason.
      expect(snapPoint(halfX, halfY, SNAP_ON).x).not.toBeCloseTo(halfX, 6);
      expect(snapPoint(halfX, halfY, SNAP_ON).y).not.toBeCloseTo(halfY, 6);
    },
  );
});

/**
 * How far short of the bin wall the discriminating drags stop.
 *
 * A drag that overshoots the interior comes back to the boundary whatever
 * snapping does, so it cannot tell a working snap from a broken one. Stopping
 * just inside is the gesture that separates them, but only at the right
 * distance. An interior half-extent is always 21n - 1.2 mm, so the first
 * lattice line past the bin wall sits 1.2 mm outside it: a drag that stops a
 * whisker short is captured by that outside line and then pulled back to the
 * boundary anyway, and still proves nothing.
 *
 * Stopping 1.2 mm short puts the boundary 1.2 mm away, inside the 2 mm pull,
 * and every lattice line at least 2.4 mm away, outside it. Only a build that
 * treats the interior boundary as a target in its own right reaches the bin
 * wall from here.
 */
const SHORT_OF_WALL_MM = 1.2;

describe('snapped drags reach a full span on every footprint', () => {
  it.each(FOOTPRINTS)(
    'drags a wall across the full depth of a $gridX by $gridY bin',
    ({ gridX, gridY, halfY }) => {
      const s = state(gridX, gridY, [{ x1: 0, y1: -halfY, x2: 0, y2: 0 }]);

      moveWallEndpoint(s, 0, 2, 0, halfY - SHORT_OF_WALL_MM, SNAP_ON);

      expect(s.walls[0].y2).toBeCloseTo(halfY, 9);
      expect(s.walls[0].x2).toBeCloseTo(0, 9);
    },
  );

  it.each(FOOTPRINTS)(
    'drags a wall across the full width of a $gridX by $gridY bin',
    ({ gridX, gridY, halfX }) => {
      const s = state(gridX, gridY, [{ x1: -halfX, y1: 0, x2: 0, y2: 0 }]);

      moveWallEndpoint(s, 0, 2, halfX - SHORT_OF_WALL_MM, 0, SNAP_ON);

      expect(s.walls[0].x2).toBeCloseTo(halfX, 9);
      expect(s.walls[0].y2).toBeCloseTo(0, 9);
    },
  );

  it.each(FOOTPRINTS)(
    'a drag that overshoots the bin wall still ends on it on a $gridX by $gridY bin',
    ({ gridX, gridY, halfY }) => {
      const s = state(gridX, gridY, [{ x1: 0, y1: -halfY, x2: 0, y2: 0 }]);

      moveWallEndpoint(s, 0, 2, 0, halfY + 30, SNAP_ON);

      expect(s.walls[0].y2).toBeCloseTo(halfY, 9);
    },
  );

  it.each(FOOTPRINTS)(
    'the editor and the even-dividers quick entry agree on a $gridX by $gridY bin',
    ({ gridX, gridY, halfY }) => {
      // The quick entry emits one wall spanning the interior; a snapped drag
      // to the same place must land on the same segment. Two independent
      // producers of the same figure, so neither can drift alone.
      const s = state(gridX, gridY, [{ x1: 0, y1: -halfY, x2: 0, y2: 0 }]);
      moveWallEndpoint(s, 0, 2, 0, halfY - SHORT_OF_WALL_MM, SNAP_ON);

      const generated = evenDividerWalls(gridX, gridY, 1, 0)[0];

      expect(s.walls[0].x1).toBeCloseTo(generated.x1, 9);
      expect(s.walls[0].y1).toBeCloseTo(generated.y1, 9);
      expect(s.walls[0].x2).toBeCloseTo(generated.x2, 9);
      expect(s.walls[0].y2).toBeCloseTo(generated.y2, 9);
    },
  );
});

/** Drag targets swept by the snapping invariants: inside, on and far outside. */
const DRAG_TARGETS = [
  [3.2, 1.1],
  [7.7, -13.4],
  [-16.9, 24.25],
  [31.5, 0.4],
  [-48.3, -52.6],
  [120, 95],
  [-140, 33],
  [0.6, -180],
] as const;

describe('snapping invariants', () => {
  it.each(FOOTPRINTS)(
    'a snapped endpoint always lands inside a $gridX by $gridY interior',
    ({ gridX, gridY, halfX, halfY }) => {
      for (const [x, y] of DRAG_TARGETS) {
        const s = state(gridX, gridY, [{ x1: 0, y1: 0, x2: 5, y2: 0 }]);

        moveWallEndpoint(s, 0, 2, x, y, SNAP_ON);

        expect(Math.abs(s.walls[0].x2)).toBeLessThanOrEqual(halfX + 1e-9);
        expect(Math.abs(s.walls[0].y2)).toBeLessThanOrEqual(halfY + 1e-9);
      }
    },
  );

  it.each(FOOTPRINTS)(
    'a snapped reshape never moves an endpoint further than the tolerance on a $gridX by $gridY bin',
    ({ gridX, gridY, halfX, halfY }) => {
      // The one invariant a magnetic assist owes: it may correct a drag, but
      // only by up to the pull radius. Anything further would be the old
      // quantizing behaviour, which could move an endpoint half a lattice step
      // (5.25 mm) whether or not a target was anywhere near. Drags landing
      // outside the interior are excluded: those are bounded by the interior,
      // not by the assist.
      for (const [x, y] of DRAG_TARGETS) {
        if (Math.abs(x) > halfX || Math.abs(y) > halfY) continue;

        const snapped = snapWall({ x1: 0, y1: 0, x2: x, y2: y }, 2, SNAP_ON, { gridX, gridY });

        expect(Math.hypot(snapped.x2 - x, snapped.y2 - y)).toBeLessThanOrEqual(
          TOLERANCE_MM + 1e-9,
        );
      }
    },
  );

  /** A drag of `length` at `angleDeg` from `fixed`, as a reshape of endpoint 2. */
  function reshapeAt(
    fixed: { x: number; y: number },
    angleDeg: number,
    length: number,
  ): DividerState['walls'][number] {
    const radians = (angleDeg * Math.PI) / 180;
    return {
      x1: fixed.x,
      y1: fixed.y,
      x2: fixed.x + length * Math.cos(radians),
      y2: fixed.y + length * Math.sin(radians),
    };
  }

  it.each(FOOTPRINTS)(
    'a reshape landing near a 15 degree multiple locks onto it on a $gridX by $gridY bin',
    ({ gridX, gridY }) => {
      // A 17 mm wall one degree off 15 degrees: the lock displaces its end by
      // 2 * 17 * sin(0.5 degrees) = 0.30 mm, well inside the pull radius. The
      // drag lands at (16.34, 4.69), over 3 mm clear of every lattice line and
      // of the bin wall, so only the angle can account for the correction.
      const snapped = snapWall(reshapeAt({ x: 0, y: 0 }, 16, 17), 2, SNAP_ON, { gridX, gridY });

      expect(wallAngleDeg(snapped)).toBeCloseTo(15, 9);
      expect(wallLength(snapped)).toBeCloseTo(17, 9);
    },
  );

  it('draws a wall at a free 20 degree angle with snapping still on', () => {
    // 20 degrees is 5 degrees off the nearest multiple, so locking a 30 mm
    // wall would move its end by 2 * 30 * sin(2.5 degrees) = 2.62 mm, more
    // than the pull radius, and the angle is left alone. A three by three bin
    // has the room for a wall that long. The drag lands at (28.19, 15.51),
    // more than 3 mm clear of every lattice line, so no position target can
    // account for a correction either: the wall must come out untouched.
    const snapped = snapWall(reshapeAt({ x: 0, y: 5.25 }, 20, 30), 2, SNAP_ON, {
      gridX: 3,
      gridY: 3,
    });

    expect(wallAngleDeg(snapped)).toBeCloseTo(20, 9);
    expect(wallLength(snapped)).toBeCloseTo(30, 9);
  });

  it.each(FOOTPRINTS)(
    'snapping off leaves the wall exactly as drawn on a $gridX by $gridY bin',
    ({ gridX, gridY }) => {
      for (const [x, y] of DRAG_TARGETS) {
        const drawn = { x1: -1.37, y1: 2.61, x2: x, y2: y };

        for (const anchor of ['translate', 1, 2] as const) {
          expect(snapWall(drawn, anchor, SNAP_DISABLED, { gridX, gridY })).toEqual(drawn);
        }
      }
    },
  );
});

/**
 * The other walls as snap targets. Every coordinate here is deliberately
 * mid-cell (5.25 mm is exactly halfway between two lattice lines), so nothing
 * below can pass because the lattice happened to sit in the same place.
 */
describe('other walls are snap targets', () => {
  /** A vertical wall well clear of every lattice line, on a 3 by 3 bin. */
  const NEIGHBOUR = { x1: 5.25, y1: 5.25, x2: 5.25, y2: 35.25 };

  it('closes an exact corner on another wall endpoint', () => {
    const s = state(3, 3, [NEIGHBOUR, { x1: 30, y1: 5.25, x2: 20, y2: 5.25 }]);

    // 0.83 mm from the neighbour's lower endpoint, and 0.75 mm from its
    // segment: the endpoint is the more specific target and must win, so the
    // two walls share a corner exactly rather than meeting just above it.
    moveWallEndpoint(s, 1, 2, 6.0, 5.6, SNAP_ON);

    expect(s.walls[1].x2).toBeCloseTo(5.25, 9);
    expect(s.walls[1].y2).toBeCloseTo(5.25, 9);
    expect(segmentSegmentDistance(s.walls[0], s.walls[1])).toBeCloseTo(0, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('lands an endpoint flush on another wall midspan as a clean T junction', () => {
    const s = state(3, 3, [NEIGHBOUR, { x1: 30, y1: 20, x2: 20, y2: 20 }]);

    // 1.05 mm from the neighbour's segment and nearly 15 mm from either of its
    // endpoints. The nearest lattice line is 1.0 mm away in Y, so this also
    // pins the precedence: another wall outranks the lattice.
    moveWallEndpoint(s, 1, 2, 6.3, 20.0, SNAP_ON);

    expect(s.walls[1].x2).toBeCloseTo(5.25, 9);
    expect(s.walls[1].y2).toBeCloseTo(20.0, 9);
    // Flush, not merely close: the junction has to weld when it is generated.
    expect(segmentSegmentDistance(s.walls[0], s.walls[1])).toBeCloseTo(0, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('ignores a wall that is further away than the tolerance', () => {
    const dragged = { x1: 30, y1: 20, x2: 7.9, y2: 16.1 };
    const footprint = { gridX: 3, gridY: 3 };

    // 2.65 mm clear of the neighbour, just outside the 2 mm pull.
    const reach = pointSegmentDistance(
      dragged.x2,
      dragged.y2,
      NEIGHBOUR.x1,
      NEIGHBOUR.y1,
      NEIGHBOUR.x2,
      NEIGHBOUR.y2,
    );
    expect(reach).toBeGreaterThan(TOLERANCE_MM);

    // Whatever the other assists then do, the neighbour must have contributed
    // nothing: the result has to be the one a bin with no other wall gives.
    expect(snapWall(dragged, 2, SNAP_ON, { ...footprint, walls: [NEIGHBOUR] })).toEqual(
      snapWall(dragged, 2, SNAP_ON, footprint),
    );
  });

  it('never snaps a wall to itself', () => {
    // Endpoint 2 dragged back towards the wall's own first endpoint. Were the
    // wall its own target, that endpoint would be 1.25 mm away and would
    // capture the drag, collapsing the wall to nothing.
    const s = state(3, 3, [{ x1: 5.25, y1: 5.25, x2: 5.25, y2: 35.25 }]);

    moveWallEndpoint(s, 0, 2, 5.25, 6.5, SNAP_ON);

    expect(s.walls[0].y2).toBeCloseTo(6.5, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(1.25, 9);
  });

  it('catches a translated wall on another wall', () => {
    const origin = { x1: 30, y1: 5.25, x2: 30, y2: 35.25 };
    const s = state(3, 3, [NEIGHBOUR, origin]);

    // Dragged to within 1.1 mm of sitting on the neighbour: the whole wall
    // shifts the last 1.1 mm so the two coincide, without deforming.
    moveWall(s, 1, -23.65, 0, SNAP_ON, origin);

    expect(s.walls[1].x1).toBeCloseTo(5.25, 9);
    expect(s.walls[1].x2).toBeCloseTo(5.25, 9);
    expect(wallLength(s.walls[1])).toBeCloseTo(30, 9);
  });

  it('leaves a translated wall alone when nothing is within the tolerance', () => {
    const origin = { x1: 30, y1: 5.25, x2: 30, y2: 35.25 };
    const s = state(3, 3, [NEIGHBOUR, origin]);

    // Stopping 3 mm short of the neighbour, and mid-cell on both axes.
    moveWall(s, 1, -21.75, 0, SNAP_ON, origin);

    expect(s.walls[1].x1).toBeCloseTo(8.25, 9);
    expect(s.walls[1].x2).toBeCloseTo(8.25, 9);
  });
});

describe('a drag lands exactly where it is dragged when nothing is near', () => {
  it('leaves a reshaped endpoint untouched through the whole editor path', () => {
    // The drag from the free 20 degree case above, run through the mutation
    // the canvas actually calls rather than snapWall directly.
    const s = state(3, 3, [{ x1: 0, y1: 5.25, x2: 5, y2: 5.25 }]);
    const free = { x: 28.19077862, y: 15.51060243 };

    moveWallEndpoint(s, 0, 2, free.x, free.y, SNAP_ON);

    expect(s.walls[0].x2).toBeCloseTo(free.x, 9);
    expect(s.walls[0].y2).toBeCloseTo(free.y, 9);
  });

  it('reaches a length that is not a multiple of the lattice step', () => {
    const s = state(3, 3, [{ x1: 0, y1: 5.25, x2: 5, y2: 5.25 }]);

    // 26.25 mm along a locked horizontal is two and a half lattice steps: a
    // length the old quantizing snap could never produce, because it could
    // only stop on a lattice line or the bin wall.
    moveWallEndpoint(s, 0, 2, 26.25, 5.25, SNAP_ON);

    expect(wallLength(s.walls[0])).toBeCloseTo(26.25, 9);
    expect(s.walls[0].x2).toBeCloseTo(26.25, 9);
  });
});

describe('a drag is the same however finely it is delivered', () => {
  it.each(FOOTPRINTS)(
    'many small increments equal one increment on a $gridX by $gridY bin',
    ({ gridX, gridY }) => {
      // A real pointer arrives as a stream of tiny deltas. Snapping quantizes
      // the result, so a translation that re-snapped from the already snapped
      // position would round every increment back to zero and never move.
      for (const snap of [SNAP_ON, SNAP_DISABLED]) {
        for (const [dx, dy] of [
          [13.7, -8.2],
          [-24.1, 19.6],
          [0.9, 0.4],
        ] as const) {
          const drawn = { x1: -6, y1: -4, x2: 6, y2: 4 };

          const oneStep = state(gridX, gridY, [drawn]);
          moveWall(oneStep, 0, dx, dy, snap, drawn);

          const manySteps = state(gridX, gridY, [drawn]);
          for (let i = 1; i <= 40; i++) {
            moveWall(manySteps, 0, (dx * i) / 40, (dy * i) / 40, snap, drawn);
          }

          expect(manySteps.walls[0].x1).toBeCloseTo(oneStep.walls[0].x1, 9);
          expect(manySteps.walls[0].y1).toBeCloseTo(oneStep.walls[0].y1, 9);
          expect(manySteps.walls[0].x2).toBeCloseTo(oneStep.walls[0].x2, 9);
          expect(manySteps.walls[0].y2).toBeCloseTo(oneStep.walls[0].y2, 9);
        }
      }
    },
  );
});
