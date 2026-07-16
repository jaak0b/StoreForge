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

  it('extrudes each icon to its expected genus (holes present exactly where designed)', () => {
    const expected: Record<string, number> = {
      'countersunk screw': 0,
      'pan head screw': 0,
      'cap head screw': 0,
      'hex bolt': 0,
      'hex nut': 1,
      washer: 1,
      'threaded insert': 0,
      'self-tapping screw': 0,
      brad: 0,
      dowel: 0,
      'pocket screw': 0,
      cable: 0,
      battery: 0,
      'lego brick': 0,
      resistor: 0,
      'ic chip': 0,
      spring: 0,
      bearing: 1,
      bit: 0,
      adhesive: 0,
      'misc box': 0,
    };
    expect(LABEL_ICONS.map((icon) => icon.name).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, genus] of Object.entries(expected)) {
      const solid = extrudeLabel(m, svgPathToPolygons(iconByName(name).path), 1);
      expect(solid.genus(), name).toBe(genus);
      solid.delete();
    }
  });

  it('keeps every icon inside its viewBox and spanning most of it', () => {
    for (const icon of LABEL_ICONS) {
      const [minX, minY, width, height] = icon.viewBox;
      const box = bounds(svgPathToPolygons(icon.path));
      expect(box.minX, icon.name).toBeGreaterThanOrEqual(minX);
      expect(box.minY, icon.name).toBeGreaterThanOrEqual(minY);
      expect(box.maxX, icon.name).toBeLessThanOrEqual(minX + width);
      expect(box.maxY, icon.name).toBeLessThanOrEqual(minY + height);
      // Consistent visual weight: each silhouette fills the bulk of the box.
      expect(box.maxX - box.minX, icon.name).toBeGreaterThanOrEqual(0.6 * width);
      expect(box.maxY - box.minY, icon.name).toBeGreaterThanOrEqual(0.4 * height);
    }
  });

  it('assigns every icon a picker category, and the new sets land in theirs', () => {
    for (const icon of LABEL_ICONS) {
      expect(['fasteners', 'general'], icon.name).toContain(icon.category);
    }
    const byCategory = (category: string): string[] =>
      LABEL_ICONS.filter((icon) => icon.category === category).map((icon) => icon.name);
    expect(byCategory('fasteners')).toContain('brad');
    expect(byCategory('fasteners')).toContain('dowel');
    expect(byCategory('fasteners')).toContain('pocket screw');
    expect(byCategory('general').sort()).toEqual(
      [
        'cable',
        'battery',
        'lego brick',
        'resistor',
        'ic chip',
        'spring',
        'bearing',
        'bit',
        'adhesive',
        'misc box',
      ].sort(),
    );
  });

  it('rejects malformed path data', () => {
    expect(() => svgPathToPolygons('12 34')).toThrow(/command/i);
    expect(() => svgPathToPolygons('M1 1L')).toThrow(/number/i);
  });
});
