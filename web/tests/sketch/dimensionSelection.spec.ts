import { describe, expect, it } from 'vitest';
import { resolveDimensionSelection } from '../../src/engine/sketch/dimensionSelection';
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
