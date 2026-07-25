// Arrangement-based enclosed-region extraction for a sketch's non-construction
// geometry. Where profile.ts only walks curves chained end to end through
// shared points, this module builds a full planar subdivision (arrangement)
// of the curves via analytic pairwise intersections and enumerates its
// bounded faces, so overlapping or crossing geometry (a line through a
// circle, two overlapping circles) still yields pickable regions.
//
// Algorithm, following de Berg, Cheong, van Kreveld, Overmars,
// "Computational Geometry: Algorithms and Applications" (3rd ed.), chapter 2:
//   1. Analytic pairwise intersections (line/line, line/circle-or-arc via the
//      quadratic, circle/circle via the radical line). O(n^2) pairwise is
//      deliberate: sketches carry at most tens of curves, so Bentley-Ottmann's
//      sweep-line machinery buys nothing here and analytic intersections stay
//      exact.
//   2. Epsilon vertex welding via union-find (the tolerance-snap model CGAL's
//      Arrangement_2 uses), see WELD_EPSILON_MM below.
//   3. Each curve is split at its exact intersection parameters, then every
//      sub-curve is flattened at the shared OUTLINE_TOLERANCE_MM; arrangement
//      edges remember their source entity id for UI hit-testing.
//   4. Doubly connected edge list (DCEL) face traversal by most-clockwise
//      outgoing edge from each half-edge's twin (the standard planar-graph
//      face-tracing rule), plus grouping of faces fully contained inside
//      another face's outer boundary (cross-component containment, tested
//      with the leftmost-vertex ray-crossing test) into that face's holes.
//   5. Tangency defense: a near-zero discriminant is one tangent point, and
//      any post-split edge shorter than the epsilon is dropped so tangency
//      cannot produce a zero-length edge or an undefined turn decision.
import type { MmPoint, TracedOutline } from '../trace/types';
import { OUTLINE_TOLERANCE_MM } from '../trace/contour';
import { assertNever } from '../plan/types';
import type { Sketch, SketchEntity, SketchPoint } from './model';

export type RegionsResult = { ok: true; faces: RegionFace[] } | { ok: false; error: string };

/** One bounded, pickable region of the sketch's arrangement. */
export interface RegionFace {
  id: string;
  /** Positively oriented (shoelace area > 0) outer boundary, in mm. */
  outer: MmPoint[];
  /** Negatively oriented inner boundaries (islands fully inside this face). */
  holes: MmPoint[][];
  /** Shoelace area of the outer boundary, in mm^2. */
  areaMm2: number;
  /** Source entity ids contributing an edge to this face's outer boundary or holes. */
  entityIds: string[];
}

const CONSTRUCTION_ONLY =
  'The sketch has only construction geometry. Draw the shape with regular lines, arcs or a circle.';
const NO_REGIONS =
  'The sketch has no enclosed region. Draw lines, arcs or a circle that close off an area.';

/**
 * Welding tolerance for arrangement vertices, in millimeters. 1e-6 mm is far
 * below any feature a 3D printer or CNC can resolve (manufacturable
 * tolerances start around 1e-2 mm) and far above the floating point error
 * double-precision arithmetic accumulates computing an intersection at
 * sketch scale (tens of millimeters, relative error around 1e-13). It merges
 * points that are mathematically the same reached by different formulas
 * (e.g. two curves' intersection computed from each curve's own equation)
 * without ever merging two points the user actually placed apart.
 */
export const WELD_EPSILON_MM = 1e-6;

/** Number of segments flattening an arc of the given radius and sweep. */
export function segmentCount(radiusMm: number, sweepRad: number): number {
  // Sagitta bound: a chord spanning angle t deviates r * (1 - cos(t / 2)),
  // so the largest allowed step is 2 * acos(1 - tolerance / r).
  const ratio = 1 - OUTLINE_TOLERANCE_MM / Math.max(radiusMm, OUTLINE_TOLERANCE_MM);
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, ratio)));
  return Math.max(2, Math.ceil(sweepRad / Math.max(maxStep, 1e-6)));
}

