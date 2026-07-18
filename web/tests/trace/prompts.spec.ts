import { describe, expect, it } from 'vitest';
import { groupPoints, partitionClicks } from '../../src/engine/trace/prompts';
import { pointInPolygon } from '../../src/engine/trace/edit';
import type { SamPoint } from '../../src/engine/trace/types';

// Click coordinates are chosen so every nearest-include assignment is
// unambiguous by construction; no distances are computed in the tests.

describe('partitionClicks', () => {
  it('returns one group per include click, in click order', () => {
    const points: SamPoint[] = [
      { x: 100, y: 100, label: 1 },
      { x: 500, y: 120, label: 1 },
      { x: 300, y: 400, label: 1 },
    ];
    const groups = partitionClicks(points);
    expect(groups).toHaveLength(3);
    expect(groups[0].include).toEqual({ x: 100, y: 100, label: 1 });
    expect(groups[1].include).toEqual({ x: 500, y: 120, label: 1 });
    expect(groups[2].include).toEqual({ x: 300, y: 400, label: 1 });
    expect(groups.every((group) => group.excludes.length === 0)).toBe(true);
  });

  it('assigns each exclude click to its nearest include click', () => {
    const points: SamPoint[] = [
      { x: 100, y: 100, label: 1 },
      { x: 110, y: 90, label: 0 },
      { x: 500, y: 100, label: 1 },
      { x: 480, y: 110, label: 0 },
      { x: 490, y: 95, label: 0 },
    ];
    const groups = partitionClicks(points);
    expect(groups).toHaveLength(2);
    expect(groups[0].excludes).toEqual([{ x: 110, y: 90, label: 0 }]);
    expect(groups[1].excludes).toEqual([
      { x: 480, y: 110, label: 0 },
      { x: 490, y: 95, label: 0 },
    ]);
  });

  it('returns an empty array for exclude clicks alone', () => {
    expect(partitionClicks([{ x: 50, y: 50, label: 0 }])).toEqual([]);
    expect(partitionClicks([])).toEqual([]);
  });

  it('flattens a group with the include click first', () => {
    const group = {
      include: { x: 10, y: 20, label: 1 as const },
      excludes: [{ x: 30, y: 40, label: 0 as const }],
    };
    expect(groupPoints(group)).toEqual([
      { x: 10, y: 20, label: 1 },
      { x: 30, y: 40, label: 0 },
    ]);
  });
});

describe('pointInPolygon', () => {
  // Unit square 0..10 in both axes.
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('reports a point inside the polygon', () => {
    expect(pointInPolygon(square, { x: 5, y: 5 })).toBe(true);
  });

  it('reports a point outside the polygon', () => {
    expect(pointInPolygon(square, { x: 15, y: 5 })).toBe(false);
    expect(pointInPolygon(square, { x: 5, y: -1 })).toBe(false);
  });

  it('is orientation independent', () => {
    const reversed = [...square].reverse();
    expect(pointInPolygon(reversed, { x: 5, y: 5 })).toBe(true);
    expect(pointInPolygon(reversed, { x: 15, y: 5 })).toBe(false);
  });

  it('handles a concave polygon', () => {
    // A U shape: the notch 4..6 x 4..10 is outside the polygon.
    const u = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 6, y: 10 },
      { x: 6, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon(u, { x: 5, y: 7 })).toBe(false);
    expect(pointInPolygon(u, { x: 2, y: 7 })).toBe(true);
    expect(pointInPolygon(u, { x: 5, y: 2 })).toBe(true);
  });
});
