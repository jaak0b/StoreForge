import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { svgPathToPolygons } from '../../src/engine/label/svgPath';
import { extrudeLabel } from '../../src/engine/label/extrude';
import { LABEL_ICONS, iconByName } from '../../src/engine/label/icons';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

function bounds(contours: SimplePolygon[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
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
  return { minX, maxX, minY, maxY };
}

describe('svgPathToPolygons', () => {
  it('parses absolute and relative line commands into a closed contour', () => {
    const contours = svgPathToPolygons('M1 1L5 1l0 4h-4Z');
    expect(contours.length).toBe(1);
    const box = bounds(contours);
    expect(box.minX).toBeCloseTo(1, 9);
    expect(box.maxX).toBeCloseTo(5, 9);
    expect(box.minY).toBeCloseTo(1, 9);
    expect(box.maxY).toBeCloseTo(5, 9);
  });

  it('flattens a relative arc pair into a circle of the right size', () => {
    // A 10-unit-diameter circle centred at (12, 12), drawn as two arcs.
    const contours = svgPathToPolygons('M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10Z', 0.005);
    expect(contours.length).toBe(1);
    const box = bounds(contours);
    expect(box.maxX - box.minX).toBeCloseTo(10, 2);
    expect(box.maxY - box.minY).toBeCloseTo(10, 2);
    // Every point sits on the circle within the chord tolerance.
    for (const [x, y] of contours[0]) {
      expect(Math.hypot(x - 12, y - 12)).toBeCloseTo(5, 2);
    }
  });

  it('parses the washer icon (arcs, holes, closepath) into an annulus', () => {
    const icon = iconByName('washer');
    const contours = svgPathToPolygons(icon.path);
    expect(contours.length).toBe(2);
    const solid = extrudeLabel(m, contours, 1);
    expect(solid.status()).toBe('NoError');
    expect(solid.genus()).toBe(1);
    solid.delete();
  });

  it('parses every bundled icon into a valid extrudable solid', () => {
    for (const icon of LABEL_ICONS) {
      const contours = svgPathToPolygons(icon.path);
      expect(contours.length).toBeGreaterThan(0);
      const solid = extrudeLabel(m, contours, 1);
      expect(solid.status()).toBe('NoError');
      expect(solid.isEmpty()).toBe(false);
      solid.delete();
    }
  });

  it('rejects malformed path data', () => {
    expect(() => svgPathToPolygons('12 34')).toThrow(/command/i);
    expect(() => svgPathToPolygons('M1 1L')).toThrow(/number/i);
  });
});
