import { describe, expect, it } from 'vitest';
import {
  dividerCountsOf,
  evenDividerWalls,
  segmentSegmentDistance,
  validateWalls,
  wallLength,
} from '../../src/engine/gridfinity/dividerModel';
import { binInteriorSizeMm, DIVIDER_THICKNESS } from '../../src/engine/gridfinity/constants';

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
    const counts = dividerCountsOf(walls);
    expect(counts).toEqual({ countX: 1, countY: 1 });
  });

  it('round-trips through dividerCountsOf', () => {
    const walls = evenDividerWalls(3, 2, 2, 3);
    expect(dividerCountsOf(walls)).toEqual({ countX: 2, countY: 3 });
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
