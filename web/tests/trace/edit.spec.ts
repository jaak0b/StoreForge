import { describe, expect, it } from 'vitest';
import { loadManifold } from '../helpers/manifold';
import {
  applyClearance,
  boundsOf,
  centroidOf,
  combinedCentroidOf,
  cullNarrowHoles,
  fingerHoleOutline,
  holeIndexAt,
  matchPartsByGeometry,
  placementPreservingCentroid,
  primitiveOutline,
  resolvedToolOutline,
  signedArea,
  sortPartsByCentroid,
  transformOutline,
  withoutFilledHoles,
} from '../../src/engine/trace/edit';

/** transformTool's old single-outline behavior: pivot about the outline's own centroid. */
function transformTool(
  outline: TracedOutline,
  rotationDeg: number,
  mirrored: boolean,
): TracedOutline {
  return transformOutline(outline, rotationDeg, mirrored, centroidOf(outline.outer));
}
import type { MmPoint, TracedOutline, TracedTool } from '../../src/engine/trace/types';

// Expected figures throughout are hand-derived literals from the fixture
// dimensions written next to each fixture, never recomputed from the
// production formulas.

/** A 20 mm square from (0,0) to (20,20) with a 5 mm square hole centered at (10,10). */
function squareWithHole(): TracedOutline {
  return {
    outer: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ],
    holes: [
      [
        { x: 7.5, y: 7.5 },
        { x: 7.5, y: 12.5 },
        { x: 12.5, y: 12.5 },
        { x: 12.5, y: 7.5 },
      ],
    ],
  };
}

/** An asymmetric L: 30 wide, 20 tall, with the top-right 20 x 10 removed. Area 400. */
function lShape(): TracedOutline {
  return {
    outer: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ],
    holes: [],
  };
}

/** Measured extent of a polygon along the horizontal line at the given y. */
function widthAtY(points: MmPoint[], y: number): number {
  const xs: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  return Math.max(...xs) - Math.min(...xs);
}

/** Measured extent of a polygon along the vertical line at the given x. */
function heightAtX(points: MmPoint[], x: number): number {
  const ys: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if ((a.x <= x && b.x > x) || (b.x <= x && a.x > x)) {
      ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y));
    }
  }
  return Math.max(...ys) - Math.min(...ys);
}

describe('applyClearance', () => {
  it('grows a square outline by the offset on every side, measured at the edge midlines', async () => {
    const m = await loadManifold();
    const grown = applyClearance(m, squareWithHole(), 1);
    // 20 mm square plus 1 mm clearance each side: 22 mm across the midlines.
    // Round joins only round the corners, so the midline figure is exact.
    expect(widthAtY(grown.outer, 10)).toBeCloseTo(22, 3);
    expect(heightAtX(grown.outer, 10)).toBeCloseTo(22, 3);
  });

  it('shrinks a hole by the offset while the outer grows', async () => {
    const m = await loadManifold();
    const grown = applyClearance(m, squareWithHole(), 1);
    expect(grown.holes).toHaveLength(1);
    // 5 mm hole loses 1 mm on each side: 3 mm across.
    expect(widthAtY(grown.holes[0], 10)).toBeCloseTo(3, 3);
    expect(heightAtX(grown.holes[0], 10)).toBeCloseTo(3, 3);
  });

  it('keeps the winding convention on the offset result', async () => {
    const m = await loadManifold();
    const grown = applyClearance(m, squareWithHole(), 1);
    expect(signedArea(grown.outer)).toBeGreaterThan(0);
    expect(signedArea(grown.holes[0])).toBeLessThan(0);
  });

  it('drops a hole that collapses under a large clearance', async () => {
    const m = await loadManifold();
    // 5 mm hole, 3 mm clearance from each side: nothing left.
    const grown = applyClearance(m, squareWithHole(), 3);
    expect(grown.holes).toHaveLength(0);
  });

  it('returns an untouched copy at offset 0 and rejects negative offsets', async () => {
    const m = await loadManifold();
    const original = squareWithHole();
    const copy = applyClearance(m, original, 0);
    expect(copy).toEqual(original);
    expect(copy.outer).not.toBe(original.outer);
    expect(() => applyClearance(m, original, -0.5)).toThrow(RangeError);
  });
});

