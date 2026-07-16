import { describe, expect, it } from 'vitest';
import {
  arrangeAutoPlate,
  arrangePlate,
  DEFAULT_MARGIN_MM,
  type ArrangeResult,
  type FootprintItem,
} from '../../src/engine/plate/arranger';

/** Footprint of an n x m grid-cell bin (42 mm pitch, 0.5 mm clearance). */
function bin(id: string, gridX: number, gridY: number): FootprintItem {
  return { id, widthMm: gridX * 42 - 0.5, depthMm: gridY * 42 - 0.5 };
}

const PLATE = { plateWidthMm: 256, plateDepthMm: 256 };

function assertNoOverlaps(result: ArrangeResult, spacing = 4): void {
  const p = result.placed;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      const a = p[i];
      const b = p[j];
      const gapX =
        Math.abs(a.xMm - b.xMm) - (a.widthMm + b.widthMm) / 2;
      const gapY =
        Math.abs(a.yMm - b.yMm) - (a.depthMm + b.depthMm) / 2;
      // Rectangles must be separated by at least the spacing on one axis.
      expect(
        Math.max(gapX, gapY),
        `items ${a.id} and ${b.id} overlap or sit closer than the spacing`,
      ).toBeGreaterThanOrEqual(spacing - 1e-9);
    }
  }
}

function assertInsideMargins(result: ArrangeResult): void {
  for (const p of result.placed) {
    expect(p.xMm - p.widthMm / 2).toBeGreaterThanOrEqual(DEFAULT_MARGIN_MM - 1e-9);
    expect(p.xMm + p.widthMm / 2).toBeLessThanOrEqual(PLATE.plateWidthMm - DEFAULT_MARGIN_MM + 1e-9);
    expect(p.yMm - p.depthMm / 2).toBeGreaterThanOrEqual(DEFAULT_MARGIN_MM - 1e-9);
    expect(p.yMm + p.depthMm / 2).toBeLessThanOrEqual(PLATE.plateDepthMm - DEFAULT_MARGIN_MM + 1e-9);
  }
}

describe('arrangePlate', () => {
  it('places a single bin at the plate centre', () => {
    const result = arrangePlate([bin('a', 2, 2)], PLATE);
    expect(result.overflow).toEqual([]);
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0].xMm).toBeCloseTo(128, 6);
    expect(result.placed[0].yMm).toBeCloseTo(128, 6);
  });

  it('packs a known set deterministically into rows sorted by depth', () => {
    const items = [bin('small', 1, 1), bin('wide', 3, 1), bin('tall', 1, 2)];
    const result = arrangePlate(items, PLATE);
    expect(result.overflow).toEqual([]);
    const byId = Object.fromEntries(result.placed.map((p) => [p.id, p]));
    // The 1x2 bin is deepest, so it leads the single row; wide and small
    // follow, since the row still has width for them. The layout is then
    // centred: width = 41.5 + 4 + 125.5 + 4 + 41.5 = 216.5, depth = 83.5.
    const shiftX = (256 - 216.5) / 2;
    const shiftY = (256 - 83.5) / 2;
    expect(byId.wide.yMm).toBeCloseTo(byId.small.yMm, 6);
    expect(byId.wide.xMm).toBeLessThan(byId.small.xMm);
    expect(byId.tall.xMm).toBeCloseTo(shiftX + 41.5 / 2, 6);
    expect(byId.tall.yMm).toBeCloseTo(shiftY + 83.5 / 2, 6);
    expect(byId.wide.xMm).toBeCloseTo(shiftX + 41.5 + 4 + 125.5 / 2, 6);
    expect(byId.wide.yMm).toBeCloseTo(shiftY + 41.5 / 2, 6);
    expect(byId.small.xMm).toBeCloseTo(shiftX + 41.5 + 4 + 125.5 + 4 + 41.5 / 2, 6);
    assertNoOverlaps(result);
    assertInsideMargins(result);
  });

  it('is deterministic regardless of input order', () => {
    const items = [bin('a', 2, 1), bin('b', 1, 1), bin('c', 2, 2), bin('d', 1, 2)];
    const forward = arrangePlate(items, PLATE);
    const reversed = arrangePlate([...items].reverse(), PLATE);
    const key = (r: ArrangeResult) =>
      r.placed
        .map((p) => `${p.id}:${p.xMm.toFixed(6)},${p.yMm.toFixed(6)}`)
        .sort()
        .join('|');
    expect(key(reversed)).toBe(key(forward));
  });

  it('never overlaps footprints in a dense packing', () => {
    const items = Array.from({ length: 12 }, (_, i) => bin(`b${i}`, 1 + (i % 3), 1 + (i % 2)));
    const result = arrangePlate(items, PLATE);
    assertNoOverlaps(result);
    assertInsideMargins(result);
    expect(result.placed.length + result.overflow.length).toBe(items.length);
  });

  it('reports items that do not fit as overflow instead of dropping them', () => {
    const items = Array.from({ length: 40 }, (_, i) => bin(`b${i}`, 2, 2));
    const result = arrangePlate(items, PLATE);
    expect(result.overflow.length).toBeGreaterThan(0);
    expect(result.placed.length + result.overflow.length).toBe(items.length);
    assertNoOverlaps(result);
    assertInsideMargins(result);
  });

  it('overflows an item larger than the usable plate area', () => {
    const result = arrangePlate([bin('huge', 7, 7), bin('ok', 1, 1)], PLATE);
    expect(result.overflow.map((i) => i.id)).toEqual(['huge']);
    expect(result.placed.map((p) => p.id)).toEqual(['ok']);
  });

  it('respects smaller plate presets', () => {
    const items = Array.from({ length: 9 }, (_, i) => bin(`b${i}`, 2, 2));
    const large = arrangePlate(items, PLATE);
    const small = arrangePlate(items, { plateWidthMm: 180, plateDepthMm: 180 });
    expect(small.placed.length).toBeLessThan(large.placed.length);
    assertNoOverlaps(small);
  });
});

describe('arrangeAutoPlate', () => {
  it('places every item without overlap, growing the plate as needed', () => {
    const items = Array.from({ length: 40 }, (_, i) => bin(`b${i}`, 2, 2));
    const placed = arrangeAutoPlate(items);
    expect(placed).toHaveLength(items.length);
    assertNoOverlaps({ placed, overflow: [] });
  });

  it('places a single oversized item on a plate grown around it', () => {
    const placed = arrangeAutoPlate([bin('huge', 12, 12)]);
    expect(placed).toHaveLength(1);
  });

  it('returns an empty layout for no items', () => {
    expect(arrangeAutoPlate([])).toEqual([]);
  });
});
