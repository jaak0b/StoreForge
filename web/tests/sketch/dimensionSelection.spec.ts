import { describe, expect, it } from 'vitest';
import {
  buildDimensionFromSelection,
  pickDistanceAxis,
  resolveDimensionSelection,
} from '../../src/engine/sketch/dimensionSelection';
import { angleForCursorSector } from '../../src/engine/sketch/dimensionGraphics';
import { SKETCH_SCHEMA_VERSION, type Sketch, type SketchEntity } from '../../src/engine/sketch/model';

function entity(sketch: Sketch, id: string): SketchEntity {
  const e = sketch.entities.find((x) => x.id === id);
  if (e === undefined) throw new Error(`missing entity ${id}`);
  return e;
}

describe('resolveDimensionSelection', () => {
  it('resolves a point and a line to a point-line distance', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'pP', x: 4, y: 5, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
      ],
      constraints: [],
    };
    const result = resolveDimensionSelection(sketch, [entity(sketch, 'pP'), entity(sketch, 'lAB')]);
    expect(result.resolved).toEqual({ kind: 'pointLineDistance', pointId: 'pP', lineId: 'lAB' });
  });

  it('resolves two parallel lines to a point-line distance from an endpoint of the first', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'pC', x: 0, y: 5, construction: false },
        { kind: 'point', id: 'pD', x: 10, y: 5, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
        { kind: 'line', id: 'lCD', p1Id: 'pC', p2Id: 'pD', construction: false },
      ],
      constraints: [],
    };
    const result = resolveDimensionSelection(sketch, [entity(sketch, 'lAB'), entity(sketch, 'lCD')]);
    expect(result.resolved).toEqual({ kind: 'pointLineDistance', pointId: 'pA', lineId: 'lCD' });
  });

  it('resolves two non-parallel lines to an angle', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'pC', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pD', x: 0, y: 10, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
        { kind: 'line', id: 'lCD', p1Id: 'pC', p2Id: 'pD', construction: false },
      ],
      constraints: [],
    };
    const result = resolveDimensionSelection(sketch, [entity(sketch, 'lAB'), entity(sketch, 'lCD')]);
    expect(result.resolved).toEqual({ kind: 'angle', l1Id: 'lAB', l2Id: 'lCD' });
  });

  it('resolves a line and a circle to a point-line distance from the center', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'pCenter', x: 5, y: 5, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
        { kind: 'circle', id: 'circ', centerId: 'pCenter', radiusMm: 3, construction: false },
      ],
      constraints: [],
    };
    const result = resolveDimensionSelection(sketch, [entity(sketch, 'lAB'), entity(sketch, 'circ')]);
    expect(result.resolved).toEqual({ kind: 'pointLineDistance', pointId: 'pCenter', lineId: 'lAB' });
  });

  it('resolves two circles to a distance between centers', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pC1', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pC2', x: 10, y: 0, construction: false },
        { kind: 'circle', id: 'circ1', centerId: 'pC1', radiusMm: 3, construction: false },
        { kind: 'circle', id: 'circ2', centerId: 'pC2', radiusMm: 3, construction: false },
      ],
      constraints: [],
    };
    const result = resolveDimensionSelection(sketch, [entity(sketch, 'circ1'), entity(sketch, 'circ2')]);
    expect(result.resolved).toEqual({ kind: 'distance', p1Id: 'pC1', p2Id: 'pC2' });
  });
});

describe('pickDistanceAxis', () => {
  // A horizontal segment from (0,0) to (10,0), midpoint (5,0).
  const horizontalSketch: Sketch = {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
      { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
    ],
    constraints: [],
  };
  // A vertical segment from (0,0) to (0,10), midpoint (0,5).
  const verticalSketch: Sketch = {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
      { kind: 'point', id: 'pB', x: 0, y: 10, construction: false },
    ],
    constraints: [],
  };

  it('picks the x (horizontal) flavor when the cursor is displaced across the segment', () => {
    const axis = pickDistanceAxis(horizontalSketch, 'pA', 'pB', { x: 5, y: 20 });
    expect(axis).toBe('x');
  });

  it('picks the y (vertical) flavor when the cursor is displaced across a vertical segment', () => {
    const axis = pickDistanceAxis(verticalSketch, 'pA', 'pB', { x: 20, y: 5 });
    expect(axis).toBe('y');
  });

  it('picks the aligned flavor (no axis) when the cursor stays near the segment direction', () => {
    const axis = pickDistanceAxis(horizontalSketch, 'pA', 'pB', { x: 105, y: 2 });
    expect(axis).toBeUndefined();
  });
});

describe('angleForCursorSector', () => {
  // Two lines through the origin: l1 along the x-axis, l2 at 60 degrees,
  // splitting the plane into an alternating 60/120/60/120 degree sector
  // sequence around the intersection.
  const sketch: Sketch = {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      { kind: 'point', id: 'p1a', x: 0, y: 0, construction: false },
      { kind: 'point', id: 'p1b', x: 10, y: 0, construction: false },
      { kind: 'point', id: 'p2a', x: 0, y: 0, construction: false },
      {
        kind: 'point', id: 'p2b',
        x: 10 * Math.cos((60 * Math.PI) / 180), y: 10 * Math.sin((60 * Math.PI) / 180),
        construction: false,
      },
      { kind: 'line', id: 'l1', p1Id: 'p1a', p2Id: 'p1b', construction: false },
      { kind: 'line', id: 'l2', p1Id: 'p2a', p2Id: 'p2b', construction: false },
    ],
    constraints: [],
  };

  function cursorAt(angleDeg: number): { x: number; y: number } {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: 10 * Math.cos(rad), y: 10 * Math.sin(rad) };
  }

  it('reports the acute angle for the sector between the two lines (first sector)', () => {
    expect(angleForCursorSector(sketch, 'l1', 'l2', cursorAt(30))).toBeCloseTo(60, 5);
  });

  it('reports the obtuse supplementary angle for the adjacent sector (second sector)', () => {
    expect(angleForCursorSector(sketch, 'l1', 'l2', cursorAt(120))).toBeCloseTo(120, 5);
  });

  it('reports the acute angle for the opposite (vertical-angle) sector (third sector)', () => {
    expect(angleForCursorSector(sketch, 'l1', 'l2', cursorAt(210))).toBeCloseTo(60, 5);
  });

  it('reports the obtuse angle for the fourth sector', () => {
    expect(angleForCursorSector(sketch, 'l1', 'l2', cursorAt(300))).toBeCloseTo(120, 5);
  });

  it('returns null for parallel lines, so the caller falls back to the measured angle', () => {
    const parallelSketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'pC', x: 0, y: 5, construction: false },
        { kind: 'point', id: 'pD', x: 10, y: 5, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
        { kind: 'line', id: 'lCD', p1Id: 'pC', p2Id: 'pD', construction: false },
      ],
      constraints: [],
    };
    expect(angleForCursorSector(parallelSketch, 'lAB', 'lCD', { x: 5, y: 2 })).toBeNull();
  });
});

describe('buildDimensionFromSelection commits the supplementary angle a sector picks', () => {
  it('commits the sector-picked value (not the fixed acute measured angle) as the dimension degrees', () => {
    const dimension = buildDimensionFromSelection(
      { kind: 'angle', l1Id: 'l1', l2Id: 'l2' },
      'radius',
      'cAngle',
      120,
      { x: 0, y: -8 },
    );
    expect(dimension).toMatchObject({ kind: 'angle', l1Id: 'l1', l2Id: 'l2', degrees: 120 });
  });
});