describe('transformTool', () => {
  it('mirroring keeps the winding convention valid', () => {
    const mirrored = transformTool(squareWithHole(), 0, true);
    expect(signedArea(mirrored.outer)).toBeGreaterThan(0);
    expect(signedArea(mirrored.holes[0])).toBeLessThan(0);
  });

  it('mirroring preserves area and bounds and is its own inverse', () => {
    const original = lShape();
    const mirrored = transformTool(original, 0, true);
    expect(signedArea(mirrored.outer)).toBeCloseTo(400, 6);
    const bounds = boundsOf(mirrored);
    expect(bounds.width).toBeCloseTo(30, 6);
    expect(bounds.height).toBeCloseTo(20, 6);
    const restored = transformTool(mirrored, 0, true);
    for (let i = 0; i < original.outer.length; i += 1) {
      expect(restored.outer[i].x).toBeCloseTo(original.outer[i].x, 6);
      expect(restored.outer[i].y).toBeCloseTo(original.outer[i].y, 6);
    }
  });

  it('mirroring actually flips an asymmetric shape', () => {
    // The L's full-height 10 mm column spans x 0..10; its area centroid sits
    // at x = 12.5 (hand value from the 300 + 100 rectangle decomposition),
    // so the mirrored column spans x 15..25.
    const mirrored = transformTool(lShape(), 0, true);
    const xs = mirrored.outer.filter((p) => p.y > 10.5).map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(15, 6);
    expect(Math.max(...xs)).toBeCloseTo(25, 6);
  });

  it('rotation preserves area and vertex distances', () => {
    const original = lShape();
    const rotated = transformTool(original, 37, false);
    expect(signedArea(rotated.outer)).toBeCloseTo(400, 6);
    // Distance between the first and fourth vertex: from (0,0) to (10,10),
    // hand value sqrt(200) = 14.1421356.
    const a = rotated.outer[0];
    const b = rotated.outer[3];
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(14.1421356, 6);
  });

  it('rotating 90 degrees swaps the bounds of a rectangle', () => {
    const rect = primitiveOutline('rectangle', { widthMm: 20, heightMm: 10 });
    const rotated = transformTool(rect, 90, false);
    const bounds = boundsOf(rotated);
    expect(bounds.width).toBeCloseTo(10, 6);
    expect(bounds.height).toBeCloseTo(20, 6);
  });
});

describe('primitiveOutline', () => {
  it('circle vertices lie exactly on the requested diameter', () => {
    const circle = primitiveOutline('circle', { diameterMm: 10 });
    expect(circle.holes).toHaveLength(0);
    expect(signedArea(circle.outer)).toBeGreaterThan(0);
    for (const p of circle.outer) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 9);
    }
  });

  it('circle chords stay within the chordal tolerance of the true circle', () => {
    const circle = primitiveOutline('circle', { diameterMm: 10 });
    for (let i = 0; i < circle.outer.length; i += 1) {
      const a = circle.outer[i];
      const b = circle.outer[(i + 1) % circle.outer.length];
      const mid = Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2);
      // Chord midpoints may dip at most 0.1 mm below the 5 mm radius.
      expect(mid).toBeGreaterThanOrEqual(4.9);
    }
  });

  it('rectangle is dimensionally exact and centered on the origin', () => {
    const rect = primitiveOutline('rectangle', { widthMm: 20, heightMm: 10 });
    const bounds = boundsOf(rect);
    expect(bounds.minX).toBeCloseTo(-10, 9);
    expect(bounds.maxX).toBeCloseTo(10, 9);
    expect(bounds.minY).toBeCloseTo(-5, 9);
    expect(bounds.maxY).toBeCloseTo(5, 9);
    expect(signedArea(rect.outer)).toBeCloseTo(200, 9);
  });

  it('rounded rectangle keeps exact bounds and loses only the corner material', () => {
    const rect = primitiveOutline('rectangle', { widthMm: 20, heightMm: 10, cornerRadiusMm: 3 });
    const bounds = boundsOf(rect);
    expect(bounds.width).toBeCloseTo(20, 9);
    expect(bounds.height).toBeCloseTo(10, 9);
    // Hand value: 20 * 10 - (4 - pi) * 3^2 = 192.2743338. The flattened arcs
    // sit inside the true circle; with 4 chords per corner each chord removes
    // (theta - sin theta) * r^2 / 2 = 0.0451 mm^2 (theta 22.5 degrees), so 16
    // chords lose at most 0.73 mm^2 below the true-circle figure.
    expect(signedArea(rect.outer)).toBeLessThanOrEqual(192.2743339);
    expect(signedArea(rect.outer)).toBeGreaterThan(191.54);
  });

  it('rejects non-positive dimensions', () => {
    expect(() => primitiveOutline('circle', { diameterMm: 0 })).toThrow(RangeError);
    expect(() => primitiveOutline('rectangle', { widthMm: 10, heightMm: -1 })).toThrow(RangeError);
  });
});