/** Flattened arc points from start toward end, excluding the end point. */
export function flattenArc(
  center: SketchPoint,
  start: SketchPoint,
  end: SketchPoint,
  reversed: boolean,
): MmPoint[] {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let a1 = Math.atan2(end.y - center.y, end.x - center.x);
  if (a1 <= a0) a1 += 2 * Math.PI; // stored arcs run counterclockwise start to end
  const from = reversed ? a1 : a0;
  const to = reversed ? a0 : a1;
  const n = segmentCount(radius, Math.abs(to - from));
  const points: MmPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = from + ((to - from) * i) / n;
    points.push({ x: center.x + radius * Math.cos(t), y: center.y + radius * Math.sin(t) });
  }
  return points;
}

/** Full-circle flattening, counterclockwise, closed implicitly. */
export function flattenCircle(center: SketchPoint, radiusMm: number): MmPoint[] {
  const n = Math.max(8, segmentCount(radiusMm, 2 * Math.PI));
  const points: MmPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = (2 * Math.PI * i) / n;
    points.push({ x: center.x + radiusMm * Math.cos(t), y: center.y + radiusMm * Math.sin(t) });
  }
  return points;
}

export function shoelaceArea(loop: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Ensures positive shoelace area, the TracedOutline outer-loop convention. */
export function orientPositive(loop: MmPoint[]): MmPoint[] {
  return shoelaceArea(loop) >= 0 ? loop : [...loop].reverse();
}

/** A face's outer plus holes as a plain TracedOutline for the trace pipeline. */
export function regionToOutline(face: RegionFace): TracedOutline {
  return { outer: face.outer, holes: face.holes };
}

// --- Internal curve model -------------------------------------------------

type Curve =
  | { kind: 'line'; entityId: string; p1: MmPoint; p2: MmPoint }
  | {
      kind: 'arc' | 'circle';
      entityId: string;
      center: MmPoint;
      radius: number;
      /** Angle domain in radians; circles use the fixed [0, 2*PI] closed loop. */
      startAngle: number;
      endAngle: number;
    };

function pointAtParam(curve: Curve, t: number): MmPoint {
  if (curve.kind === 'line') {
    return { x: curve.p1.x + t * (curve.p2.x - curve.p1.x), y: curve.p1.y + t * (curve.p2.y - curve.p1.y) };
  }
  return { x: curve.center.x + curve.radius * Math.cos(t), y: curve.center.y + curve.radius * Math.sin(t) };
}

function buildCurves(sketch: Sketch): Curve[] {
  const byId = new Map<string, SketchEntity>(sketch.entities.map((e) => [e.id, e]));
  const pointOf = (id: string): SketchPoint => byId.get(id) as SketchPoint;
  const curves: Curve[] = [];
  for (const e of sketch.entities) {
    if (e.construction) continue;
    switch (e.kind) {
      case 'point':
        break;
      case 'line': {
        const p1 = pointOf(e.p1Id);
        const p2 = pointOf(e.p2Id);
        curves.push({ kind: 'line', entityId: e.id, p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y } });
        break;
      }
      case 'arc': {
        const center = pointOf(e.centerId);
        const start = pointOf(e.startId);
        const end = pointOf(e.endId);
        const radius = Math.hypot(start.x - center.x, start.y - center.y);
        const a0 = Math.atan2(start.y - center.y, start.x - center.x);
        let a1 = Math.atan2(end.y - center.y, end.x - center.x);
        if (a1 <= a0) a1 += 2 * Math.PI;
        curves.push({
          kind: 'arc',
          entityId: e.id,
          center: { x: center.x, y: center.y },
          radius,
          startAngle: a0,
          endAngle: a1,
        });
        break;
      }
      case 'circle': {
        const center = pointOf(e.centerId);
        curves.push({
          kind: 'circle',
          entityId: e.id,
          center: { x: center.x, y: center.y },
          radius: e.radiusMm,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        });
        break;
      }
      default:
        assertNever(e);
    }
  }
  return curves;
}

// --- Analytic pairwise intersections ---------------------------------------

