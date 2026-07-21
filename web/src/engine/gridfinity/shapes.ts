import type { Manifold, ManifoldToplevel, SimplePolygon, Vec3 } from 'manifold-3d';
import { CORNER_SEGMENTS, OUTER_CORNER_RADIUS } from './constants';

/**
 * Counter-clockwise polygon approximating a rectangle of the given outer size,
 * centred on the origin, with quarter-circle corner arcs of radius r.
 * A radius of zero or below, or zero segments, yields the sharp-cornered
 * rectangle (one vertex per corner); loftChain relies on this when a caller
 * asks for sharp sections, where its `cornerRadius - inset` goes negative.
 */
export function roundedRectPolygon(
  width: number,
  depth: number,
  r: number,
  segments: number = CORNER_SEGMENTS,
): SimplePolygon {
  const hx = width / 2;
  const hy = depth / 2;
  const radius = Math.min(Math.max(r, 0), hx, hy);
  if (radius <= 0 || segments <= 0) {
    return [
      [hx, hy],
      [-hx, hy],
      [-hx, -hy],
      [hx, -hy],
    ];
  }
  const points: SimplePolygon = [];
  // Corner arc centres, in CCW order starting from the +X/+Y corner.
  const corners: Array<[number, number, number]> = [
    [hx - radius, hy - radius, 0],
    [-(hx - radius), hy - radius, Math.PI / 2],
    [-(hx - radius), -(hy - radius), Math.PI],
    [hx - radius, -(hy - radius), (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = start + (i / segments) * (Math.PI / 2);
      points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
  }
  return points;
}

function polygonAtZ(poly: SimplePolygon, z: number): Vec3[] {
  return poly.map(([x, y]) => [x, y, z]);
}

/**
 * Convex loft between two rounded-rectangle sections at different heights,
 * built as the convex hull of both point rings. Both sections are convex, so
 * the hull is the exact linear loft; with 45-degree offsets this produces the
 * chamfered segments of the stacking foot profile.
 */
export function hullBetween(
  m: ManifoldToplevel,
  bottom: SimplePolygon,
  zBottom: number,
  top: SimplePolygon,
  zTop: number,
): Manifold {
  return m.Manifold.hull([...polygonAtZ(bottom, zBottom), ...polygonAtZ(top, zTop)]);
}

/**
 * Inset a convex polygon by the given distance (rounded corners shrink
 * naturally, collapsing to sharp corners when the inset exceeds their radius).
 * Returns null when the inset consumes the whole polygon (the section closes
 * completely), so callers can keep that part of the shape solid.
 */
export function insetPolygon(
  m: ManifoldToplevel,
  poly: SimplePolygon,
  inset: number,
): SimplePolygon | null {
  const section = new m.CrossSection([poly], 'NonZero');
  try {
    const shrunk = section.offset(-inset, 'Round');
    try {
      const polygons = shrunk.toPolygons();
      if (polygons.length === 0) return null;
      if (polygons.length !== 1) {
        throw new Error(`Insetting a polygon by ${inset} mm did not leave one contour.`);
      }
      return polygons[0];
    } finally {
      shrunk.delete();
    }
  } finally {
    section.delete();
  }
}

/**
 * Chained convex loft: the union of hullBetween prisms over consecutive
 * sections, each section a rounded rectangle inset from the outline of the
 * given outer size by `inset` at height `z`. Sections with equal insets
 * produce plain vertical bands; differing insets produce 45-degree (or
 * arc-sampled) transitions.
 */
export function loftChain(
  m: ManifoldToplevel,
  outerWidth: number,
  outerDepth: number,
  sections: Array<{ inset: number; z: number }>,
  cornerRadius = OUTER_CORNER_RADIUS,
  segments = CORNER_SEGMENTS,
): Manifold {
  const polys = sections.map(({ inset }) =>
    roundedRectPolygon(
      outerWidth - 2 * inset,
      outerDepth - 2 * inset,
      cornerRadius - inset,
      segments,
    ),
  );
  const parts: Manifold[] = [];
  for (let i = 0; i + 1 < sections.length; i++) {
    parts.push(hullBetween(m, polys[i], sections[i].z, polys[i + 1], sections[i + 1].z));
  }
  return m.Manifold.union(parts);
}