describe('fingerHoleOutline', () => {
  it('produces a circle of the hole diameter at the hole position', () => {
    const outline = fingerHoleOutline({ x: 5, y: 7, diameterMm: 12 });
    for (const p of outline.outer) {
      expect(Math.hypot(p.x - 5, p.y - 7)).toBeCloseTo(6, 9);
    }
    const bounds = boundsOf(outline);
    expect(bounds.width).toBeCloseTo(12, 6);
    expect(bounds.height).toBeCloseTo(12, 6);
  });

  it('falls back to a circle when the second endpoint equals the first', () => {
    const outline = fingerHoleOutline({ x: 5, y: 7, x2: 5, y2: 7, diameterMm: 12 });
    for (const p of outline.outer) {
      expect(Math.hypot(p.x - 5, p.y - 7)).toBeCloseTo(6, 9);
    }
  });

  it('produces a capsule spanning the endpoint distance plus a diameter', () => {
    // Horizontal slot from (5, 7) to (15, 7), 8 mm diameter: 10 mm between
    // the endpoints plus 8 mm of caps is 18 mm long, 8 mm across, spanning
    // x 1..19 and y 3..11 (hand values).
    const outline = fingerHoleOutline({ x: 5, y: 7, x2: 15, y2: 7, diameterMm: 8 });
    expect(outline.holes).toHaveLength(0);
    expect(signedArea(outline.outer)).toBeGreaterThan(0);
    const bounds = boundsOf(outline);
    expect(bounds.minX).toBeCloseTo(1, 6);
    expect(bounds.maxX).toBeCloseTo(19, 6);
    expect(bounds.minY).toBeCloseTo(3, 6);
    expect(bounds.maxY).toBeCloseTo(11, 6);
  });

  it('keeps every capsule vertex exactly one radius from the centre segment', () => {
    // Diagonal slot from (0, 0) to (6, 8), 6 mm diameter. Every boundary
    // vertex of a capsule lies exactly on the swept circle, 3 mm from the
    // segment between the endpoints.
    const outline = fingerHoleOutline({ x: 0, y: 0, x2: 6, y2: 8, diameterMm: 6 });
    for (const p of outline.outer) {
      // Distance from p to the segment (0,0)-(6,8), computed geometrically.
      const t = Math.max(0, Math.min(1, (p.x * 6 + p.y * 8) / 100));
      const d = Math.hypot(p.x - 6 * t, p.y - 8 * t);
      expect(d).toBeCloseTo(3, 9);
    }
  });
});