/** All intersection points of two curves' underlying infinite line/full circle. */
function rawIntersections(a: Curve, b: Curve): MmPoint[] {
  if (a.kind === 'line' && b.kind === 'line') return lineLine(a, b);
  if (a.kind === 'line' && b.kind !== 'line') return lineCircle(a, b);
  if (b.kind === 'line' && a.kind !== 'line') return lineCircle(b, a);
  if (a.kind !== 'line' && b.kind !== 'line') return circleCircle(a, b);
  return [];
}

function lineLine(
  a: { p1: MmPoint; p2: MmPoint },
  b: { p1: MmPoint; p2: MmPoint },
): MmPoint[] {
  const d1x = a.p2.x - a.p1.x;
  const d1y = a.p2.y - a.p1.y;
  const d2x = b.p2.x - b.p1.x;
  const d2y = b.p2.y - b.p1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return []; // parallel or coincident, no isolated point
  const dx = b.p1.x - a.p1.x;
  const dy = b.p1.y - a.p1.y;
  const t = (dx * d2y - dy * d2x) / denom;
  return [{ x: a.p1.x + t * d1x, y: a.p1.y + t * d1y }];
}

/** Line (extended infinitely) intersected with a circle-like curve's full circle. */
function lineCircle(
  line: { p1: MmPoint; p2: MmPoint },
  circleLike: { center: MmPoint; radius: number },
): MmPoint[] {
  const dx = line.p2.x - line.p1.x;
  const dy = line.p2.y - line.p1.y;
  const fx = line.p1.x - circleLike.center.x;
  const fy = line.p1.y - circleLike.center.y;
  const a = dx * dx + dy * dy;
  if (a < 1e-18) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - circleLike.radius * circleLike.radius;
  const discriminant = b * b - 4 * a * c;
  // Tangency defense: a near-zero discriminant is treated as exactly one
  // tangent point rather than two coincident (or numerically imaginary) roots.
  const tangentThreshold = 4 * a * a * WELD_EPSILON_MM * WELD_EPSILON_MM;
  if (discriminant < -tangentThreshold) return [];
  if (Math.abs(discriminant) <= tangentThreshold) {
    const t = -b / (2 * a);
    return [{ x: line.p1.x + t * dx, y: line.p1.y + t * dy }];
  }
  const sqrtDisc = Math.sqrt(discriminant);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  return [
    { x: line.p1.x + t1 * dx, y: line.p1.y + t1 * dy },
    { x: line.p1.x + t2 * dx, y: line.p1.y + t2 * dy },
  ];
}

/** Two full circles' intersection points via the radical line. */
function circleCircle(
  a: { center: MmPoint; radius: number },
  b: { center: MmPoint; radius: number },
): MmPoint[] {
  const dx = b.center.x - a.center.x;
  const dy = b.center.y - a.center.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return []; // concentric, no isolated intersection
  const r1 = a.radius;
  const r2 = b.radius;
  if (d > r1 + r2 + WELD_EPSILON_MM || d < Math.abs(r1 - r2) - WELD_EPSILON_MM) return [];
  // Distance from a.center to the radical line, and the tangency defense
  // threshold on how close to the (non-)intersecting boundary this pair is.
  const aDist = (d * d - r2 * r2 + r1 * r1) / (2 * d);
  const hSquared = r1 * r1 - aDist * aDist;
  const ux = dx / d;
  const uy = dy / d;
  const midX = a.center.x + aDist * ux;
  const midY = a.center.y + aDist * uy;
  if (hSquared <= WELD_EPSILON_MM * WELD_EPSILON_MM) {
    return [{ x: midX, y: midY }];
  }
  if (hSquared < 0) return [];
  const h = Math.sqrt(hSquared);
  return [
    { x: midX - h * uy, y: midY + h * ux },
    { x: midX + h * uy, y: midY - h * ux },
  ];
}

