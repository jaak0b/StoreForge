import { describe, expect, it } from 'vitest';
import { loadManifold } from '../helpers/manifold';
import {
  applyClearance,
  boundsOf,
  fingerHoleOutline,
  primitiveOutline,
  resolvedToolOutline,
  signedArea,
  transformTool,
} from '../../src/engine/trace/edit';
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
      outline: primitiveOutline('rectangle', { widthMm: 20, heightMm: 10 }),
      rotationDeg: 90,
      offsetMm: 1,
      mirrored: false,
      clicks: [],
      fingerHoles: [],
    };
    const resolved = resolvedToolOutline(m, tool);
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
      outline: lShape(),
      rotationDeg: 0,
      offsetMm: 0,
      mirrored: false,
      clicks: [],
      fingerHoles: [],
    };
    expect(resolvedToolOutline(m, tool)).toEqual(lShape());
  });
});