describe('resolvedToolOutline', () => {
  it('applies rotation before clearance so the offset is a true mm figure in both axes', async () => {
    const m = await loadManifold();
    const tool: TracedTool = {
      id: 't1',
      name: 'test rectangle',
      parts: [primitiveOutline('rectangle', { widthMm: 20, heightMm: 10 })],
      rotationDeg: 90,
      offsetMm: 1,
      mirrored: false,
      minHoleWidthMm: 0,
      filledHoles: [],
      fingerHoles: [],
      source: { kind: 'primitive' },
    };
    const [resolved] = resolvedToolOutline(m, tool);
    // 20 x 10 rectangle rotated 90 degrees stands 10 wide by 20 tall; 1 mm
    // clearance adds 2 mm to each axis, measured across the midlines.
    expect(widthAtY(resolved.outer, 0)).toBeCloseTo(12, 3);
    expect(heightAtX(resolved.outer, 0)).toBeCloseTo(22, 3);
  });

  it('resolves the identity tool to its own outline', async () => {
    const m = await loadManifold();
    const tool: TracedTool = {
      id: 't2',
      name: 'identity',
      parts: [lShape()],
      rotationDeg: 0,
      offsetMm: 0,
      mirrored: false,
      minHoleWidthMm: 0,
      filledHoles: [],
      fingerHoles: [],
      source: { kind: 'primitive' },
    };
    const [resolved] = resolvedToolOutline(m, tool);
    expect(resolved).toEqual(lShape());
  });

  it('resolves a manually filled hole away, leaving no island', async () => {
    const m = await loadManifold();
    const tool: TracedTool = {
      id: 't3',
      name: 'filled hole',
      parts: [squareWithHole()],
      rotationDeg: 0,
      offsetMm: 0,
      mirrored: false,
      minHoleWidthMm: 0,
      filledHoles: [{ partIndex: 0, holeIndex: 0 }],
      fingerHoles: [],
      source: { kind: 'primitive' },
    };
    const [resolved] = resolvedToolOutline(m, tool);
    expect(resolved.holes).toHaveLength(0);
  });

  it('resolves a hole narrower than the minimum width away, leaving no island', async () => {
    const m = await loadManifold();
    const tool: TracedTool = {
      id: 't4',
      name: 'narrow slot',
      // The 1 mm wide slot hole is below a 1.6 mm minimum width.
      parts: [squareWithSlot()],
      rotationDeg: 0,
      offsetMm: 0,
      mirrored: false,
      minHoleWidthMm: 1.6,
      filledHoles: [],
      fingerHoles: [],
      source: { kind: 'primitive' },
    };
    const [resolved] = resolvedToolOutline(m, tool);
    expect(resolved.holes).toHaveLength(0);
  });

  it('culls a hole by width even with zero clearance', async () => {
    const m = await loadManifold();
    const tool: TracedTool = {
      id: 't5',
      name: 'wide minimum',
      // The 5 mm square hole is below a 6 mm minimum width; clearance is off.
      parts: [squareWithHole()],
      rotationDeg: 0,
      offsetMm: 0,
      mirrored: false,
      minHoleWidthMm: 6,
      filledHoles: [],
      fingerHoles: [],
      source: { kind: 'primitive' },
    };
    const [resolved] = resolvedToolOutline(m, tool);
    expect(resolved.holes).toHaveLength(0);
  });
});

/** A 20 mm square with a 1 mm wide by 14 mm tall slot hole (x 9.5..10.5, y 3..17). */
function squareWithSlot(): TracedOutline {
  return {
    outer: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ],
    holes: [
      [
        { x: 9.5, y: 3 },
        { x: 9.5, y: 17 },
        { x: 10.5, y: 17 },
        { x: 10.5, y: 3 },
      ],
    ],
  };
}

/** A 20 mm square with two 4 mm square holes: hole 0 near the left, hole 1 near the right. */
function twoHoleSquare(): TracedOutline {
  return {
    outer: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ],
    holes: [
      [
        { x: 3, y: 8 },
        { x: 3, y: 12 },
        { x: 7, y: 12 },
        { x: 7, y: 8 },
      ],
      [
        { x: 13, y: 8 },
        { x: 13, y: 12 },
        { x: 17, y: 12 },
        { x: 17, y: 8 },
      ],
    ],
  };
}

