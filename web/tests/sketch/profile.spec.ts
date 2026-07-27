import { describe, expect, it } from 'vitest';
import { SKETCH_SCHEMA_VERSION, type Sketch } from '../../src/engine/sketch/model';
import { extractProfile } from '../../src/engine/sketch/profile';
import { OUTLINE_TOLERANCE_MM } from '../../src/engine/trace/contour';
import type { MmPoint } from '../../src/engine/trace/types';

function point(id: string, x: number, y: number, construction = false) {
  return { kind: 'point' as const, id, x, y, construction };
}
function line(id: string, p1Id: string, p2Id: string, construction = false) {
  return { kind: 'line' as const, id, p1Id, p2Id, construction };
}
function sketchOf(entities: Sketch['entities'], constraints: Sketch['constraints'] = []): Sketch {
  return { schemaVersion: SKETCH_SCHEMA_VERSION, entities, constraints };
}

function shoelace(loop: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

describe('extractProfile', () => {
  it('extracts a closed rectangle as a positive-area outer loop', () => {
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 30, 0),
        point('pC', 30, 20),
        point('pD', 0, 20),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
        line('l3', 'pC', 'pD'),
        line('l4', 'pD', 'pA'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.holes).toEqual([]);
    expect(result.outline.outer).toHaveLength(4);
    expect(shoelace(result.outline.outer)).toBeGreaterThan(0);
    expect(Math.abs(shoelace(result.outline.outer))).toBeCloseTo(600, 6);
  });

  it('closes a chain through coincident constraints between distinct points', () => {
    const result = extractProfile(
      sketchOf(
        [
          point('pA', 0, 0),
          point('pB', 30, 0),
          point('pC', 30, 20),
          point('pD', 0, 20),
          point('pA2', 0, 0),
          line('l1', 'pA', 'pB'),
          line('l2', 'pB', 'pC'),
          line('l3', 'pC', 'pD'),
          line('l4', 'pD', 'pA2'),
        ],
        [{ kind: 'coincident', id: 'cW', p1Id: 'pA', p2Id: 'pA2' }],
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('flattens a standalone circle within the shared tolerance', () => {
    const result = extractProfile(
      sketchOf([
        point('pc', 5, 5),
        { kind: 'circle', id: 'c1', centerId: 'pc', radiusMm: 12, construction: false },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.holes).toEqual([]);
    for (const p of result.outline.outer) {
      expect(Math.hypot(p.x - 5, p.y - 5)).toBeCloseTo(12, 9);
    }
    // Chord sagitta stays within the shared trace tolerance.
    const pts = result.outline.outer;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const midDist = Math.hypot((a.x + b.x) / 2 - 5, (a.y + b.y) / 2 - 5);
      expect(12 - midDist).toBeLessThanOrEqual(OUTLINE_TOLERANCE_MM + 1e-9);
    }
  });

  it('flattens arcs in a chain', () => {
    // A 20 wide stadium-ish profile: bottom line, right semicircular arc,
    // top line, left semicircular arc (all counterclockwise in y-down mm).
    const result = extractProfile(
      sketchOf([
        point('p1', 0, 0),
        point('p2', 20, 0),
        point('cR', 20, 5),
        point('p3', 20, 10),
        point('p4', 0, 10),
        point('cL', 0, 5),
        line('lB', 'p1', 'p2'),
        { kind: 'arc', id: 'aR', centerId: 'cR', startId: 'p2', endId: 'p3', construction: false },
        line('lT', 'p3', 'p4'),
        { kind: 'arc', id: 'aL', centerId: 'cL', startId: 'p4', endId: 'p1', construction: false },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.outer.length).toBeGreaterThan(8);
    // Area of a 20x10 rectangle plus a radius-5 disc, within flattening error.
    expect(Math.abs(shoelace(result.outline.outer))).toBeGreaterThan(270);
    expect(Math.abs(shoelace(result.outline.outer))).toBeLessThan(280);
  });

  it('rejects an open chain with a user-worded message', () => {
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 30, 0),
        point('pC', 30, 20),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The outline is not closed. Connect every line and arc end to end into one loop.',
    );
  });

  it('rejects a construction-only sketch', () => {
    const result = extractProfile(
      sketchOf([point('pA', 0, 0, true), point('pB', 10, 0, true), line('l1', 'pA', 'pB', true)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The sketch has only construction geometry. Draw the shape with regular lines, arcs or a circle.',
    );
  });

  it('rejects multiple disjoint loops', () => {
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 10, 0),
        point('pC', 5, 8),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
        line('l3', 'pC', 'pA'),
        point('qc', 40, 0),
        { kind: 'circle', id: 'c1', centerId: 'qc', radiusMm: 5, construction: false },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The sketch contains more than one separate shape. Keep exactly one closed outline.',
    );
  });

  it('rejects a self-intersecting outline', () => {
    // A bowtie: the two diagonals cross.
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 10, 10),
        point('pC', 10, 0),
        point('pD', 0, 10),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
        line('l3', 'pC', 'pD'),
        line('l4', 'pD', 'pA'),
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The outline crosses itself. Adjust the shape so its boundary does not intersect.',
    );
  });
});
