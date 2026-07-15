import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from 'opentype.js';
import type { ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import { textToPolygons } from '../../src/engine/label/textToPolygons';
import { extrudeLabel } from '../../src/engine/label/extrude';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

/** Shoelace signed area; sign encodes the contour winding. */
function signedArea(contour: SimplePolygon): number {
  let sum = 0;
  for (let i = 0; i < contour.length; i++) {
    const [x1, y1] = contour[i];
    const [x2, y2] = contour[(i + 1) % contour.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

describe('textToPolygons', () => {
  it('produces an outline and a hole for the letter o', () => {
    const contours = textToPolygons(font, 'o', 5);
    expect(contours.length).toBe(2);
    const areas = contours.map(signedArea);
    // One contour winds opposite to the other: the letter's hole.
    expect(Math.sign(areas[0])).toBe(-Math.sign(areas[1]));
    const magnitudes = areas.map(Math.abs).sort((a, b) => b - a);
    expect(magnitudes[0]).toBeGreaterThan(magnitudes[1]);
  });

  it('sizes a capital I to the requested cap height', () => {
    const contours = textToPolygons(font, 'I', 6);
    const solid = extrudeLabel(m, contours, 1);
    const box = solid.boundingBox();
    expect(box.max[1] - box.min[1]).toBeCloseTo(6, 1);
    expect(box.max[2] - box.min[2]).toBeCloseTo(1, 6);
    solid.delete();
  });

  it('extrudes the letter o to a watertight solid of genus 1', () => {
    const contours = textToPolygons(font, 'o', 5);
    const solid = extrudeLabel(m, contours, 0.6);
    expect(solid.status()).toBe('NoError');
    expect(solid.isEmpty()).toBe(false);
    expect(solid.genus()).toBe(1);
    solid.delete();
  });

  it('keeps the holes of a multi-hole glyph like 8', () => {
    // Glyph outlines are designed for the non-zero fill rule; an 8 may be
    // drawn from overlapping contours that even-odd filling would cancel.
    const contours = textToPolygons(font, '8', 5);
    const solid = extrudeLabel(m, contours, 0.6, 'NonZero');
    expect(solid.genus()).toBe(2);
    solid.delete();
  });

  it('rejects a non-positive size', () => {
    expect(() => textToPolygons(font, 'A', 0)).toThrow(/size/i);
  });
});