describe('cullNarrowHoles', () => {
  it('keeps a 5 mm hole at a 1.6 mm and a 4 mm minimum width', async () => {
    const m = await loadManifold();
    expect(cullNarrowHoles(m, squareWithHole(), 1.6).holes).toHaveLength(1);
    expect(cullNarrowHoles(m, squareWithHole(), 4).holes).toHaveLength(1);
  });

  it('culls a 5 mm hole at a 6 mm minimum width', async () => {
    const m = await loadManifold();
    expect(cullNarrowHoles(m, squareWithHole(), 6).holes).toHaveLength(0);
  });

  it('culls a 1 mm slot at a 1.6 mm minimum but keeps it at 0', async () => {
    const m = await loadManifold();
    expect(cullNarrowHoles(m, squareWithSlot(), 1.6).holes).toHaveLength(0);
    expect(cullNarrowHoles(m, squareWithSlot(), 0).holes).toHaveLength(1);
  });

  it('returns a distinct copy at width 0 and rejects a negative width', async () => {
    const m = await loadManifold();
    const original = squareWithHole();
    const copy = cullNarrowHoles(m, original, 0);
    expect(copy).toEqual(original);
    expect(copy.outer).not.toBe(original.outer);
    expect(copy.holes[0]).not.toBe(original.holes[0]);
    expect(() => cullNarrowHoles(m, original, -1)).toThrow(RangeError);
  });
});

describe('withoutFilledHoles', () => {
  it('removes the named hole and keeps the other', () => {
    const kept = withoutFilledHoles(twoHoleSquare(), [0]);
    expect(kept.holes).toHaveLength(1);
    // Hole 1 spans x 13..17, so its first point marks which hole survived.
    expect(kept.holes[0][0]).toEqual({ x: 13, y: 8 });
  });

  it('keeps every hole for an empty index list', () => {
    expect(withoutFilledHoles(twoHoleSquare(), []).holes).toHaveLength(2);
  });

  it('ignores an out-of-range index', () => {
    expect(withoutFilledHoles(twoHoleSquare(), [5]).holes).toHaveLength(2);
  });
});

describe('holeIndexAt', () => {
  it('returns the index of the hole the point lies in', () => {
    // (15, 10) is inside hole 1 (x 13..17, y 8..12).
    expect(holeIndexAt(twoHoleSquare(), { x: 15, y: 10 })).toBe(1);
  });

  it('returns null for a point in the body but no hole', () => {
    // (10, 10) is between the two holes, in solid material.
    expect(holeIndexAt(twoHoleSquare(), { x: 10, y: 10 })).toBeNull();
  });

  it('returns the topmost hole where two overlap', () => {
    // Two holes both covering (10, 10); the later one (index 1) wins.
    const overlapping: TracedOutline = {
      outer: twoHoleSquare().outer,
      holes: [
        [
          { x: 8, y: 8 },
          { x: 8, y: 12 },
          { x: 12, y: 12 },
          { x: 12, y: 8 },
        ],
        [
          { x: 9, y: 9 },
          { x: 9, y: 11 },
          { x: 11, y: 11 },
          { x: 11, y: 9 },
        ],
      ],
    };
    expect(holeIndexAt(overlapping, { x: 10, y: 10 })).toBe(1);
  });
});

/** Three 10 mm squares centred at (0,0), (0,20) and (20,0). */
function threeSquares(): TracedOutline[] {
  const squareAt = (cx: number, cy: number): TracedOutline => ({
    outer: [
      { x: cx - 5, y: cy - 5 },
      { x: cx + 5, y: cy - 5 },
      { x: cx + 5, y: cy + 5 },
      { x: cx - 5, y: cy + 5 },
    ],
    holes: [],
  });
  return [squareAt(0, 0), squareAt(0, 20), squareAt(20, 0)];
}

