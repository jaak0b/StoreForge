// Geometry for the CAD-style constraint glyphs drawn on the sketch canvas
// (parallel ticks, perpendicular right-angle marks, H/V letters, tangent
// dots, coincident rings, symmetric arrows). Kept in the engine, framework
// agnostic, so the placement math is unit-testable and the canvas component
// only turns these mm-space descriptors into SVG. Dimensions (length,
// distance, radius, diameter, angle) already render as text labels
// (SketchCanvas's dimensionLabels) and produce no glyph here.
import { assertNever } from '../plan/types';
import type { MmPoint } from '../trace/types';
import type { Sketch, SketchConstraint, SketchEntity } from './model';

/** One glyph marker, positioned in sketch mm coordinates. angleDeg (where
 * present) is the reference line's or mirror line's direction, for the
 * caller to orient the mark. */
export type ConstraintGlyph =
  | { kind: 'parallel'; constraintId: string; at: MmPoint; angleDeg: number; tickCount: number }
  | { kind: 'perpendicular'; constraintId: string; at: MmPoint; angleDeg: number }
  | { kind: 'horizontal'; constraintId: string; at: MmPoint }
  | { kind: 'vertical'; constraintId: string; at: MmPoint }
  | { kind: 'tangent'; constraintId: string; at: MmPoint }
  | { kind: 'coincident'; constraintId: string; at: MmPoint }
  | { kind: 'symmetric'; constraintId: string; aAt: MmPoint; bAt: MmPoint; angleDeg: number };

function pointsOf(sketch: Sketch): Map<string, MmPoint> {
  const map = new Map<string, MmPoint>();
  for (const e of sketch.entities) if (e.kind === 'point') map.set(e.id, { x: e.x, y: e.y });
  return map;
}

function entitiesOf(sketch: Sketch): Map<string, SketchEntity> {
  return new Map(sketch.entities.map((e) => [e.id, e]));
}

function midpoint(a: MmPoint, b: MmPoint): MmPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function angleDegOf(a: MmPoint, b: MmPoint): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Points sampled along an entity's shape, for nearest-approach searches; a
 * point entity samples to itself. Adequate for a visual glyph placement, not
 * a measurement (convention 12 governs the photo measurement pipeline, not
 * decorative UI markers). */
function sampleEntity(
  points: Map<string, MmPoint>,
  entities: Map<string, SketchEntity>,
  entityId: string,
  count = 24,
): MmPoint[] {
  const asPoint = points.get(entityId);
  if (asPoint !== undefined) return [asPoint];
  const entity = entities.get(entityId);
  if (entity === undefined) return [];
  switch (entity.kind) {
    case 'point':
      return [{ x: entity.x, y: entity.y }];
    case 'line': {
      const a = points.get(entity.p1Id);
      const b = points.get(entity.p2Id);
      if (a === undefined || b === undefined) return [];
      return Array.from({ length: count + 1 }, (_, i) => {
        const t = i / count;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      });
    }
    case 'arc': {
      const c = points.get(entity.centerId);
      const s = points.get(entity.startId);
      const e = points.get(entity.endId);
      if (c === undefined || s === undefined || e === undefined) return [];
      const r = Math.hypot(s.x - c.x, s.y - c.y);
      const a0 = Math.atan2(s.y - c.y, s.x - c.x);
      let a1 = Math.atan2(e.y - c.y, e.x - c.x);
      if (a1 <= a0) a1 += 2 * Math.PI;
      return Array.from({ length: count + 1 }, (_, i) => {
        const a = a0 + ((a1 - a0) * i) / count;
        return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
      });
    }
    case 'circle': {
      const c = points.get(entity.centerId);
      if (c === undefined) return [];
      return Array.from({ length: count }, (_, i) => {
        const a = (2 * Math.PI * i) / count;
        return { x: c.x + entity.radiusMm * Math.cos(a), y: c.y + entity.radiusMm * Math.sin(a) };
      });
    }
    default:
      return assertNever(entity);
  }
}

