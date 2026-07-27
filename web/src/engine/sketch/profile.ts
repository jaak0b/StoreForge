// Extracts the closed outer loop of a solved sketch as the trace pipeline's
// outline type. Arcs and circles are flattened by the standard sagitta bound
// (segment angle chosen so the chord-to-arc deviation stays within the shared
// outline tolerance). Failures are user-worded messages the UI shows verbatim.
import type { MmPoint, TracedOutline } from '../trace/types';
import { assertNever } from '../plan/types';
import type { Sketch, SketchArc, SketchCircle, SketchEntity, SketchPoint } from './model';
import { flattenArc, flattenCircle, orientPositive } from './regions';

export type ProfileResult =
  | { ok: true; outline: TracedOutline }
  | { ok: false; error: string };

const OPEN_CHAIN =
  'The outline is not closed. Connect every line and arc end to end into one loop.';
const SELF_INTERSECTING =
  'The outline crosses itself. Adjust the shape so its boundary does not intersect.';
const CONSTRUCTION_ONLY =
  'The sketch has only construction geometry. Draw the shape with regular lines, arcs or a circle.';
const MULTIPLE_LOOPS =
  'The sketch contains more than one separate shape. Keep exactly one closed outline.';

/**
 * Union-find over point ids: points joined by coincident constraints count
 * as the same chain node, matching what the solver enforces.
 */
class PointGroups {
  private parent = new Map<string, string>();

  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined || p === id) return p ?? id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Proper (interior) intersection test of two segments, standard orientation test. */
function segmentsCross(a1: MmPoint, a2: MmPoint, b1: MmPoint, b2: MmPoint): boolean {
  const orient = (p: MmPoint, q: MmPoint, r: MmPoint): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function selfIntersects(loop: MmPoint[]): boolean {
  const n = loop.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // Skip adjacent segments (they share an endpoint by construction).
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(loop[i], loop[(i + 1) % n], loop[j], loop[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Extracts the single closed outer loop of the sketch's non-construction
 * geometry as a TracedOutline (positive shoelace area, no holes in v1). A
 * lone non-construction circle stands alone as the whole outline.
 */
export function extractProfile(sketch: Sketch): ProfileResult {
  const byId = new Map<string, SketchEntity>(sketch.entities.map((e) => [e.id, e]));
  const pointOf = (id: string): SketchPoint => byId.get(id) as SketchPoint;
  const curves = sketch.entities.filter(
    (e): e is Extract<SketchEntity, { kind: 'line' | 'arc' }> =>
      (e.kind === 'line' || e.kind === 'arc') && !e.construction,
  );
  const circles = sketch.entities.filter(
    (e): e is SketchCircle => e.kind === 'circle' && !e.construction,
  );
  if (curves.length === 0 && circles.length === 0) {
    return { ok: false, error: CONSTRUCTION_ONLY };
  }
  if (circles.length > 0) {
    if (circles.length > 1 || curves.length > 0) {
      return { ok: false, error: MULTIPLE_LOOPS };
    }
    const circle = circles[0];
    return {
      ok: true,
      outline: { outer: orientPositive(flattenCircle(pointOf(circle.centerId), circle.radiusMm)), holes: [] },
    };
  }
  // Merge endpoints joined by coincident constraints.
  const groups = new PointGroups();
  for (const c of sketch.constraints) {
    if (c.kind === 'coincident') groups.union(c.p1Id, c.p2Id);
  }
  const endsOf = (curve: (typeof curves)[number]): [string, string] => {
    switch (curve.kind) {
      case 'line':
        return [groups.find(curve.p1Id), groups.find(curve.p2Id)];
      case 'arc':
        return [groups.find(curve.startId), groups.find(curve.endId)];
      default:
        return assertNever(curve);
    }
  };
  // Every merged endpoint must join exactly two curves for one closed loop.
  const adjacency = new Map<string, { curve: (typeof curves)[number]; other: string }[]>();
  for (const curve of curves) {
    const [a, b] = endsOf(curve);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = adjacency.get(from) ?? [];
      list.push({ curve, other: to });
      adjacency.set(from, list);
    }
  }
  for (const list of adjacency.values()) {
    if (list.length !== 2) return { ok: false, error: OPEN_CHAIN };
  }
  // Walk the loop from the first curve; every curve must be visited once.
  const visited = new Set<string>();
  const loop: MmPoint[] = [];
  const startNode = endsOf(curves[0])[0];
  let node = startNode;
  let previousCurveId: string | null = null;
  for (;;) {
    const nextEdge = (adjacency.get(node) ?? []).find(
      (edge) => edge.curve.id !== previousCurveId && !visited.has(edge.curve.id),
    );
    if (nextEdge === undefined) break;
    const curve = nextEdge.curve;
    visited.add(curve.id);
    switch (curve.kind) {
      case 'line': {
        const from =
          groups.find(curve.p1Id) === node ? pointOf(curve.p1Id) : pointOf(curve.p2Id);
        loop.push({ x: from.x, y: from.y });
        break;
      }
      case 'arc': {
        const reversed = groups.find(curve.startId) !== node;
        loop.push(
          ...flattenArc(
            pointOf((curve as SketchArc).centerId),
            pointOf((curve as SketchArc).startId),
            pointOf((curve as SketchArc).endId),
            reversed,
          ),
        );
        break;
      }
      default:
        return assertNever(curve);
    }
    previousCurveId = curve.id;
    node = nextEdge.other;
    if (node === startNode) break;
  }
  if (visited.size !== curves.length) {
    return { ok: false, error: MULTIPLE_LOOPS };
  }
  if (node !== startNode || loop.length < 3) {
    return { ok: false, error: OPEN_CHAIN };
  }
  if (selfIntersects(loop)) {
    return { ok: false, error: SELF_INTERSECTING };
  }
  return { ok: true, outline: { outer: orientPositive(loop), holes: [] } };
}
