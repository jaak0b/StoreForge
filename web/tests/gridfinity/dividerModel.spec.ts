import { describe, expect, it } from 'vitest';
import {
  addWall,
  deleteWall,
  duplicateWall,
  evenDividerWalls,
  moveWall,
  moveWallEndpoint,
  nextDefaultWall,
  snapPoint,
  snapWall,
  segmentSegmentDistance,
  setWall,
  validateWalls,
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

// The snapping lattice is a quarter of the 42 mm Gridfinity pitch, so a
// snapped coordinate is a multiple of 10.5 mm, and a snapped direction is a
// multiple of 15 degrees. Every expectation below is that hand-computed
// ground truth written out, never rederived from the production constants.
describe('snapping', () => {
  const on = { enabled: true };
  const off = { enabled: false };

  it('rounds a point to the nearest quarter of the grid pitch', () => {
    const p = snapPoint(11.9, -2.0, on);
    expect(p.x).toBeCloseTo(10.5, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });

  it('rounds a near horizontal wall to exactly zero degrees', () => {
    const snapped = snapWall({ x1: 0, y1: 0, x2: 21, y2: 1.3 }, 2, on);
    expect(snapped.x1).toBeCloseTo(0, 9);
    expect(snapped.y1).toBeCloseTo(0, 9);
    expect(snapped.x2).toBeCloseTo(21, 9);
    // Exactly zero, not merely small: the wall must come out axis aligned.
    expect(snapped.y2).toBeCloseTo(0, 9);
  });

  it('rounds a wall near thirty degrees to exactly thirty degrees', () => {
    // A 21 mm wall at 28 degrees from the origin.
    const snapped = snapWall({ x1: 0, y1: 0, x2: 18.5419, y2: 9.8589 }, 2, on);
    // 21 mm at exactly 30 degrees: 21 * cos 30 and 21 * sin 30.
    expect(snapped.x2).toBeCloseTo(18.186533479, 6);
    expect(snapped.y2).toBeCloseTo(10.5, 6);
  });

  it('pivots about the endpoint that is not being dragged', () => {
    const snapped = snapWall({ x1: -7.3, y1: 4.1, x2: 13.6, y2: 5.2 }, 2, on);
    // The fixed end keeps its exact coordinates, however untidy they are.
    expect(snapped.x1).toBe(-7.3);
    expect(snapped.y1).toBe(4.1);
    expect(snapped.y2).toBeCloseTo(4.1, 9);
    // The dragged end lands on the lattice itself: it is the position that
    // snaps, not the length. The drag reached 13.6, and 10.5 is the nearest
    // lattice column to it along the snapped direction.
    expect(snapped.x2).toBeCloseTo(10.5, 9);
  });

  it('spans the whole interior of a one wide bin when dragged to the edge', () => {
    // A one wide bin's interior is 39.6 mm deep, which is not a multiple of
    // the 10.5 mm lattice step. Quantizing the length would stop the wall at
    // 31.5 mm and never reach the bin wall, so the most common divider of all,
    // a full span one, would be impossible to draw with snapping on.
    const s = state(1, 1, [{ x1: 0, y1: -19.8, x2: 0, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 0, 500, on);
    expect(s.walls[0].x2).toBeCloseTo(0, 9);
    expect(s.walls[0].y2).toBeCloseTo(19.8, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(39.6, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
  });

  it('spans the whole interior of a three wide bin when dragged to the edge', () => {
    // A three wide bin's interior is 123.6 mm across, again not a whole
    // number of 10.5 mm steps: the last lattice crossing before the wall is
    // at 53.7 mm and the boundary is at 61.8 mm.
    const s = state(3, 2, [{ x1: -61.8, y1: 0, x2: 0, y2: 0 }]);
    moveWallEndpoint(s, 0, 2, 500, 0, on);
    expect(s.walls[0].y2).toBeCloseTo(0, 9);
    expect(s.walls[0].x2).toBeCloseTo(61.8, 9);
    expect(wallLength(s.walls[0])).toBeCloseTo(123.6, 9);
    expect(validateWalls(s.walls, s.gridX, s.gridY)).toBeNull();
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
    expect(snapped.x1).toBeCloseTo(0, 9);
    expect(snapped.y1).toBeCloseTo(0, 9);
    // Both endpoints shifted by the same offset, so the free angle survives.
    expect(snapped.x2).toBeCloseTo(6.5, 9);
    expect(snapped.y2).toBeCloseTo(24.3, 9);
  });

  it('leaves a wall untouched when snapping is disabled', () => {
    const wall = { x1: 3.2, y1: 1.1, x2: 9.7, y2: 25.4 };
    expect(snapWall(wall, 2, off)).toEqual(wall);
    expect(snapWall(wall, 'translate', off)).toEqual(wall);
    expect(snapPoint(11.9, -2.0, off)).toEqual({ x: 11.9, y: -2.0 });
  });

  it('lands a dragged wall on the lattice without deforming it', () => {
    const s = state(3, 2, [{ x1: 0, y1: -10, x2: 0, y2: 10 }]);
    // Short of half a lattice step along X, so the wall holds its column; the
    // first snapped move does pull its off lattice Y onto the lattice.
    moveWall(s, 0, 4.2, 0, on);
    expect(s.walls[0].x1).toBeCloseTo(0, 9);
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
    addWall(s, { x1: 1.0, y1: -9.6, x2: 1.3, y2: 9.4 }, on);
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
