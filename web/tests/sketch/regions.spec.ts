import { describe, expect, it } from 'vitest';
import { SKETCH_SCHEMA_VERSION, type Sketch } from '../../src/engine/sketch/model';
import { extractRegions, regionToOutline } from '../../src/engine/sketch/regions';
import type { MmPoint } from '../../src/engine/trace/types';

function point(id: string, x: number, y: number, construction = false) {
  return { kind: 'point' as const, id, x, y, construction };
}
function line(id: string, p1Id: string, p2Id: string, construction = false) {
  return { kind: 'line' as const, id, p1Id, p2Id, construction };
}
function circle(id: string, centerId: string, radiusMm: number, construction = false) {
  return { kind: 'circle' as const, id, centerId, radiusMm, construction };
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

describe('extractRegions', () => {
  it('splits a line through a circle into two faces', () => {
    const result = extractRegions(
      sketchOf([
        point('c', 0, 0),
        circle('circ', 'c', 10),
        point('lA', -20, -3),
        point('lB', 20, -3),
        line('l', 'lA', 'lB'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(2);
    for (const face of result.faces) {
      expect(shoelace(face.outer)).toBeGreaterThan(0);
      expect(face.holes).toEqual([]);
      expect(face.entityIds).toContain('l');
      expect(face.entityIds).toContain('circ');
    }
    const outline = regionToOutline(result.faces[0]);
    expect(outline.outer.length).toBeGreaterThan(0);
  });

  it('splits two overlapping circles into three faces', () => {
    const result = extractRegions(
      sketchOf([point('c1', 0, 0), circle('a', 'c1', 10), point('c2', 12, 0), circle('b', 'c2', 10)]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(3);
    for (const face of result.faces) {
      expect(shoelace(face.outer)).toBeGreaterThan(0);
      expect(face.holes).toEqual([]);
    }
  });

  it('keeps a circle tangent to a line as a defended tangency (no crash, one face)', () => {
    const result = extractRegions(
      sketchOf([
        point('c', 0, 0),
        circle('circ', 'c', 10),
        point('lA', -20, 10),
        point('lB', 20, 10),
        line('l', 'lA', 'lB'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(1);
    // The flattened polygon inscribes the true circle, so the area is a few
    // percent under pi * r^2 by the sagitta bound; this checks the tangency
    // did not slice off (or duplicate) a chunk of the circle.
    expect(Math.abs(result.faces[0].areaMm2 - Math.PI * 100)).toBeLessThan(10);
  });

  it('keeps two externally tangent circles as two separate faces, not crashing', () => {
    const result = extractRegions(
      sketchOf([point('c1', 0, 0), circle('a', 'c1', 10), point('c2', 20, 0), circle('b', 'c2', 10)]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(2);
  });

  it('nests a fully enclosed island circle as a hole of the containing circle', () => {
    const result = extractRegions(
      sketchOf([point('cOuter', 0, 0), circle('outer', 'cOuter', 20), point('cInner', 0, 0), circle('inner', 'cInner', 5)]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(2);
    const withHole = result.faces.find((f) => f.holes.length > 0);
    const island = result.faces.find((f) => f.holes.length === 0);
    expect(withHole).toBeDefined();
    expect(island).toBeDefined();
    if (!withHole || !island) return;
    expect(withHole.holes).toHaveLength(1);
    expect(shoelace(withHole.holes[0])).toBeLessThan(0);
    expect(withHole.areaMm2).toBeGreaterThan(island.areaMm2);
  });

  it('rejects a construction-only sketch with a user-worded message', () => {
    const result = extractRegions(
      sketchOf([point('pA', 0, 0, true), point('pB', 10, 0, true), line('l1', 'pA', 'pB', true)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The sketch has only construction geometry. Draw the shape with regular lines, arcs or a circle.',
    );
  });

  it('reports no regions for a single open line with a user-worded message', () => {
    const result = extractRegions(sketchOf([point('pA', 0, 0), point('pB', 10, 0), line('l1', 'pA', 'pB')]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('The sketch has no enclosed region. Draw lines, arcs or a circle that close off an area.');
  });
});