describe('sortPartsByCentroid', () => {
  it('orders parts by centroid y then x, independent of input order', () => {
    const parts = threeSquares();
    // Centroids: (0,0), (0,20), (20,0). Sorted by y then x: (0,0), (20,0), (0,20).
    const expectedOrder = [parts[0], parts[2], parts[1]];
    for (const shuffled of [
      [parts[0], parts[1], parts[2]],
      [parts[2], parts[1], parts[0]],
      [parts[1], parts[0], parts[2]],
    ]) {
      const sorted = sortPartsByCentroid(shuffled);
      expect(sorted).toEqual(expectedOrder);
    }
  });

  it('breaks an exact centroid tie (concentric parts) by area descending', () => {
    // An annulus (outer 20 mm square, inner 10 mm hole) and the 8 mm inner
    // disc it surrounds: same centroid (0,0) exactly, but the annulus has the
    // larger area, so it must sort first regardless of input order.
    const annulus: TracedOutline = {
      outer: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: -10, y: 10 },
      ],
      holes: [
        [
          { x: -5, y: -5 },
          { x: -5, y: 5 },
          { x: 5, y: 5 },
          { x: 5, y: -5 },
        ],
      ],
    };
    const disc: TracedOutline = {
      outer: [
        { x: -4, y: -4 },
        { x: 4, y: -4 },
        { x: 4, y: 4 },
        { x: -4, y: 4 },
      ],
      holes: [],
    };
    expect(sortPartsByCentroid([disc, annulus])).toEqual([annulus, disc]);
    expect(sortPartsByCentroid([annulus, disc])).toEqual([annulus, disc]);
  });
});

describe('combinedCentroidOf', () => {
  it('is the area-weighted mean of equal-area parts: the plain centroid mean', () => {
    const parts = threeSquares();
    // Every square has the same area (100), so the combined centroid is the
    // unweighted mean of (0,0), (0,20), (20,0): (20/3, 20/3).
    const c = combinedCentroidOf(parts);
    expect(c.x).toBeCloseTo(20 / 3, 9);
    expect(c.y).toBeCloseTo(20 / 3, 9);
  });

  it('weights a larger part more heavily', () => {
    const small = threeSquares()[0]; // 10x10 at origin, area 100
    const big: TracedOutline = {
      outer: [
        { x: 15, y: -10 },
        { x: 35, y: -10 },
        { x: 35, y: 10 },
        { x: 15, y: 10 },
      ],
      holes: [],
    }; // 20x20 at (25, 0), area 400
    const c = combinedCentroidOf([small, big]);
    // Weighted mean x: (0*100 + 25*400) / 500 = 20.
    expect(c.x).toBeCloseTo(20, 9);
    expect(c.y).toBeCloseTo(0, 9);
  });
});

describe('matchPartsByGeometry', () => {
  it('matches parts by nearest centroid regardless of index order', () => {
    const oldParts = threeSquares();
    // The same three parts, shuffled and each nudged by under 1 mm: still the
    // nearest match, well inside the default 20 mm tolerance.
    const newParts = [
      { ...oldParts[2], outer: oldParts[2].outer.map((p) => ({ x: p.x + 0.5, y: p.y })) },
      { ...oldParts[0], outer: oldParts[0].outer.map((p) => ({ x: p.x, y: p.y + 0.5 })) },
      { ...oldParts[1], outer: oldParts[1].outer.map((p) => ({ x: p.x, y: p.y })) },
    ];
    const matches = matchPartsByGeometry(oldParts, newParts);
    expect(matches).toHaveLength(3);
    const byOld = new Map(matches.map((m) => [m.oldIndex, m.newIndex]));
    expect(byOld.get(0)).toBe(1);
    expect(byOld.get(1)).toBe(2);
    expect(byOld.get(2)).toBe(0);
  });

  it('leaves a part with no plausible match unmatched', () => {
    const oldParts = [threeSquares()[0]];
    const farAway: TracedOutline = {
      outer: [
        { x: 995, y: 995 },
        { x: 1005, y: 995 },
        { x: 1005, y: 1005 },
        { x: 995, y: 1005 },
      ],
      holes: [],
    };
    const matches = matchPartsByGeometry(oldParts, [farAway]);
    expect(matches).toHaveLength(0);
  });

  it('matches concentric parts (same centroid) by area rather than input order', () => {
    // An annulus and the inner disc it surrounds share centroid (0,0)
    // exactly, so distance alone cannot tell old-annulus/new-annulus from
    // old-annulus/new-disc: the area tie-break must pick the same-shaped part
    // on both sides.
    const annulus: TracedOutline = {
      outer: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: -10, y: 10 },
      ],
      holes: [
        [
          { x: -5, y: -5 },
          { x: -5, y: 5 },
          { x: 5, y: 5 },
          { x: 5, y: -5 },
        ],
      ],
    };
    const disc: TracedOutline = {
      outer: [
        { x: -4, y: -4 },
        { x: 4, y: -4 },
        { x: 4, y: 4 },
        { x: -4, y: 4 },
      ],
      holes: [],
    };
    const oldParts = [annulus, disc];
    // New parts shuffled and nudged slightly, disc first this time.
    const newDisc: TracedOutline = { ...disc, outer: disc.outer.map((p) => ({ x: p.x + 0.1, y: p.y })) };
    const newAnnulus: TracedOutline = {
      ...annulus,
      outer: annulus.outer.map((p) => ({ x: p.x + 0.1, y: p.y })),
    };
    const newParts = [newDisc, newAnnulus];
    const matches = matchPartsByGeometry(oldParts, newParts);
    expect(matches).toHaveLength(2);
    const byOld = new Map(matches.map((m) => [m.oldIndex, m.newIndex]));
    expect(byOld.get(0)).toBe(1); // old annulus (index 0) -> new annulus (index 1)
    expect(byOld.get(1)).toBe(0); // old disc (index 1) -> new disc (index 0)
  });

  it('assigns each side at most once even with several plausible candidates', () => {
    // Two old parts close together; two new parts close together nearby.
    // Nearest-first greedy assignment must not double-book either side.
    const oldParts = [threeSquares()[0], threeSquares()[1]];
    const newParts = [
      { ...oldParts[0], outer: oldParts[0].outer.map((p) => ({ x: p.x + 1, y: p.y })) },
      { ...oldParts[1], outer: oldParts[1].outer.map((p) => ({ x: p.x + 1, y: p.y })) },
    ];
    const matches = matchPartsByGeometry(oldParts, newParts);
    expect(matches).toHaveLength(2);
    const oldIndices = matches.map((m) => m.oldIndex).sort();
    const newIndices = matches.map((m) => m.newIndex).sort();
    expect(oldIndices).toEqual([0, 1]);
    expect(newIndices).toEqual([0, 1]);
  });
});