/** The curve's parameter for a point known to lie on its underlying line/circle, or null if outside its extent. */
function paramOnCurve(curve: Curve, p: MmPoint): number | null {
  if (curve.kind === 'line') {
    const dx = curve.p2.x - curve.p1.x;
    const dy = curve.p2.y - curve.p1.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return null;
    const t = ((p.x - curve.p1.x) * dx + (p.y - curve.p1.y) * dy) / len2;
    const tolT = WELD_EPSILON_MM / Math.sqrt(len2);
    if (t < -tolT || t > 1 + tolT) return null;
    return Math.max(0, Math.min(1, t));
  }
  let angle = Math.atan2(p.y - curve.center.y, p.x - curve.center.x);
  if (curve.kind === 'circle') {
    if (angle < 0) angle += 2 * Math.PI;
    return angle;
  }
  while (angle < curve.startAngle - WELD_EPSILON_MM) angle += 2 * Math.PI;
  if (angle > curve.endAngle + WELD_EPSILON_MM) return null;
  return Math.max(curve.startAngle, Math.min(curve.endAngle, angle));
}

// --- Union-find vertex welding ---------------------------------------------

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

interface RawPoint {
  point: MmPoint;
  curveIndex: number;
}

// --- Half-edge arrangement --------------------------------------------------

interface HalfEdge {
  id: number;
  from: number;
  to: number;
  /** Polyline from `from` to `to`, inclusive of both endpoints. */
  points: MmPoint[];
  entityId: string;
  twin: number;
  componentId: number;
  visited: boolean;
}

/**
 * Builds the arrangement of the sketch's non-construction curves and
 * enumerates its bounded faces, with island regions nested as holes of the
 * face that contains them.
 */
