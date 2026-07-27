import { describe, expect, it } from 'vitest';
import {
  defaultAngleSector,
  dimensionGraphics,
  resolveAngleSector,
} from '../../src/engine/sketch/dimensionGraphics';
import { SKETCH_SCHEMA_VERSION, type AngleDimension, type Sketch } from '../../src/engine/sketch/model';

/**
 * The owner's reported case: two segments meeting at a shared vertex forming
 * a 140 degree interior corner. line2 deliberately stores the shared vertex
 * as its SECOND point (p2Id), the flipped order that made the old direct-
 * fold-based sector pick read 40 (the adjacent sector sharing line2's own
 * ray) instead of the corner's actual 140.
 */
function cornerSketch(): Sketch {
  const farAngleDeg = 140;
  const far2 = {
    x: 10 * Math.cos((farAngleDeg * Math.PI) / 180),
    y: 10 * Math.sin((farAngleDeg * Math.PI) / 180),
  };
  return {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      { kind: 'point', id: 'pV', x: 0, y: 0, construction: false },
      { kind: 'point', id: 'pA', x: 10, y: 0, construction: false },
      { kind: 'point', id: 'pB', x: far2.x, y: far2.y, construction: false },
      { kind: 'line', id: 'l1', p1Id: 'pV', p2Id: 'pA', construction: false },
      // l2's point order stores the shared vertex second, not first.
      { kind: 'line', id: 'l2', p1Id: 'pB', p2Id: 'pV', construction: false },
    ],
    constraints: [],
  };
}

describe('defaultAngleSector', () => {
  it('seeds the corner angle (140), not the adjacent sector (40), regardless of point order', () => {
    const sketch = cornerSketch();
    const result = defaultAngleSector(sketch, 'l1', 'l2');
    expect(result?.degrees).toBeCloseTo(140, 5);
  });

  it('returns null when the lines share no vertex', () => {
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
    expect(defaultAngleSector(sketch, 'lAB', 'lCD')).toBeNull();
  });
});

describe('resolveAngleSector (shared-vertex default vs. deliberate cursor pick)', () => {
  it('seeds the corner angle when the cursor sits on the just-selected line (the ambiguous case)', () => {
    const sketch = cornerSketch();
    // A point partway along l2's own segment, from vertex toward pB: this is
    // exactly where a selection click on l2 would land, sitting right on the
    // ray boundary between the 140 corner sector and its 40 neighbor.
    const cursorOnLine2 = { x: 5 * Math.cos((140 * Math.PI) / 180), y: 5 * Math.sin((140 * Math.PI) / 180) };
    const result = resolveAngleSector(sketch, 'l1', 'l2', cursorOnLine2);
    expect(result.degrees).toBeCloseTo(140, 5);
  });

  it('still lets a cursor clearly inside a different sector pick that sector', () => {
    const sketch = cornerSketch();
    // 160 degrees: well inside the [140, 180] sector (the 40 degree one),
    // more than the snap band away from both of the lines' own rays (0, 140).
    const rad = (160 * Math.PI) / 180;
    const cursor = { x: 10 * Math.cos(rad), y: 10 * Math.sin(rad) };
    const result = resolveAngleSector(sketch, 'l1', 'l2', cursor);
    expect(result.degrees).toBeCloseTo(40, 5);
  });
});

describe('dimensionGraphics angle arc: witness extensions beyond a segment\'s extent', () => {
  it('draws no witness lines when the label sits within both segments\' extent', () => {
    const sketch = cornerSketch();
    const dimension: AngleDimension = {
      kind: 'angle', id: 'cA', l1Id: 'l1', l2Id: 'l2', degrees: 140,
    };
    // labelAt at radius 5 from the vertex, well inside both 10mm segments.
    const labelAt = { x: 5 * Math.cos((70 * Math.PI) / 180), y: 5 * Math.sin((70 * Math.PI) / 180) };
    const graphics = dimensionGraphics(sketch, dimension, labelAt, '140');
    if (graphics === null || graphics.kind !== 'angle') throw new Error('expected angle graphics');
    expect(graphics.witnessLines).toHaveLength(0);
  });

  it('draws a witness extension from each segment\'s far endpoint when the arc radius exceeds the segment', () => {
    const sketch = cornerSketch();
    const dimension: AngleDimension = {
      kind: 'angle', id: 'cA', l1Id: 'l1', l2Id: 'l2', degrees: 140,
    };
    // labelAt at radius 20 from the vertex (segments are only 10mm long), on
    // the corner's own bisector so the arc sweeps the 140 degree sector.
    const bisectorDeg = 70;
    const rad = (bisectorDeg * Math.PI) / 180;
    const labelAt = { x: 20 * Math.cos(rad), y: 20 * Math.sin(rad) };
    const graphics = dimensionGraphics(sketch, dimension, labelAt, '140');
    if (graphics === null || graphics.kind !== 'angle') throw new Error('expected angle graphics');
    expect(graphics.witnessLines).toHaveLength(2);
    for (const w of graphics.witnessLines) {
      // Each witness starts at distance 10 from the vertex (the segment's
      // own far endpoint) and ends at distance 20 (the arc's radius).
      expect(Math.hypot(w.a.x, w.a.y)).toBeCloseTo(10, 5);
      expect(Math.hypot(w.b.x, w.b.y)).toBeCloseTo(20, 5);
    }
  });
});
