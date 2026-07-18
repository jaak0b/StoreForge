// Editing operations on traced tool outlines: rigid transforms, clearance
// offsetting, primitive outlines, and the canonical resolve pipeline the
// pocket generator consumes. Pure math except where CSG is genuinely needed
// (clearance uses manifold's CrossSection offset), with the ManifoldToplevel
// injected so the WASM stays out of the main bundle.
import type { ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import type { FingerHole, MmPoint, TracedOutline, TracedTool } from './types';

/**
 * Maximum chordal deviation in mm when a circle or arc is flattened to
 * segments. 0.1 mm: well under the 0.25 mm rectified-pixel size and the
 * 0.2 mm contour simplification tolerance, so flattening never costs more
 * accuracy than the trace already did, while keeping vertex counts small.
 */
export const CHORDAL_TOLERANCE_MM = 0.1;

/** Floor on segments per full circle so tiny radii still look round. */
const MIN_CIRCLE_SEGMENTS = 12;

/**
 * Signed shoelace area of a closed polygon. In outline convention (see
 * TracedOutline) outers are positive and holes negative. The single home for
 * this figure; other trace modules import it from here.
 */
export function signedArea(points: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Axis-aligned bounds of an outline (its outer loop; holes lie inside it). */
export interface OutlineBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** Axis-aligned bounding box of the outline's outer loop. */
export function boundsOf(outline: TracedOutline): OutlineBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of outline.outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Area centroid of a simple polygon; falls back to the vertex mean for degenerate area. */
function centroidOf(points: MmPoint[]): MmPoint {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / points.length, y: sy / points.length };
  }
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

/**
 * Rigid transform of an outline: optional mirror across the vertical axis
 * through the outer loop's area centroid, then rotation by rotationDeg
 * counterclockwise about the same centroid. Mirroring reverses each loop's
 * point order so the winding convention (outer positive, holes negative)
 * stays valid. Pure math, no CSG.
 */
export function transformTool(
  outline: TracedOutline,
  rotationDeg: number,
  mirrored: boolean,
): TracedOutline {
  if (rotationDeg === 0 && !mirrored) {
    // Identity short-circuit: avoids rounding the coordinates through the
    // centroid arithmetic when nothing changes.
    return {
      outer: outline.outer.map((p) => ({ ...p })),
      holes: outline.holes.map((loop) => loop.map((p) => ({ ...p }))),
    };
  }
  const c = centroidOf(outline.outer);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mapLoop = (loop: MmPoint[]): MmPoint[] => {
    const points = loop.map((p) => {
      const x = mirrored ? 2 * c.x - p.x : p.x;
      const dx = x - c.x;
      const dy = p.y - c.y;
      return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
    });
    if (mirrored) {
      points.reverse();
    }
    return points;
  };
  return { outer: mapLoop(outline.outer), holes: outline.holes.map(mapLoop) };
}

/**
 * Segments for a full circle of the given radius under CHORDAL_TOLERANCE_MM,
 * rounded up to a multiple of 4 so the four axis extremes land on vertices
 * and primitive bounds are exactly the requested dimensions.
 */
function circleSegments(radiusMm: number): number {
  let n = MIN_CIRCLE_SEGMENTS;
  if (radiusMm > CHORDAL_TOLERANCE_MM) {
    const step = 2 * Math.acos(1 - CHORDAL_TOLERANCE_MM / radiusMm);
    n = Math.max(MIN_CIRCLE_SEGMENTS, Math.ceil((2 * Math.PI) / step));
  }
  return Math.ceil(n / 4) * 4;
}

/**
 * Grow the outline outward by offsetMm with rounded joins, holes shrinking by
 * the same amount. The outline is offset as one composed cross-section
 * (outer plus holes, EvenOdd fill): manifold offsets the filled region, so
 * the outer boundary moves outward and hole boundaries move inward together,
 * and holes that collapse below 2 * offsetMm disappear, exactly the behavior
 * a clearance wants. Verified by the edit test suite. offsetMm 0 returns a
 * plain copy without touching the WASM.
 */
export function applyClearance(
  m: ManifoldToplevel,
  outline: TracedOutline,
  offsetMm: number,
): TracedOutline {
  if (offsetMm < 0) {
    throw new RangeError(`clearance offset must be >= 0, got ${offsetMm}`);
  }
  if (offsetMm === 0) {
    return {
      outer: outline.outer.map((p) => ({ ...p })),
      holes: outline.holes.map((loop) => loop.map((p) => ({ ...p }))),
    };
  }
  const loops: SimplePolygon[] = [outline.outer, ...outline.holes].map((loop) =>
    loop.map((p) => [p.x, p.y] as [number, number]),
  );
  const section = new m.CrossSection(loops, 'EvenOdd');
  try {
    const grown = section.offset(offsetMm, 'Round', undefined, circleSegments(offsetMm));
    try {
      let outer: MmPoint[] | null = null;
      let outerArea = 0;
      const holes: MmPoint[][] = [];
      for (const loop of grown.toPolygons()) {
        const points = loop.map(([x, y]) => ({ x, y }));
        const area = signedArea(points);
        if (area > 0) {
          if (outer !== null) {
            // A traced outline is one connected silhouette; growing it
            // outward cannot split it, so a second outer is an invariant
            // violation worth failing loudly on.
            throw new Error('clearance offset produced more than one outer loop');
          }
          outer = points;
          outerArea = area;
        } else {
          holes.push(points);
        }
      }
      if (outer === null || outerArea === 0) {
        throw new Error('clearance offset produced no outer loop');
      }
      return { outer, holes };
    } finally {
      grown.delete();
    }
  } finally {
    section.delete();
  }
}

/** Circle outline of the given diameter, positively wound, centered at (cx, cy). */
function circleOutline(cx: number, cy: number, diameterMm: number): TracedOutline {
  const r = diameterMm / 2;
  const n = circleSegments(r);
  const outer: MmPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const angle = (2 * Math.PI * i) / n;
    outer.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return { outer, holes: [] };
}

/** Parameters for primitiveOutline('circle', ...). */
export interface CirclePrimitiveParams {
  diameterMm: number;
}

/** Parameters for primitiveOutline('rectangle', ...). */
export interface RectanglePrimitiveParams {
  widthMm: number;
  heightMm: number;
  cornerRadiusMm?: number;
}

/**
 * A tool outline built from a primitive instead of a photo trace, centered on
 * the tool-local origin. Circles and arcs are flattened under
 * CHORDAL_TOLERANCE_MM.
 */
export function primitiveOutline(kind: 'circle', params: CirclePrimitiveParams): TracedOutline;
export function primitiveOutline(
  kind: 'rectangle',
  params: RectanglePrimitiveParams,
): TracedOutline;
export function primitiveOutline(
  kind: 'circle' | 'rectangle',
  params: CirclePrimitiveParams | RectanglePrimitiveParams,
): TracedOutline {
  if (kind === 'circle') {
    const { diameterMm } = params as CirclePrimitiveParams;
    if (diameterMm <= 0) {
      throw new RangeError(`circle diameter must be > 0, got ${diameterMm}`);
    }
    return circleOutline(0, 0, diameterMm);
  }
  const { widthMm, heightMm } = params as RectanglePrimitiveParams;
  if (widthMm <= 0 || heightMm <= 0) {
    throw new RangeError(`rectangle sides must be > 0, got ${widthMm} x ${heightMm}`);
  }
  const r = Math.min((params as RectanglePrimitiveParams).cornerRadiusMm ?? 0, widthMm / 2, heightMm / 2);
  const hw = widthMm / 2;
  const hh = heightMm / 2;
  if (r <= 0) {
    return {
      outer: [
        { x: hw, y: hh },
        { x: -hw, y: hh },
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
      ],
      holes: [],
    };
  }
  // Four quarter arcs joined by the straight edges between their tangent
  // points; arc endpoints land exactly on the tangent points, so the bounds
  // stay exactly widthMm by heightMm.
  const arcSteps = Math.max(1, Math.ceil(circleSegments(r) / 4));
  const outer: MmPoint[] = [];
  const corners: Array<{ cx: number; cy: number; startDeg: number }> = [
    { cx: hw - r, cy: hh - r, startDeg: 0 },
    { cx: -(hw - r), cy: hh - r, startDeg: 90 },
    { cx: -(hw - r), cy: -(hh - r), startDeg: 180 },
    { cx: hw - r, cy: -(hh - r), startDeg: 270 },
  ];
  for (const corner of corners) {
    for (let k = 0; k <= arcSteps; k += 1) {
      const angle = ((corner.startDeg + (90 * k) / arcSteps) * Math.PI) / 180;
      const x = corner.cx + r * Math.cos(angle);
      const y = corner.cy + r * Math.sin(angle);
      const last = outer[outer.length - 1];
      if (!last || Math.abs(last.x - x) > 1e-9 || Math.abs(last.y - y) > 1e-9) {
        outer.push({ x, y });
      }
    }
  }
  const first = outer[0];
  const last = outer[outer.length - 1];
  if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
    outer.pop();
  }
  return { outer, holes: [] };
}

