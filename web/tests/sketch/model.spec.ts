import { describe, expect, it } from 'vitest';
import {
  SKETCH_SCHEMA_VERSION,
  arcFromThreePoints,
  arcTangentToPoint,
  cloneSketch,
  deserializeSketch,
  validateSketch,
  type Sketch,
} from '../../src/engine/sketch/model';

/** A valid dimensioned unit square sketch used across the model tests. */
export function squareSketch(): Sketch {
  return {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
      { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
      { kind: 'point', id: 'pC', x: 10, y: 10, construction: false },
      { kind: 'point', id: 'pD', x: 0, y: 10, construction: false },
      { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
      { kind: 'line', id: 'lBC', p1Id: 'pB', p2Id: 'pC', construction: false },
      { kind: 'line', id: 'lCD', p1Id: 'pC', p2Id: 'pD', construction: false },
      { kind: 'line', id: 'lDA', p1Id: 'pD', p2Id: 'pA', construction: false },
    ],
    constraints: [
      { kind: 'horizontal', id: 'c1', lineId: 'lAB' },
      { kind: 'vertical', id: 'c2', lineId: 'lBC' },
      { kind: 'length', id: 'c3', lineId: 'lAB', mm: 10 },
      { kind: 'length', id: 'c4', lineId: 'lBC', mm: 10 },
    ],
  };
}

describe('validateSketch', () => {
  it('accepts a valid sketch', () => {
    expect(validateSketch(squareSketch(), 'sketch')).toBeNull();
  });

  it('rejects a duplicate entity id with a user-worded message', () => {
    const sketch = squareSketch();
    sketch.entities.push({ kind: 'point', id: 'pA', x: 1, y: 1, construction: false });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The sketch id pA appears twice.',
    );
  });

  it('rejects a line whose endpoint is not a point', () => {
    const sketch = squareSketch();
    sketch.entities.push({ kind: 'line', id: 'lX', p1Id: 'lAB', p2Id: 'pA', construction: false });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The line lX must connect two sketch points.',
    );
  });

  it('rejects a constraint referring to a missing entity', () => {
    const sketch = squareSketch();
    sketch.constraints.push({ kind: 'horizontal', id: 'cX', lineId: 'nope' });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The constraint cX refers to geometry that is not in the sketch.',
    );
  });

  it('rejects a tangent constraint between two lines', () => {
    const sketch = squareSketch();
    sketch.constraints.push({ kind: 'tangent', id: 'cT', aId: 'lAB', bId: 'lBC' });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The tangent constraint cT needs an arc or circle on at least one side.',
    );
  });

  it('rejects a non-positive dimension', () => {
    const sketch = squareSketch();
    sketch.constraints.push({ kind: 'radius', id: 'cR', entityId: 'lAB', mm: -1 });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The radius constraint cR needs an arc or a circle.',
    );
  });

  it('rejects an unknown schema version', () => {
    const sketch = { ...squareSketch(), schemaVersion: 999 };
    expect(validateSketch(sketch, 'sketch')).toBe(
      `sketch: The sketch has schema version 999, but this app reads version ${SKETCH_SCHEMA_VERSION}.`,
    );
  });
});

describe('deserializeSketch', () => {
  it('round-trips through JSON', () => {
    const original = squareSketch();
    const result = deserializeSketch(JSON.parse(JSON.stringify(original)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sketch).toEqual(original);
  });

  it('returns the validation message for a broken value', () => {
    const result = deserializeSketch({ schemaVersion: SKETCH_SCHEMA_VERSION });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('sketch: The entities must be a list.');
  });
});

describe('cloneSketch', () => {
  it('produces an equal sketch sharing no objects', () => {
    const original = squareSketch();
    const copy = cloneSketch(original);
    expect(copy).toEqual(original);
    expect(copy.entities[0]).not.toBe(original.entities[0]);
    expect(copy.constraints[0]).not.toBe(original.constraints[0]);
  });
});

describe('arcFromThreePoints', () => {
  it('finds the circumcenter and orientation of a counterclockwise arc', () => {
    const arc = arcFromThreePoints({ x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 });
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 9);
    expect(arc!.center.y).toBeCloseTo(0, 9);
    expect(arc!.ccw).toBe(false);
  });

  it('reports clockwise for the mirrored point order', () => {
    const arc = arcFromThreePoints({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 });
    expect(arc!.ccw).toBe(true);
  });

  it('returns null for collinear points', () => {
    expect(arcFromThreePoints({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toBeNull();
  });
});

describe('arcTangentToPoint', () => {
  it('finds a center equidistant from start and end for a horizontal tangent', () => {
    const result = arcTangentToPoint({ x: 0, y: 0 }, { ux: 1, uy: 0 }, { x: 1, y: 1 });
    expect(result).not.toBeNull();
    expect(result!.center.x).toBeCloseTo(0, 9);
    expect(result!.center.y).toBeCloseTo(1, 9);
  });

  it('finds a center equidistant from start and end with a perpendicular tangent direction', () => {
    const start = { x: 0, y: 0 };
    const tangentDir = { ux: 0, uy: 1 };
    const end = { x: 3, y: 4 };
    const result = arcTangentToPoint(start, tangentDir, end);
    expect(result).not.toBeNull();
    const { center } = result!;
    const distStart = Math.hypot(center.x - start.x, center.y - start.y);
    const distEnd = Math.hypot(center.x - end.x, center.y - end.y);
    expect(distStart).toBeCloseTo(distEnd, 9);
    const cx = center.x - start.x;
    const cy = center.y - start.y;
    const dot = cx * tangentDir.ux + cy * tangentDir.uy;
    expect(dot).toBeCloseTo(0, 9);
  });
});
