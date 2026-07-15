import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';

/** The polygon fill rules the label pipeline uses. */
export type LabelFillRule = 'EvenOdd' | 'NonZero';

/**
 * Extrude flat polygon contours into a solid of the given depth, spanning
 * z = 0 to depthMm. The default even-odd fill subtracts icon cut-outs
 * regardless of contour winding; font outlines instead use the non-zero rule
 * they are designed for, because glyphs may be drawn from overlapping
 * contours (a TrueType 8 can be two overlapping rings).
 */
export function extrudeLabel(
  m: ManifoldToplevel,
  polygons: SimplePolygon[],
  depthMm: number,
  fillRule: LabelFillRule = 'EvenOdd',
): Manifold {
  if (!(depthMm > 0)) {
    throw new Error(`Extrusion depth must be positive, got ${depthMm}`);
  }
  if (polygons.length === 0) {
    throw new Error('There are no contours to extrude.');
  }
  const section = new m.CrossSection(polygons, fillRule);
  try {
    const solid = section.extrude(depthMm);
    if (solid.status() !== 'NoError') {
      throw new Error(`Label extrusion produced an invalid solid: ${solid.status()}`);
    }
    return solid;
  } finally {
    section.delete();
  }
}
