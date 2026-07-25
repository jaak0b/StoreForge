import { describe, expect, it } from 'vitest';
import {
  formatMm,
  formatDegrees,
  measurePointLineDistance,
  parseDimensionValue,
  updateDrivenDimensions,
} from '../../src/engine/sketch/measure';
import { SKETCH_SCHEMA_VERSION, type Sketch } from '../../src/engine/sketch/model';

describe('formatMm', () => {
  it('rounds to 0.01 mm', () => {
    expect(formatMm(36.58743339531354)).toBeCloseTo(36.59);
    expect(formatMm(10)).toBe(10);
    expect(formatMm(0.001)).toBe(0);
  });
});

describe('formatDegrees', () => {
  it('rounds to 0.1 degree', () => {
    expect(formatDegrees(45.649999)).toBeCloseTo(45.6);
    expect(formatDegrees(90)).toBe(90);
  });
});

describe('measurePointLineDistance', () => {
  it('measures the perpendicular distance to the line\'s infinite extension', () => {
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
    expect(measurePointLineDistance(sketch, 'pP', 'lAB')).toBeCloseTo(5, 9);
  });

  it('measures against the extension beyond the segment endpoints', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'pP', x: 20, y: 3, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
      ],
      constraints: [],
    };
    expect(measurePointLineDistance(sketch, 'pP', 'lAB')).toBeCloseTo(3, 9);
  });
});

describe('updateDrivenDimensions', () => {
  it('overwrites a driven dimension\'s value from the current geometry', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 12, y: 0, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
      ],
      constraints: [{ kind: 'length', id: 'cL', lineId: 'lAB', mm: 999, driven: true }],
    };
    updateDrivenDimensions(sketch);
    const c = sketch.constraints[0];
    expect(c.kind).toBe('length');
    if (c.kind === 'length') expect(c.mm).toBe(12);
  });

  it('refreshes a driven supplementary angle to its own sector, not the direct fold', () => {
    // l1 along 0 deg, l2 along 60 deg: the direct fold (measureAngleBetweenLines)
    // is 60, so a driven dimension placed in the supplementary (120) sector
    // must refresh back to 120, not fold to the acute 60.
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'p1a', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'p1b', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'p2a', x: 0, y: 0, construction: false },
        {
          kind: 'point', id: 'p2b',
          x: 10 * Math.cos(Math.PI / 3), y: 10 * Math.sin(Math.PI / 3), construction: false,
        },
        { kind: 'line', id: 'l1', p1Id: 'p1a', p2Id: 'p1b', construction: false },
        { kind: 'line', id: 'l2', p1Id: 'p2a', p2Id: 'p2b', construction: false },
      ],
      constraints: [
        { kind: 'angle', id: 'cA', l1Id: 'l1', l2Id: 'l2', degrees: 999, supplementary: true, driven: true },
      ],
    };
    updateDrivenDimensions(sketch);
    const c = sketch.constraints[0];
    expect(c.kind).toBe('angle');
    if (c.kind === 'angle') expect(c.degrees).toBeCloseTo(120, 5);
  });

  it('refreshes a driven non-supplementary angle to the direct fold', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'p1a', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'p1b', x: 10, y: 0, construction: false },
        { kind: 'point', id: 'p2a', x: 0, y: 0, construction: false },
        {
          kind: 'point', id: 'p2b',
          x: 10 * Math.cos(Math.PI / 3), y: 10 * Math.sin(Math.PI / 3), construction: false,
        },
        { kind: 'line', id: 'l1', p1Id: 'p1a', p2Id: 'p1b', construction: false },
        { kind: 'line', id: 'l2', p1Id: 'p2a', p2Id: 'p2b', construction: false },
      ],
      constraints: [
        { kind: 'angle', id: 'cA', l1Id: 'l1', l2Id: 'l2', degrees: 999, driven: true },
      ],
    };
    updateDrivenDimensions(sketch);
    const c = sketch.constraints[0];
    expect(c.kind).toBe('angle');
    if (c.kind === 'angle') expect(c.degrees).toBeCloseTo(60, 5);
  });

  it('leaves an ordinary driving dimension untouched', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
        { kind: 'point', id: 'pB', x: 12, y: 0, construction: false },
        { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
      ],
      constraints: [{ kind: 'length', id: 'cL', lineId: 'lAB', mm: 999 }],
    };
    updateDrivenDimensions(sketch);
    const c = sketch.constraints[0];
    expect(c.kind).toBe('length');
    if (c.kind === 'length') expect(c.mm).toBe(999);
  });
});

describe('parseDimensionValue', () => {
  it('accepts a plain positive decimal', () => {
    expect(parseDimensionValue('36.58')).toBe(36.58);
    expect(parseDimensionValue('10')).toBe(10);
  });

  it('accepts a comma decimal separator and surrounding whitespace', () => {
    expect(parseDimensionValue('  36,58  ')).toBe(36.58);
  });

  it('rejects trailing garbage instead of taking a numeric prefix', () => {
    expect(parseDimensionValue('36.58743339531354SS')).toBeNull();
    expect(parseDimensionValue('12abc')).toBeNull();
  });

  it('rejects non-positive, empty, or non-numeric input', () => {
    expect(parseDimensionValue('0')).toBeNull();
    expect(parseDimensionValue('-5')).toBeNull();
    expect(parseDimensionValue('')).toBeNull();
    expect(parseDimensionValue('abc')).toBeNull();
  });
});
