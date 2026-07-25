import { describe, expect, it } from 'vitest';
import { formatMm, formatDegrees, parseDimensionValue } from '../../src/engine/sketch/measure';

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
