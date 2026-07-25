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
