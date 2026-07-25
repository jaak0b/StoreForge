import { beforeAll, describe, expect, it } from 'vitest';
import type { GcsWrapper } from '@salusoft89/planegcs';
import { loadGcsWrapper } from '../helpers/planegcs';
import { SKETCH_SCHEMA_VERSION, type Sketch } from '../../src/engine/sketch/model';
import { solveSketch } from '../../src/engine/sketch/solve';

let wrapper: GcsWrapper;
beforeAll(async () => {
  wrapper = await loadGcsWrapper();
});

function point(id: string, x: number, y: number, construction = false) {
  return { kind: 'point' as const, id, x, y, construction };
}
function line(id: string, p1Id: string, p2Id: string, construction = false) {
  return { kind: 'line' as const, id, p1Id, p2Id, construction };
}

/** A 30 by 20 rectangle drawn slightly off so the solver has work to do. */
function rectangleSketch(): Sketch {
  return {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      point('pA', 0.3, -0.2),
      point('pB', 29, 1),
      point('pC', 31, 21),
      point('pD', -1, 19),
      line('lAB', 'pA', 'pB'),
      line('lBC', 'pB', 'pC'),
      line('lCD', 'pC', 'pD'),
      line('lDA', 'pD', 'pA'),
    ],
    constraints: [
      { kind: 'horizontal', id: 'cH1', lineId: 'lAB' },
      { kind: 'horizontal', id: 'cH2', lineId: 'lCD' },
      { kind: 'vertical', id: 'cV1', lineId: 'lBC' },
      { kind: 'vertical', id: 'cV2', lineId: 'lDA' },
      { kind: 'length', id: 'cLen', lineId: 'lAB', mm: 30 },
      { kind: 'distance', id: 'cDist', p1Id: 'pB', p2Id: 'pC', mm: 20 },
    ],
  };
}

function solvedPoint(sketch: Sketch, id: string): { x: number; y: number } {
  const p = sketch.entities.find((e) => e.id === id);
  if (p === undefined || p.kind !== 'point') throw new Error(`missing point ${id}`);
  return p;
}

describe('solveSketch', () => {
  it('solves the dimensioned rectangle and reports the free dof', () => {
    const result = solveSketch(wrapper, rectangleSketch());
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const a = solvedPoint(result.sketch, 'pA');
    const b = solvedPoint(result.sketch, 'pB');
    const c = solvedPoint(result.sketch, 'pC');
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(30, 5);
    expect(Math.hypot(c.x - b.x, c.y - b.y)).toBeCloseTo(20, 5);
    expect(a.y).toBeCloseTo(b.y, 5);
    // The rectangle can still translate freely: two degrees of freedom.
    expect(result.dof).toBe(2);
  });

  it('solves a line with a tangent arc continuation', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        point('p1', 0, 0),
        point('p2', 20, 0),
        point('pc', 20, 10.5),
        point('p3', 30.5, 10),
        line('l1', 'p1', 'p2'),
        { kind: 'arc', id: 'a1', centerId: 'pc', startId: 'p2', endId: 'p3', construction: false },
      ],
      constraints: [
        { kind: 'horizontal', id: 'cH', lineId: 'l1' },
        { kind: 'tangent', id: 'cT', aId: 'l1', bId: 'a1' },
        { kind: 'radius', id: 'cR', entityId: 'a1', mm: 10 },
        { kind: 'distance', id: 'cD', p1Id: 'p1', p2Id: 'p2', mm: 20 },
      ],
    };
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const p2 = solvedPoint(result.sketch, 'p2');
    const pc = solvedPoint(result.sketch, 'pc');
    // Tangency at p2: the center sits perpendicular to the horizontal line.
    expect(Math.abs(pc.x - p2.x)).toBeLessThan(1e-4);
    expect(Math.hypot(pc.x - p2.x, pc.y - p2.y)).toBeCloseTo(10, 4);
  });

  it('keeps two points symmetric about a construction mirror line', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        point('m1', 10, -5, true),
        point('m2', 10, 25, true),
        point('pl', 2, 8),
        point('pr', 17, 9),
        line('mirror', 'm1', 'm2', true),
        line('span', 'pl', 'pr'),
      ],
      constraints: [
        { kind: 'vertical', id: 'cV', lineId: 'mirror' },
        { kind: 'symmetric', id: 'cS', p1Id: 'pl', p2Id: 'pr', mirrorLineId: 'mirror' },
        { kind: 'distance', id: 'cD', p1Id: 'pl', p2Id: 'pr', mm: 16 },
      ],
    };
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const pl = solvedPoint(result.sketch, 'pl');
    const pr = solvedPoint(result.sketch, 'pr');
    const m1 = solvedPoint(result.sketch, 'm1');
    expect((pl.x + pr.x) / 2).toBeCloseTo(m1.x, 4);
    expect(pr.x - pl.x).toBeCloseTo(16, 4);
  });

  it('reports the offending constraints of an over-constrained sketch', () => {
    const sketch = rectangleSketch();
    sketch.constraints.push({ kind: 'length', id: 'cClash', lineId: 'lAB', mm: 40 });
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('conflicting');
    if (result.status !== 'conflicting') return;
    expect(result.conflictingConstraintIds.length).toBeGreaterThan(0);
    for (const id of result.conflictingConstraintIds) {
      expect(sketch.constraints.some((c) => c.id === id)).toBe(true);
    }
  });

  it('moves a point to the constrained perpendicular distance from a line', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        point('pA', 0, 0),
        point('pB', 10, 0.4),
        point('pP', 4, 2),
        line('lAB', 'pA', 'pB'),
      ],
      constraints: [
        { kind: 'horizontal', id: 'cH', lineId: 'lAB' },
        { kind: 'pointLineDistance', id: 'cPL', pointId: 'pP', lineId: 'lAB', mm: 5 },
      ],
    };
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const a = solvedPoint(result.sketch, 'pA');
    const b = solvedPoint(result.sketch, 'pB');
    const p = solvedPoint(result.sketch, 'pP');
    // lAB is horizontal after solving, so the perpendicular distance is
    // simply the vertical offset from the line's (shared) y.
    expect(a.y).toBeCloseTo(b.y, 5);
    expect(Math.abs(p.y - a.y)).toBeCloseTo(5, 4);
  });

  it('does not let a driven dimension constrain the geometry', () => {
    const sketch = rectangleSketch();
    // Add a driven length dimension on a side the other constraints already
    // fully determine, at a value that would otherwise conflict.
    sketch.constraints.push({ kind: 'length', id: 'cDriven', lineId: 'lBC', mm: 999, driven: true });
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const b = solvedPoint(result.sketch, 'pB');
    const c = solvedPoint(result.sketch, 'pC');
    // Geometry unchanged by the driven dimension: still the 20 mm the
    // ordinary distance constraint drives, not the driven dimension's 999.
    expect(Math.hypot(c.x - b.x, c.y - b.y)).toBeCloseTo(20, 5);
  });

  it('moves a dragged point toward the target without breaking constraints', () => {
    const result = solveSketch(wrapper, rectangleSketch(), {
      pointId: 'pA',
      xMm: 100,
      yMm: 50,
    });
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const a = solvedPoint(result.sketch, 'pA');
    const b = solvedPoint(result.sketch, 'pB');
    expect(a.x).toBeCloseTo(100, 3);
    expect(a.y).toBeCloseTo(50, 3);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(30, 4);
  });
});