describe('placementPreservingCentroid', () => {
  it('keeps the combined centroid fixed in world space after parts change', () => {
    const oldParts = threeSquares();
    // Shift every new part by (10, -4) tool-local: the combined centroid
    // shifts by the same amount in tool-local space.
    const newParts = oldParts.map((p) => ({
      ...p,
      outer: p.outer.map((v) => ({ x: v.x + 10, y: v.y - 4 })),
    }));
    const placement = { xMm: 100, yMm: 50, extra: 'kept' };
    const adjusted = placementPreservingCentroid(oldParts, newParts, placement);
    expect(adjusted.extra).toBe('kept');
    const oldWorld = {
      x: placement.xMm + combinedCentroidOf(oldParts).x,
      y: placement.yMm + combinedCentroidOf(oldParts).y,
    };
    const newWorld = {
      x: adjusted.xMm + combinedCentroidOf(newParts).x,
      y: adjusted.yMm + combinedCentroidOf(newParts).y,
    };
    expect(newWorld.x).toBeCloseTo(oldWorld.x, 9);
    expect(newWorld.y).toBeCloseTo(oldWorld.y, 9);
  });

  it('is the identity when the parts are unchanged', () => {
    const parts = threeSquares();
    const placement = { xMm: 5, yMm: -3 };
    const adjusted = placementPreservingCentroid(parts, parts, placement);
    expect(adjusted.xMm).toBeCloseTo(5, 9);
    expect(adjusted.yMm).toBeCloseTo(-3, 9);
  });
});

describe('transformToolParts invariant', () => {
  it('the combined centroid is invariant under rotation and mirroring', () => {
    const parts = threeSquares();
    const before = combinedCentroidOf(parts);
    const rotated = parts.map((p) => transformOutline(p, 40, false, before));
    const after = combinedCentroidOf(rotated);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    const mirrored = parts.map((p) => transformOutline(p, 0, true, before));
    const afterMirror = combinedCentroidOf(mirrored);
    expect(afterMirror.x).toBeCloseTo(before.x, 6);
    expect(afterMirror.y).toBeCloseTo(before.y, 6);
  });
});