/**
 * Outline for a finger-hole cutout in the hole's tool-local frame, flattened
 * under the same chordal rule as the primitives. A hole without a second
 * endpoint (or with both endpoints equal) is a circle; otherwise the outline
 * is a capsule (slot): a semicircle cap at each endpoint joined by the two
 * tangent lines, so the bounds span the endpoint distance plus one diameter
 * along the slot and exactly one diameter across it. The pocket generator
 * subtracts this from the pocket floor.
 */
export function fingerHoleOutline(hole: FingerHole): TracedOutline {
  if (hole.diameterMm <= 0) {
    throw new RangeError(`finger hole diameter must be > 0, got ${hole.diameterMm}`);
  }
  const x2 = hole.x2 ?? hole.x;
  const y2 = hole.y2 ?? hole.y;
  const dx = x2 - hole.x;
  const dy = y2 - hole.y;
  if (Math.hypot(dx, dy) < 1e-9) {
    return circleOutline(hole.x, hole.y, hole.diameterMm);
  }
  const r = hole.diameterMm / 2;
  const theta = Math.atan2(dy, dx);
  // Half a full circle's segments per cap keeps the chordal rule intact.
  const capSteps = circleSegments(r) / 2;
  const outer: MmPoint[] = [];
  const cap = (cx: number, cy: number, startAngle: number): void => {
    for (let k = 0; k <= capSteps; k += 1) {
      const angle = startAngle + (Math.PI * k) / capSteps;
      outer.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  };
  // Counterclockwise traversal (positive shoelace area, the outer-loop
  // convention): the cap around the second endpoint from theta - 90 degrees
  // to theta + 90 degrees, then the cap around the first endpoint over the
  // opposite half; the tangent lines are the implicit edges between the caps.
  cap(x2, y2, theta - Math.PI / 2);
  cap(hole.x, hole.y, theta + Math.PI / 2);
  return { outer, holes: [] };
}

/**
 * The canonical editing pipeline (see TracedTool in types.ts): mirror, then
 * rotate, then clearance. Returns the pocket-ready outline in tool-local mm.
 * Finger holes are not applied here; the pocket generator cuts them
 * separately.
 */
export function resolvedToolOutline(m: ManifoldToplevel, tool: TracedTool): TracedOutline {
  const placed = transformTool(tool.outline, tool.rotationDeg, tool.mirrored);
  return applyClearance(m, placed, tool.offsetMm);
}
