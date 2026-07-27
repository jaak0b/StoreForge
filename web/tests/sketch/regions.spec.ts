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
function arc(id: string, centerId: string, startId: string, endId: string, construction = false) {
  return { kind: 'arc' as const, id, centerId, startId, endId, construction };
}
function sketchOf(entities: Sketch['entities'], constraints: Sketch['constraints'] = []): Sketch {
  return { schemaVersion: SKETCH_SCHEMA_VERSION, entities, constraints };
}

/** Closed-form area of the minor and major circular segments cut by a chord at distance d from center. */
function segmentAreas(r: number, d: number): { minor: number; major: number } {
  const minor = r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d);
  return { minor, major: Math.PI * r * r - minor };
}

/** Closed-form lens area of two equal-radius circles whose centers are `d` apart. */
function lensArea(r: number, d: number): number {
  return 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
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
    // Closed-form circular segment areas for a chord 3 mm from the center of
    // a radius-10 circle, allowing a sagitta-scale tolerance for the polygon
    // flattening (a few mm^2 at this radius, per the tangency test above).
    const { minor, major } = segmentAreas(10, 3);
    const areas = result.faces.map((f) => f.areaMm2).sort((x, y) => x - y);
    expect(Math.abs(areas[0] - minor)).toBeLessThan(4);
    expect(Math.abs(areas[1] - major)).toBeLessThan(10);
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
    // Closed-form: the lens (both circles) plus two equal crescents (one
    // circle's disc minus the lens each), tolerant of polygon flattening.
    const lens = lensArea(10, 12);
    const crescent = Math.PI * 100 - lens;
    const areas = result.faces.map((f) => f.areaMm2).sort((x, y) => x - y);
    expect(Math.abs(areas[0] - lens)).toBeLessThan(4);
    expect(Math.abs(areas[1] - crescent)).toBeLessThan(10);
    expect(Math.abs(areas[2] - crescent)).toBeLessThan(10);
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

  it('nests one hole for an island whose two overlapping circles form three internal faces', () => {
    const result = extractRegions(
      sketchOf([
        point('cBig', 0, 0),
        circle('big', 'cBig', 30),
        point('c1', -3, 0),
        circle('a', 'c1', 6),
        point('c2', 3, 0),
        circle('b', 'c2', 6),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The big circle's face, plus the island's own lens and two crescents.
    expect(result.faces).toHaveLength(4);
    const withHole = result.faces.find((f) => f.holes.length > 0);
    expect(withHole).toBeDefined();
    if (!withHole) return;
    expect(withHole.holes).toHaveLength(1);
    expect(shoelace(withHole.holes[0])).toBeLessThan(0);
    // The other three faces (lens + two crescents of the island) carry no
    // holes of their own; the whole island contributes exactly one hole to
    // the containing face, not three edge-sharing holes.
    const withoutHole = result.faces.filter((f) => f.holes.length === 0);
    expect(withoutHole).toHaveLength(3);
  });

  it('joins two rectangles sharing a partial wall into two faces', () => {
    // A's right wall runs x=10, y in [0,10]; B's left wall runs x=10, y in
    // [3,7], a partial overlap of A's wall rather than a shared endpoint.
    const result = extractRegions(
      sketchOf([
        point('a1', 0, 0),
        point('a2', 10, 0),
        point('a3', 10, 10),
        point('a4', 0, 10),
        line('aB', 'a1', 'a2'),
        line('aR', 'a2', 'a3'),
        line('aT', 'a3', 'a4'),
        line('aL', 'a4', 'a1'),
        point('b1', 10, 3),
        point('b2', 20, 3),
        point('b3', 20, 7),
        point('b4', 10, 7),
        line('bB', 'b1', 'b2'),
        line('bR', 'b2', 'b3'),
        line('bT', 'b3', 'b4'),
        line('bL', 'b4', 'b1'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(2);
    const areas = result.faces.map((f) => f.areaMm2).sort((x, y) => x - y);
    expect(areas[0]).toBeCloseTo(40, 6); // B: 10 x 4
    expect(areas[1]).toBeCloseTo(100, 6); // A: 10 x 10, untouched by the shared wall
    const squareFace = result.faces.find((f) => Math.abs(f.areaMm2 - 100) < 1e-6);
    expect(squareFace?.entityIds).toContain('aR');
    expect(squareFace?.entityIds).toContain('bL');
  });

  it('collapses an exactly coincident duplicate line onto the same edge', () => {
    const result = extractRegions(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 10, 0),
        point('pC', 10, 10),
        point('pD', 0, 10),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
        line('l3', 'pC', 'pD'),
        line('l4', 'pD', 'pA'),
        // Exact duplicate of l3, same two points, same direction.
        point('pC2', 10, 10),
        point('pD2', 0, 10),
        line('l3dup', 'pC2', 'pD2'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].areaMm2).toBeCloseTo(100, 6);
    expect(result.faces[0].entityIds).toContain('l3');
    expect(result.faces[0].entityIds).toContain('l3dup');
  });

  it('closes a face from an arc chained with a line (half disk)', () => {
    const result = extractRegions(
      sketchOf([
        point('c', 0, 0),
        point('start', 10, 0),
        point('end', -10, 0),
        arc('a1', 'c', 'start', 'end'),
        line('l1', 'end', 'start'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(1);
    expect(Math.abs(result.faces[0].areaMm2 - (Math.PI * 100) / 2)).toBeLessThan(5);
  });

  it('does not split an arc at a line intersection beyond its angular span', () => {
    // A quarter-circle pie slice (arc from (10,0) to (0,10), radius 10,
    // center origin) closed by two radius lines, plus a far, unconnected
    // line that crosses the arc's *underlying full circle* at y = -5, well
    // outside the arc's 0-90 degree span. The far line must not weld onto
    // the arc: it should stay a disconnected, faceless dangling segment.
    const result = extractRegions(
      sketchOf([
        point('c', 0, 0),
        point('start', 10, 0),
        point('end', 0, 10),
        arc('pie', 'c', 'start', 'end'),
        line('radius1', 'c', 'start'),
        line('radius2', 'end', 'c'),
        point('farA', -20, -5),
        point('farB', 20, -5),
        line('far', 'farA', 'farB'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].entityIds).not.toContain('far');
    expect(Math.abs(result.faces[0].areaMm2 - (Math.PI * 100) / 4)).toBeLessThan(3);
  });

  it('keeps a line tangent to an arc as a defended tangency', () => {
    // The tangent point (0, 10) lies exactly at the arc's own end, within
    // its 0-90 degree span.
    const result = extractRegions(
      sketchOf([
        point('c', 0, 0),
        point('start', 10, 0),
        point('end', 0, 10),
        arc('pie', 'c', 'start', 'end'),
        line('radius1', 'c', 'start'),
        line('radius2', 'end', 'c'),
        point('tA', -20, 10),
        point('tB', 20, 10),
        line('tangent', 'tA', 'tB'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faces).toHaveLength(1);
    expect(Math.abs(result.faces[0].areaMm2 - (Math.PI * 100) / 4)).toBeLessThan(3);
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
