import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { normalizeCustomIcon } from '../../src/engine/label/customIcon';
import { svgPathToPolygons } from '../../src/engine/label/svgPath';
import { extrudeLabel } from '../../src/engine/label/extrude';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

function bounds(contours: SimplePolygon[]): Box {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Total absolute area of a set of contours (shoelace), for area comparisons. */
function totalArea(contours: SimplePolygon[]): number {
  let sum = 0;
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const [x1, y1] = contour[i];
      const [x2, y2] = contour[(i + 1) % contour.length];
      sum += x1 * y2 - x2 * y1;
    }
  }
  return Math.abs(sum) / 2;
}

/** Extrude a normalized icon path and return its manifold status and volume. */
function extrudeStatus(path: string): { status: string; volume: number } {
  const solid = extrudeLabel(m, svgPathToPolygons(path), 2, 'EvenOdd');
  try {
    return { status: solid.status(), volume: solid.volume() };
  } finally {
    solid.delete();
  }
}

describe('normalizeCustomIcon', () => {
  it('validates the stroke-only calculator icon into one watertight silhouette', () => {
    const svg = readFileSync(new URL('../fixtures/calculator.svg', import.meta.url), 'utf-8');
    const result = normalizeCustomIcon(m, svg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const contours = svgPathToPolygons(result.path);
    // The rect frame, three lines and seven dots merge into a connected
    // silhouette: several contours (the frame has an inner hole), all nonzero.
    expect(contours.length).toBeGreaterThanOrEqual(1);
    const box = bounds(contours);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    // The rect spans x 4..20 with a stroke-width 2 stroke, so the silhouette
    // reaches out to roughly x 3..21; a plausible, nonzero footprint.
    expect(totalArea(contours)).toBeGreaterThan(10);

    const { status, volume } = extrudeStatus(result.path);
    expect(status).toBe('NoError');
    expect(volume).toBeGreaterThan(0);
  });

  it('accepts bare path data and returns a closed filled path', () => {
    const result = normalizeCustomIcon(m, 'M10 10L90 10L90 90L10 90Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(totalArea(svgPathToPolygons(result.path))).toBeCloseTo(6400, -1);
    expect(extrudeStatus(result.path).status).toBe('NoError');
  });

  it('unions overlapping filled shapes instead of cancelling them (not even-odd)', () => {
    // Two identical filled squares. Even-odd would cancel the overlap to
    // nothing; a boolean union keeps one square.
    const svg =
      '<svg><rect x="0" y="0" width="10" height="10" fill="black"/>' +
      '<rect x="0" y="0" width="10" height="10" fill="black"/></svg>';
    const result = normalizeCustomIcon(m, svg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(totalArea(svgPathToPolygons(result.path))).toBeCloseTo(100, 1);
  });

  it('unions partly overlapping filled shapes to their combined area', () => {
    const svg =
      '<svg><rect x="0" y="0" width="10" height="10" fill="black"/>' +
      '<rect x="5" y="0" width="10" height="10" fill="black"/></svg>';
    const result = normalizeCustomIcon(m, svg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Union of two 10x10 squares overlapping by 5x10 is 150, not 200.
    expect(totalArea(svgPathToPolygons(result.path))).toBeCloseTo(150, 1);
    expect(bounds(svgPathToPolygons(result.path)).width).toBeCloseTo(15, 1);
  });

  it('converts a filled circle primitive to its disk area', () => {
    const result = normalizeCustomIcon(m, '<svg><circle cx="12" cy="12" r="5" fill="black"/></svg>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(totalArea(svgPathToPolygons(result.path))).toBeCloseTo(Math.PI * 25, 0);
  });

  it('flattens a transform onto a primitive', () => {
    const plain = normalizeCustomIcon(
      m,
      '<svg><rect x="0" y="0" width="10" height="10" fill="black"/></svg>',
    );
    const moved = normalizeCustomIcon(
      m,
      '<svg><rect x="0" y="0" width="10" height="10" fill="black" transform="translate(20,30)"/></svg>',
    );
    expect(plain.ok && moved.ok).toBe(true);
    if (!plain.ok || !moved.ok) return;
    expect(plain.viewBox[0]).toBeCloseTo(0, 3);
    expect(plain.viewBox[1]).toBeCloseTo(0, 3);
    expect(moved.viewBox[0]).toBeCloseTo(20, 3);
    expect(moved.viewBox[1]).toBeCloseTo(30, 3);
    expect(moved.viewBox[2]).toBeCloseTo(10, 3);
  });

  it('expands a stroked line to a capsule the stroke width across', () => {
    const strokeWidth = 4;
    const length = 10;
    const svg =
      `<svg stroke-width="${strokeWidth}"><line x1="0" y1="0" x2="${length}" y2="0" ` +
      'stroke="black"/></svg>';
    const result = normalizeCustomIcon(m, svg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const box = bounds(svgPathToPolygons(result.path));
    // Round caps add half the stroke width at each end: length + strokeWidth by
    // strokeWidth, within the curve flattening tolerance of the round caps.
    expect(box.width).toBeCloseTo(length + strokeWidth, 1);
    expect(box.height).toBeCloseTo(strokeWidth, 1);
    expect(extrudeStatus(result.path).status).toBe('NoError');
  });

  it('inherits stroke-width from the root svg element', () => {
    const svg = '<svg stroke="black" stroke-width="2"><line x1="0" y1="0" x2="6" y2="0"/></svg>';
    const result = normalizeCustomIcon(m, svg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(bounds(svgPathToPolygons(result.path)).height).toBeCloseTo(2, 1);
  });

  it('rejects empty input', () => {
    expect(normalizeCustomIcon(m, '   ')).toEqual({
      ok: false,
      error: 'No path data found in this file.',
    });
  });

  it('rejects a document with no drawable shape', () => {
    const result = normalizeCustomIcon(m, '<svg><g></g></svg>');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no drawable shape');
  });

  it('rejects a shape that encloses no area', () => {
    const result = normalizeCustomIcon(m, '<svg><rect x="0" y="0" width="0" height="10" fill="black"/></svg>');
    expect(result.ok).toBe(false);
  });
});