/** The closest pair of points between two entities' shapes, by brute-force
 * sampling; drives the tangency dot and the perpendicular mark's fallback
 * position when the lines share no endpoint. */
function nearestApproach(
  points: Map<string, MmPoint>,
  entities: Map<string, SketchEntity>,
  aId: string,
  bId: string,
): { aAt: MmPoint; bAt: MmPoint } | null {
  const aSamples = sampleEntity(points, entities, aId);
  const bSamples = sampleEntity(points, entities, bId);
  if (aSamples.length === 0 || bSamples.length === 0) return null;
  let best: { aAt: MmPoint; bAt: MmPoint; d: number } | null = null;
  for (const aAt of aSamples) {
    for (const bAt of bSamples) {
      const d = Math.hypot(aAt.x - bAt.x, aAt.y - bAt.y);
      if (best === null || d < best.d) best = { aAt, bAt, d };
    }
  }
  return best === null ? null : { aAt: best.aAt, bAt: best.bAt };
}

function lineEndpoints(
  points: Map<string, MmPoint>,
  entities: Map<string, SketchEntity>,
  lineId: string,
): [MmPoint, MmPoint] | null {
  const line = entities.get(lineId);
  if (line === undefined || line.kind !== 'line') return null;
  const a = points.get(line.p1Id);
  const b = points.get(line.p2Id);
  if (a === undefined || b === undefined) return null;
  return [a, b];
}

/** A point shared (within tolerance) by both line endpoint pairs, or null. */
function sharedEndpoint(e1: [MmPoint, MmPoint], e2: [MmPoint, MmPoint]): MmPoint | null {
  for (const p of e1) {
    for (const q of e2) {
      if (Math.hypot(p.x - q.x, p.y - q.y) < 1e-6) return p;
    }
  }
  return null;
}

/**
 * Assigns each parallel constraint's tick count by connected component over
 * the constrained lines (union-find): lines transitively tied together by
 * parallel constraints share one tick count, and distinct groups escalate
 * 1, 2, 3..., the CAD convention for telling separate parallel families
 * apart on one sketch.
 */
function parallelGroupTickCounts(constraints: SketchConstraint[]): Map<string, number> {
  const parent = new Map<string, string>();
  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression.
    parent.set(id, root);
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const order: string[] = [];
  for (const c of constraints) {
    if (c.kind !== 'parallel') continue;
    if (!parent.has(c.l1Id)) {
      parent.set(c.l1Id, c.l1Id);
      order.push(c.l1Id);
    }
    if (!parent.has(c.l2Id)) {
      parent.set(c.l2Id, c.l2Id);
      order.push(c.l2Id);
    }
    union(c.l1Id, c.l2Id);
  }
  const rootIndex = new Map<string, number>();
  for (const lineId of order) {
    const root = find(lineId);
    if (!rootIndex.has(root)) rootIndex.set(root, rootIndex.size);
  }
  const tickCount = new Map<string, number>();
  for (const lineId of order) tickCount.set(lineId, rootIndex.get(find(lineId))! + 1);
  return tickCount;
}

/**
 * Computes the glyph markers for a sketch's constraints. Exhaustive over
 * SketchConstraint's kinds; the dimension kinds (length, distance, radius,
 * diameter, angle) are handled explicitly and produce no glyph.
 */
