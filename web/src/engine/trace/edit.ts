// Editing operations on traced tool outlines: rigid transforms, clearance
// offsetting, primitive outlines, and the canonical resolve pipeline the
// pocket generator consumes. Pure math except where CSG is genuinely needed
// (clearance uses manifold's CrossSection offset), with the ManifoldToplevel
// injected so the WASM stays out of the main bundle.
import type { ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import type { FingerHole, MmPoint, TracedOutline, TracedTool } from './types';
import { circleSegments } from '../geometry/circleSegments';

/**
 * Maximum chordal deviation in mm when a circle or arc is flattened to
 * segments. 0.1 mm: well under the 0.25 mm rectified-pixel size and the
 * 0.2 mm contour simplification tolerance, so flattening never costs more
 * accuracy than the trace already did, while keeping vertex counts small.
 * This flow's own accuracy policy, spent against the shared circleSegments
 * derivation at every call site below.
 */
export const CHORDAL_TOLERANCE_MM = 0.1;

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

/**
 * Area centroid of a simple polygon; falls back to the vertex mean for
 * degenerate area. The single home for this figure; other modules import it
 * from here.
 */
export function centroidOf(points: MmPoint[]): MmPoint {
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
 * Even-odd ray-cast point-in-polygon test (the standard crossing-number
 * algorithm): a horizontal ray from the point crosses the loop's edges an odd
 * number of times exactly when the point is inside.
 */
export function pointInPolygon(point: MmPoint, loop: MmPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const a = loop[i];
    const b = loop[j];
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
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
    const grown = section.offset(
      offsetMm,
      'Round',
      undefined,
      circleSegments(offsetMm, CHORDAL_TOLERANCE_MM),
    );
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
  const n = circleSegments(r, CHORDAL_TOLERANCE_MM);
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
  const arcSteps = Math.max(1, Math.ceil(circleSegments(r, CHORDAL_TOLERANCE_MM) / 4));
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
  const capSteps = circleSegments(r, CHORDAL_TOLERANCE_MM) / 2;
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
 * Drops the holes named by filledHoleIndices from the outline, leaving the
 * outer loop and the surviving holes copied. A filled hole's island is then
 * cut away in the pocket (the pocket cross-section is an EvenOdd fill of outer
 * plus holes, so a missing hole means no standing island there). Indices out
 * of range are ignored. Pure, no CSG.
 */
export function withoutFilledHoles(
  outline: TracedOutline,
  filledHoleIndices: number[],
): TracedOutline {
  const filled = new Set(filledHoleIndices);
  return {
    outer: outline.outer.map((p) => ({ ...p })),
    holes: outline.holes
      .filter((_, i) => !filled.has(i))
      .map((loop) => loop.map((p) => ({ ...p }))),
  };
}

/**
 * Drops holes whose thinnest width is below minHoleWidthMm, so no thin island
 * is left standing in the pocket. Width is tested by a morphological opening
 * (polygon erosion emptiness test): a hole survives iff eroding its region by
 * minHoleWidthMm / 2 (a CrossSection inward offset with rounded joins) leaves
 * a non-empty region, which holds exactly when the hole is at least
 * minHoleWidthMm across at its narrowest. minHoleWidthMm 0 keeps every hole
 * and returns a plain copy without touching the WASM (mirroring
 * applyClearance's fast path); a negative width is a caller error.
 */
export function cullNarrowHoles(
  m: ManifoldToplevel,
  outline: TracedOutline,
  minHoleWidthMm: number,
): TracedOutline {
  if (minHoleWidthMm < 0) {
    throw new RangeError(`minimum hole width must be >= 0, got ${minHoleWidthMm}`);
  }
  if (minHoleWidthMm === 0) {
    return {
      outer: outline.outer.map((p) => ({ ...p })),
      holes: outline.holes.map((loop) => loop.map((p) => ({ ...p }))),
    };
  }
  const erosion = minHoleWidthMm / 2;
  const kept: MmPoint[][] = [];
  for (const loop of outline.holes) {
    // NonZero fills the hole region regardless of its winding, so the erosion
    // measures the hole's own width rather than the outline's fill.
    const region = new m.CrossSection(
      [loop.map((p) => [p.x, p.y] as [number, number])],
      'NonZero',
    );
    try {
      const eroded = region.offset(
        -erosion,
        'Round',
        undefined,
        circleSegments(erosion, CHORDAL_TOLERANCE_MM),
      );
      try {
        if (!eroded.isEmpty()) {
          kept.push(loop.map((p) => ({ ...p })));
        }
      } finally {
        eroded.delete();
      }
    } finally {
      region.delete();
    }
  }
  return { outer: outline.outer.map((p) => ({ ...p })), holes: kept };
}

/**
 * The index of the topmost hole containing the point, or null when the point
 * is in no hole. Holes are tested back to front so a hole drawn over another
 * wins. Pure point-in-polygon hit test.
 */
export function holeIndexAt(outline: TracedOutline, point: MmPoint): number | null {
  for (let i = outline.holes.length - 1; i >= 0; i -= 1) {
    if (pointInPolygon(point, outline.holes[i])) return i;
  }
  return null;
}

/**
 * The canonical editing pipeline (see TracedTool in types.ts): mirror and
 * rotate, remove the manually filled holes, cull holes narrower than the
 * tool's minimum, then clearance. Returns the pocket-ready outline in
 * tool-local mm. Finger holes are not applied here; the pocket generator cuts
 * them separately.
 */
export function resolvedToolOutline(m: ManifoldToplevel, tool: TracedTool): TracedOutline {
  const placed = transformTool(tool.outline, tool.rotationDeg, tool.mirrored);
  const kept = withoutFilledHoles(placed, tool.filledHoleIndices);
  const culled = cullNarrowHoles(m, kept, tool.minHoleWidthMm);
  return applyClearance(m, culled, tool.offsetMm);
}