export function extractRegions(sketch: Sketch): RegionsResult {
  const curves = buildCurves(sketch);
  if (curves.length === 0) {
    return { ok: false, error: CONSTRUCTION_ONLY };
  }

  // Step 1: analytic pairwise intersections, tagged with the owning curve.
  const rawPoints: RawPoint[] = [];
  for (let i = 0; i < curves.length; i += 1) {
    const curve = curves[i];
    if (curve.kind === 'line') {
      rawPoints.push({ point: curve.p1, curveIndex: i });
      rawPoints.push({ point: curve.p2, curveIndex: i });
    } else {
      // Guaranteed domain-boundary split point(s): arcs get their own start,
      // circles get one phantom point at angle 0 that also closes the loop.
      rawPoints.push({ point: pointAtParam(curve, curve.startAngle), curveIndex: i });
      if (curve.kind === 'arc') {
        rawPoints.push({ point: pointAtParam(curve, curve.endAngle), curveIndex: i });
      }
    }
  }
  for (let i = 0; i < curves.length; i += 1) {
    for (let j = i + 1; j < curves.length; j += 1) {
      const points = rawIntersections(curves[i], curves[j]);
      for (const p of points) {
        const ti = paramOnCurve(curves[i], p);
        const tj = paramOnCurve(curves[j], p);
        if (ti === null || tj === null) continue;
        rawPoints.push({ point: pointAtParam(curves[i], ti), curveIndex: i });
        rawPoints.push({ point: pointAtParam(curves[j], tj), curveIndex: j });
      }
    }
  }

  // Step 2: epsilon vertex welding via union-find.
  const uf = new UnionFind(rawPoints.length);
  for (let i = 0; i < rawPoints.length; i += 1) {
    for (let j = i + 1; j < rawPoints.length; j += 1) {
      const d = Math.hypot(rawPoints[i].point.x - rawPoints[j].point.x, rawPoints[i].point.y - rawPoints[j].point.y);
      if (d <= WELD_EPSILON_MM) uf.union(i, j);
    }
  }
  const groupOf = new Map<number, number>();
  const vertexPos: MmPoint[] = [];
  const rootToVertex = new Map<number, number>();
  for (let i = 0; i < rawPoints.length; i += 1) {
    const root = uf.find(i);
    let vertexId = rootToVertex.get(root);
    if (vertexId === undefined) {
      vertexId = vertexPos.length;
      vertexPos.push(rawPoints[i].point);
      rootToVertex.set(root, vertexId);
    }
    groupOf.set(i, vertexId);
  }

  // Step 3: split each curve at its own params, flatten each sub-curve.
  const halfEdges: HalfEdge[] = [];
  const outgoing = new Map<number, number[]>(); // vertex -> half-edge ids leaving it
  const addOutgoing = (v: number, heId: number): void => {
    const list = outgoing.get(v) ?? [];
    list.push(heId);
    outgoing.set(v, list);
  };

  for (let ci = 0; ci < curves.length; ci += 1) {
    const curve = curves[ci];
    const owned = rawPoints
      .map((rp, idx) => ({ rp, idx }))
      .filter(({ rp }) => rp.curveIndex === ci);
    const withParam = owned
      .map(({ rp, idx }) => ({ vertex: groupOf.get(idx) as number, t: paramOnCurve(curve, rp.point) }))
      .filter((e): e is { vertex: number; t: number } => e.t !== null);
    withParam.sort((a, b) => a.t - b.t);
    // Dedupe consecutive entries at (numerically) the same parameter.
    const splits: { vertex: number; t: number }[] = [];
    for (const entry of withParam) {
      const last = splits[splits.length - 1];
      if (last !== undefined && Math.abs(last.t - entry.t) < 1e-12 && last.vertex === entry.vertex) continue;
      splits.push(entry);
    }
    if (curve.kind === 'circle' ? splits.length < 1 : splits.length < 2) continue; // no span to build an edge from
    const segments: { fromV: number; toV: number; fromT: number; toT: number }[] = [];
    for (let k = 0; k < splits.length - 1; k += 1) {
      segments.push({ fromV: splits[k].vertex, toV: splits[k + 1].vertex, fromT: splits[k].t, toT: splits[k + 1].t });
    }
    if (curve.kind === 'circle') {
      // Close the loop: last split back around to the first (same vertex).
      segments.push({
        fromV: splits[splits.length - 1].vertex,
        toV: splits[0].vertex,
        fromT: splits[splits.length - 1].t,
        toT: splits[0].t + 2 * Math.PI,
      });
    }
    for (const seg of segments) {
      const forwardPoints: MmPoint[] =
        curve.kind === 'line'
          ? [pointAtParam(curve, seg.fromT), pointAtParam(curve, seg.toT)]
          : [
              pointAtParam(curve, seg.fromT),
              ...flattenArcRange(curve, seg.fromT, seg.toT).slice(1, -1),
              pointAtParam(curve, seg.toT),
            ];
      const length = polylineLength(forwardPoints);
      // Tangency defense: drop post-split edges shorter than the epsilon.
      if (length < WELD_EPSILON_MM) continue;
      const heForward: HalfEdge = {
        id: halfEdges.length,
        from: seg.fromV,
        to: seg.toV,
        points: forwardPoints,
        entityId: curve.entityId,
        twin: halfEdges.length + 1,
        componentId: -1,
        visited: false,
      };
      halfEdges.push(heForward);
      const heBackward: HalfEdge = {
        id: halfEdges.length,
        from: seg.toV,
        to: seg.fromV,
        points: [...forwardPoints].reverse(),
        entityId: curve.entityId,
        twin: heForward.id,
        componentId: -1,
        visited: false,
      };
      halfEdges.push(heBackward);
      addOutgoing(seg.fromV, heForward.id);
      addOutgoing(seg.toV, heBackward.id);
    }
  }

  if (halfEdges.length === 0) {
    return { ok: false, error: NO_REGIONS };
  }

  // Connected components (undirected, via twin/vertex adjacency) so a face
  // contained in another face's outer boundary is only treated as an island
  // hole when it comes from a genuinely separate piece of geometry.
  const componentOf = new Map<number, number>(); // vertex -> component id
  let nextComponent = 0;
  for (const startVertex of outgoing.keys()) {
    if (componentOf.has(startVertex)) continue;
    const stack = [startVertex];
    componentOf.set(startVertex, nextComponent);
    while (stack.length > 0) {
      const v = stack.pop() as number;
      for (const heId of outgoing.get(v) ?? []) {
        const other = halfEdges[heId].to;
        if (!componentOf.has(other)) {
          componentOf.set(other, nextComponent);
          stack.push(other);
        }
      }
    }
    nextComponent += 1;
  }
  for (const he of halfEdges) he.componentId = componentOf.get(he.from) as number;

  // Step 4: sort outgoing half-edges at each vertex by initial direction.
  const angleOf = (he: HalfEdge): number => {
    const a = he.points[0];
    const b = he.points[1];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const sortedOutgoing = new Map<number, number[]>();
  for (const [v, ids] of outgoing) {
    sortedOutgoing.set(
      v,
      [...ids].sort((a, b) => angleOf(halfEdges[a]) - angleOf(halfEdges[b])),
    );
  }

  const nextHalfEdge = (heId: number): number => {
    const he = halfEdges[heId];
    const atTarget = sortedOutgoing.get(he.to) as number[];
    const k = atTarget.indexOf(he.twin);
    return atTarget[(k - 1 + atTarget.length) % atTarget.length];
  };

  // Face traversal: walk each unvisited half-edge's cycle.
  interface Cycle {
    points: MmPoint[];
    area: number;
    componentId: number;
    entityIds: Set<string>;
  }
  const cycles: Cycle[] = [];
  for (const he of halfEdges) {
    if (he.visited) continue;
    const points: MmPoint[] = [];
    const entityIds = new Set<string>();
    let cur = he.id;
    for (;;) {
      const edge = halfEdges[cur];
      edge.visited = true;
      entityIds.add(edge.entityId);
      // Skip the last point (shared with the next edge's first point).
      points.push(...edge.points.slice(0, -1));
      cur = nextHalfEdge(cur);
      if (cur === he.id) break;
    }
    cycles.push({ points, area: shoelaceArea(points), componentId: he.componentId, entityIds });
  }

  const positive = cycles.filter((c) => c.area > 0);

  // Step 4 (continued): group faces fully inside another face's outer
  // boundary, from a different connected component, into that face's holes.
  const parentOf: (number | null)[] = positive.map(() => null);
  for (let i = 0; i < positive.length; i += 1) {
    const candidate = positive[i];
    const leftmost = candidate.points.reduce((a, b) => (b.x < a.x ? b : a));
    let bestParent = -1;
    let bestArea = Infinity;
    for (let j = 0; j < positive.length; j += 1) {
      if (i === j) continue;
      const outer = positive[j];
      if (outer.componentId === candidate.componentId) continue;
      if (outer.area >= bestArea) continue;
      if (pointInPolygon(leftmost, outer.points) && outer.area > candidate.area) {
        bestParent = j;
        bestArea = outer.area;
      }
    }
    parentOf[i] = bestParent >= 0 ? bestParent : null;
  }

  const faces: RegionFace[] = positive.map((cycle, i) => {
    const holeIndices = parentOf
      .map((p, idx) => (p === i ? idx : -1))
      .filter((idx) => idx >= 0);
    const holes = holeIndices.map((idx) => orientNegative(positive[idx].points));
    const entityIds = new Set(cycle.entityIds);
    for (const idx of holeIndices) for (const id of positive[idx].entityIds) entityIds.add(id);
    return {
      id: `region-${i}`,
      outer: orientPositive(cycle.points),
      holes,
      areaMm2: Math.abs(cycle.area),
      entityIds: [...entityIds],
    };
  });

  if (faces.length === 0) {
    return { ok: false, error: NO_REGIONS };
  }
  return { ok: true, faces };
}

function flattenArcRange(
  curve: { center: MmPoint; radius: number },
  fromT: number,
  toT: number,
): MmPoint[] {
  const n = segmentCount(curve.radius, Math.abs(toT - fromT));
  const points: MmPoint[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = fromT + ((toT - fromT) * i) / n;
    points.push({ x: curve.center.x + curve.radius * Math.cos(t), y: curve.center.y + curve.radius * Math.sin(t) });
  }
  return points;
}

function polylineLength(points: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    sum += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return sum;
}

function orientNegative(loop: MmPoint[]): MmPoint[] {
  return shoelaceArea(loop) <= 0 ? loop : [...loop].reverse();
}

/** Standard ray-casting point-in-polygon test. */
function pointInPolygon(p: MmPoint, polygon: MmPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > p.y !== b.y > p.y;
    if (!crosses) continue;
    const xIntersect = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (p.x < xIntersect) inside = !inside;
  }
  return inside;
}
