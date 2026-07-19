import { describe, expect, it } from 'vitest';
import {
  addWall,
  deleteWall,
  duplicateWall,
  evenDividerWalls,
  moveWall,
  moveWallEndpoint,
  nextDefaultWall,
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