export function constraintGlyphs(sketch: Sketch): ConstraintGlyph[] {
  const points = pointsOf(sketch);
  const entities = entitiesOf(sketch);
  const parallelTicks = parallelGroupTickCounts(sketch.constraints);
  const glyphs: ConstraintGlyph[] = [];
  for (const c of sketch.constraints) {
    switch (c.kind) {
      case 'parallel': {
        const tickCount = parallelTicks.get(c.l1Id) ?? 1;
        const e1 = lineEndpoints(points, entities, c.l1Id);
        const e2 = lineEndpoints(points, entities, c.l2Id);
        if (e1 !== null) {
          glyphs.push({
            kind: 'parallel',
            constraintId: c.id,
            at: midpoint(e1[0], e1[1]),
            angleDeg: angleDegOf(e1[0], e1[1]),
            tickCount,
          });
        }
        if (e2 !== null) {
          glyphs.push({
            kind: 'parallel',
            constraintId: c.id,
            at: midpoint(e2[0], e2[1]),
            angleDeg: angleDegOf(e2[0], e2[1]),
            tickCount,
          });
        }
        break;
      }
      case 'perpendicular': {
        const e1 = lineEndpoints(points, entities, c.l1Id);
        const e2 = lineEndpoints(points, entities, c.l2Id);
        if (e1 === null || e2 === null) break;
        const shared = sharedEndpoint(e1, e2);
        const near = shared === null ? nearestApproach(points, entities, c.l1Id, c.l2Id) : null;
        const at = shared ?? near?.aAt ?? midpoint(e1[0], e1[1]);
        glyphs.push({ kind: 'perpendicular', constraintId: c.id, at, angleDeg: angleDegOf(e1[0], e1[1]) });
        break;
      }
      case 'horizontal': {
        const e = lineEndpoints(points, entities, c.lineId);
        if (e === null) break;
        glyphs.push({ kind: 'horizontal', constraintId: c.id, at: midpoint(e[0], e[1]) });
        break;
      }
      case 'vertical': {
        const e = lineEndpoints(points, entities, c.lineId);
        if (e === null) break;
        glyphs.push({ kind: 'vertical', constraintId: c.id, at: midpoint(e[0], e[1]) });
        break;
      }
      case 'tangent': {
        const near = nearestApproach(points, entities, c.aId, c.bId);
        if (near === null) break;
        glyphs.push({ kind: 'tangent', constraintId: c.id, at: midpoint(near.aAt, near.bAt) });
        break;
      }
      case 'coincident': {
        const a = points.get(c.p1Id);
        const b = points.get(c.p2Id);
        if (a === undefined || b === undefined) break;
        glyphs.push({ kind: 'coincident', constraintId: c.id, at: midpoint(a, b) });
        break;
      }
      case 'symmetric': {
        const a = points.get(c.p1Id);
        const b = points.get(c.p2Id);
        const mirror = lineEndpoints(points, entities, c.mirrorLineId);
        if (a === undefined || b === undefined || mirror === null) break;
        glyphs.push({
          kind: 'symmetric',
          constraintId: c.id,
          aAt: a,
          bAt: b,
          angleDeg: angleDegOf(mirror[0], mirror[1]),
        });
        break;
      }
      case 'length':
      case 'distance':
      case 'radius':
      case 'diameter':
      case 'angle':
      case 'pointLineDistance':
        // Dimensions render as text labels, not glyphs.
        break;
      default:
        return assertNever(c);
    }
  }
  return glyphs;
}

/** A complete sentence naming a constraint's kind, for the workspace hint
 * line when a glyph selects it. Exhaustive over SketchConstraint's kinds. */
export function constraintKindSentence(c: SketchConstraint): string {
  switch (c.kind) {
    case 'coincident':
      return 'The selected constraint holds two points coincident.';
    case 'horizontal':
      return 'The selected constraint holds a line horizontal.';
    case 'vertical':
      return 'The selected constraint holds a line vertical.';
    case 'parallel':
      return 'The selected constraint holds two lines parallel.';
    case 'perpendicular':
      return 'The selected constraint holds two lines perpendicular.';
    case 'tangent':
      return 'The selected constraint holds two curves tangent.';
    case 'symmetric':
      return 'The selected constraint holds two points symmetric across the mirror line.';
    case 'length':
      return 'The selected constraint is a length dimension.';
    case 'distance':
      return 'The selected constraint is a distance dimension.';
    case 'radius':
      return 'The selected constraint is a radius dimension.';
    case 'diameter':
      return 'The selected constraint is a diameter dimension.';
    case 'angle':
      return 'The selected constraint is an angle dimension.';
    case 'pointLineDistance':
      return 'The selected constraint is a point-line distance dimension.';
    default:
      return assertNever(c);
  }
}
