// Computes Fusion-360-style dimension graphics primitives (witness lines,
// dimension line, arrowheads, leader lines, arc sweeps) for a dimension
// constraint, in sketch mm coordinates. Framework-agnostic (convention 3):
// no Vue, no DOM. SketchCanvas.vue is the only renderer, and the placement
// ghost preview reuses the exact same functions so the preview never
// promises a shape the commit would not actually draw (convention 10).
import type { MmPoint } from '../trace/types';
import type { LabelOffset, Sketch, SketchDimension } from './model';
import { assertNever } from '../plan/types';
import { WELD_EPSILON_MM } from './regions';
import { measureAngleBetweenLines } from './measure';

/** Default label offset (mm) used when a dimension has none yet (a fresh
 * placement ghost preview, or an older sketch with no stored offset). */
export const DEFAULT_LABEL_OFFSET: LabelOffset = { x: 0, y: -8 };

function pointOf(sketch: Sketch, id: string): MmPoint {
  const e = sketch.entities.find((x) => x.id === id);
  return e !== undefined && e.kind === 'point' ? { x: e.x, y: e.y } : { x: 0, y: 0 };
}

function sub(a: MmPoint, b: MmPoint): MmPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a: MmPoint, b: MmPoint): MmPoint {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scale(a: MmPoint, s: number): MmPoint {
  return { x: a.x * s, y: a.y * s };
}
function len(a: MmPoint): number {
  return Math.hypot(a.x, a.y);
}
function normalize(a: MmPoint): MmPoint {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
}
/** The two-dimensional perpendicular (rotated +90 degrees). */
function perp(a: MmPoint): MmPoint {
  return { x: -a.y, y: a.x };
}

/**
 * The anchor point a dimension's labelOffset is stored relative to, per
 * kind: length/distance anchor at the midpoint of the two measured points,
 * radius/diameter anchor at the curve's center, angle anchor at the two
 * lines' intersection (or the midpoint of their four endpoints when the
 * lines are parallel and never meet). The single source for this mapping
 * (convention 10): both the renderer and the placement click's labelOffset
 * computation call this.
 */
export function dimensionAnchor(sketch: Sketch, dimension: SketchDimension): MmPoint {
  switch (dimension.kind) {
    case 'length': {
      const line = sketch.entities.find((e) => e.id === dimension.lineId);
      if (line === undefined || line.kind !== 'line') return { x: 0, y: 0 };
      return scale(add(pointOf(sketch, line.p1Id), pointOf(sketch, line.p2Id)), 0.5);
    }
    case 'distance':
      return scale(add(pointOf(sketch, dimension.p1Id), pointOf(sketch, dimension.p2Id)), 0.5);
    case 'radius':
    case 'diameter': {
      const entity = sketch.entities.find((e) => e.id === dimension.entityId);
      if (entity === undefined || (entity.kind !== 'arc' && entity.kind !== 'circle')) {
        return { x: 0, y: 0 };
      }
      return pointOf(sketch, entity.centerId);
    }
    case 'angle': {
      const v = angleVertex(sketch, dimension.l1Id, dimension.l2Id);
      return v ?? { x: 0, y: 0 };
    }
    case 'pointLineDistance': {
      const foot = pointLineFoot(sketch, dimension.pointId, dimension.lineId);
      if (foot === null) return { x: 0, y: 0 };
      return scale(add(pointOf(sketch, dimension.pointId), foot), 0.5);
    }
    default:
      return assertNever(dimension);
  }
}

/** The foot of the perpendicular from `pointId` onto `lineId`'s infinite
 * extension, the second endpoint a point-line distance dimension draws its
 * witness line to. Null when the line's points are missing or coincident. */
function pointLineFoot(sketch: Sketch, pointId: string, lineId: string): MmPoint | null {
  const line = sketch.entities.find((e) => e.id === lineId);
  if (line === undefined || line.kind !== 'line') return null;
  const a = pointOf(sketch, line.p1Id);
  const b = pointOf(sketch, line.p2Id);
  const p = pointOf(sketch, pointId);
  const d = sub(b, a);
  const lenSq = d.x * d.x + d.y * d.y;
  if (lenSq < 1e-12) return null;
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / lenSq;
  return add(a, scale(d, t));
}

/** Intersection of two lines' infinite extensions, or null when parallel;
 * falls back to the midpoint of the four endpoints for the angle anchor.
 * Exported so dimensionSelection.ts's angle-quadrant sector picking
 * (angleForCursorSector below reuses it directly; the selection module
 * shares this instead of re-deriving line intersection, convention 10). */
export function lineIntersection(
  sketch: Sketch,
  l1Id: string,
  l2Id: string,
): { point: MmPoint; d1: MmPoint; d2: MmPoint } | null {
  const l1 = sketch.entities.find((e) => e.id === l1Id);
  const l2 = sketch.entities.find((e) => e.id === l2Id);
  if (l1 === undefined || l1.kind !== 'line' || l2 === undefined || l2.kind !== 'line') return null;
  const a1 = pointOf(sketch, l1.p1Id);
  const b1 = pointOf(sketch, l1.p2Id);
  const a2 = pointOf(sketch, l2.p1Id);
  const b2 = pointOf(sketch, l2.p2Id);
  const d1 = sub(b1, a1);
  const d2 = sub(b2, a2);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((a2.x - a1.x) * d2.y - (a2.y - a1.y) * d2.x) / denom;
  return { point: add(a1, scale(d1, t)), d1, d2 };
}

/**
 * The shared endpoint of two lines, and each line's outward direction from
 * that vertex (vertex to the line's OTHER endpoint), when the lines' point
 * sets include a coincident pair (same point id, or within WELD_EPSILON_MM,
 * the same weld tolerance regions.ts's arrangement step uses for endpoint
 * coincidence). Null when the lines share no endpoint (a plain crossing, or
 * two lines with no common point at all), in which case the caller keeps the
 * existing intersection-based cursor sector behavior (angle dimension rule
 * 1). Direction is not normalized to unit length; callers only need its
 * angle, via atan2.
 */
function sharedVertex(
  sketch: Sketch,
  l1Id: string,
  l2Id: string,
): { vertex: MmPoint; out1: MmPoint; out2: MmPoint } | null {
  const l1 = sketch.entities.find((e) => e.id === l1Id);
  const l2 = sketch.entities.find((e) => e.id === l2Id);
  if (l1 === undefined || l1.kind !== 'line' || l2 === undefined || l2.kind !== 'line') return null;
  const pairs: readonly [string, string, string, string][] = [
    [l1.p1Id, l1.p2Id, l2.p1Id, l2.p2Id],
    [l1.p1Id, l1.p2Id, l2.p2Id, l2.p1Id],
    [l1.p2Id, l1.p1Id, l2.p1Id, l2.p2Id],
    [l1.p2Id, l1.p1Id, l2.p2Id, l2.p1Id],
  ];
  for (const [vertexId, farId1, vertexId2, farId2] of pairs) {
    const vertexPos = pointOf(sketch, vertexId);
    const vertexPos2 = pointOf(sketch, vertexId2);
    const coincident =
      vertexId === vertexId2 || Math.hypot(vertexPos.x - vertexPos2.x, vertexPos.y - vertexPos2.y) <= WELD_EPSILON_MM;
    if (!coincident) continue;
    return { vertex: vertexPos, out1: sub(pointOf(sketch, farId1), vertexPos), out2: sub(pointOf(sketch, farId2), vertexPos) };
  }
  return null;
}

/**
 * The default sector for an angle dimension between two lines that share a
 * vertex: the sector bounded by the two segments' own directions pointing
 * away from that shared vertex, i.e. the corner the two segments physically
 * draw (angle dimension rule 1). Computed by handing angleForCursorSector a
 * synthetic cursor on the corner's own bisector, so it is derived by the
 * same sector-search logic as the live cursor pick rather than a hand-rolled
 * duplicate (convention 10), just seeded from segment topology instead of a
 * possibly-ambiguous literal cursor position (see resolveAngleAtCursor's use
 * of this for why: a fresh selection's cursor typically sits right on one of
 * the two lines, which is exactly a sector *boundary*, and picking the
 * boundary's sector by raw angle there is fragile to which line's point
 * order happens to store the shared vertex first vs second). Null when the
 * lines share no vertex (a plain crossing) or are collinear at the vertex
 * (a degenerate 0/180 degree corner with no well-defined bisector).
 */
export function defaultAngleSector(
  sketch: Sketch,
  l1Id: string,
  l2Id: string,
): { degrees: number; supplementary: boolean; vertex: MmPoint } | null {
  const shared = sharedVertex(sketch, l1Id, l2Id);
  if (shared === null) return null;
  const u1 = normalize(shared.out1);
  const u2 = normalize(shared.out2);
  const bisector = add(u1, u2);
  const cursor =
    len(bisector) > 1e-9 ? add(shared.vertex, bisector) : add(shared.vertex, perp(u1));
  const sector = angleForCursorSector(sketch, l1Id, l2Id, cursor);
  if (sector === null) return null;
  return { degrees: sector.degrees, supplementary: sector.supplementary, vertex: shared.vertex };
}

/** The angular distance (degrees, 0..180) between two directions given in
 * degrees. Used to detect when a cursor sits close enough to one of a shared
 * vertex's own two rays that its raw sector pick is ambiguous. */
function angularDistanceDeg(a: number, b: number): number {
  const d = Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  return d;
}

/** Degrees below which a cursor is considered to be sitting on (rather than
 * clearly off) one of a shared vertex's two rays: a live-placement heuristic
 * for resolving sector ambiguity right after a selection click (which
 * typically lands on one of the two lines), not a convention-12 measurement
 * tolerance. */
const ANGLE_RAY_SNAP_DEG = 3;

/**
 * True when `cursor`'s direction from the two lines' shared vertex sits
 * within ANGLE_RAY_SNAP_DEG of either line's own ray from that vertex: the
 * ambiguous case a fresh selection's cursor (sitting on the just-clicked
 * line) lands in, where angleForCursorSector's raw pick is a coin flip
 * between the two sectors that ray bounds. False (never ambiguous) when the
 * lines share no vertex.
 */
function cursorOnSharedVertexRay(sketch: Sketch, l1Id: string, l2Id: string, cursor: MmPoint): boolean {
  const shared = sharedVertex(sketch, l1Id, l2Id);
  if (shared === null) return false;
  const cursorDeg = angleDegOf(shared.vertex, cursor);
  const deg1 = angleDegOf({ x: 0, y: 0 }, shared.out1);
  const deg2 = angleDegOf({ x: 0, y: 0 }, shared.out2);
  return angularDistanceDeg(cursorDeg, deg1) <= ANGLE_RAY_SNAP_DEG || angularDistanceDeg(cursorDeg, deg2) <= ANGLE_RAY_SNAP_DEG;
}

/**
 * The angle dimension's cursor-resolved sector, biased toward the shared-
 * vertex corner default (angle dimension rule 1) whenever the cursor sits
 * near enough to one of the two lines' own rays that a raw sector pick would
 * be ambiguous (cursorOnSharedVertexRay); otherwise defers to whichever
 * sector the cursor unambiguously lands in via angleForCursorSector, so a
 * deliberate cursor placement can still pick a different sector. Falls back
 * to the fixed direct-fold measured angle when the lines share no vertex and
 * are parallel (angleForCursorSector returns null). The single source
 * (convention 10) for both the placement/ghost preview and the store's
 * commit path.
 */
export function resolveAngleSector(
  sketch: Sketch,
  l1Id: string,
  l2Id: string,
  cursor: MmPoint,
): { degrees: number; supplementary: boolean } {
  const def = defaultAngleSector(sketch, l1Id, l2Id);
  if (def !== null && cursorOnSharedVertexRay(sketch, l1Id, l2Id, cursor)) {
    return { degrees: def.degrees, supplementary: def.supplementary };
  }
  const picked = angleForCursorSector(sketch, l1Id, l2Id, cursor);
  if (picked !== null) return picked;
  if (def !== null) return { degrees: def.degrees, supplementary: def.supplementary };
  return { degrees: measureAngleBetweenLines(sketch, l1Id, l2Id), supplementary: false };
}

/**
 * A witness extension line (angle dimension rule 2) from segment `a`-`b`'s
 * own nearest endpoint along ray direction `u` (a unit vector) from
 * `vertex`, out to the arc contact point at distance `radius` along that
 * same ray, when that contact point lies beyond the segment's actual extent
 * on this ray. Null when the arc contact point lands within (or at) the
 * segment's own extent (no extension needed), or when the segment lies
 * entirely on the other side of the vertex along this ray (no physical
 * endpoint on this side to extend from; this can only happen for a
 * non-shared-vertex crossing, since a shared-vertex ray by construction has
 * one endpoint (the vertex, at distance 0) on this side).
 */
function angleWitnessExtension(
  vertex: MmPoint,
  u: MmPoint,
  a: MmPoint,
  b: MmPoint,
  radius: number,
): { a: MmPoint; b: MmPoint } | null {
  const tA = (a.x - vertex.x) * u.x + (a.y - vertex.y) * u.y;
  const tB = (b.x - vertex.x) * u.x + (b.y - vertex.y) * u.y;
  const segmentEnd = Math.max(tA, tB);
  if (segmentEnd < 0) return null;
  if (radius <= segmentEnd + 1e-6) return null;
  return { a: add(vertex, scale(u, segmentEnd)), b: add(vertex, scale(u, radius)) };
}

function angleVertex(sketch: Sketch, l1Id: string, l2Id: string): MmPoint | null {
  const hit = lineIntersection(sketch, l1Id, l2Id);
  if (hit !== null) return hit.point;
  const l1 = sketch.entities.find((e) => e.id === l1Id);
  const l2 = sketch.entities.find((e) => e.id === l2Id);
  if (l1 === undefined || l1.kind !== 'line' || l2 === undefined || l2.kind !== 'line') return null;
  const pts = [l1.p1Id, l1.p2Id, l2.p1Id, l2.p2Id].map((id) => pointOf(sketch, id));
  return scale(pts.reduce((s, p) => add(s, p), { x: 0, y: 0 }), 1 / pts.length);
}

/** One boundary ray of an angle sector: its direction from the vertex, and
 * which of the two dimensioned lines it belongs to (so a witness extension
 * can be traced back to that line's own segment endpoints). */
interface SectorRay {
  angleDeg: number;
  lineId: string;
}

/**
 * The full sector (both boundary rays, magnitude, and the supplementary
 * flag) of whichever of the two lines' four quadrant sectors around their
 * intersection contains `target`: two intersecting lines split the plane
 * into four sectors bounded by their four rays (each line contributing two
 * opposite rays), alternating between a "direct fold" sector (the one
 * spanning the lines' own +d1/+d2 rays, the same value
 * measureAngleBetweenLines folds to from the stored point order) and its
 * supplementary sector (180 minus that). This is order-independent in each
 * line's own stored point order (both a ray and its opposite are always
 * candidates), unlike a naive "sweep from d1 to d2" would be, which is why
 * both the interactive cursor pick (angleForCursorSector) and the arc
 * renderer (dimensionGraphics's 'angle' case) route through this single
 * function (convention 10) rather than each re-deriving which sector a
 * point sits in: the renderer used to do its own a1/a2 sweep-and-flip and
 * would occasionally land on the wrong pair of (vertically opposite)
 * candidate sectors depending on which line stored the shared vertex as its
 * first vs second point. Returns null when the lines are parallel
 * (lineIntersection returns null).
 */
function angleSectorContaining(
  sketch: Sketch,
  l1Id: string,
  l2Id: string,
  target: MmPoint,
): { vertex: MmPoint; start: SectorRay; end: SectorRay; degrees: number; supplementary: boolean } | null {
  const hit = lineIntersection(sketch, l1Id, l2Id);
  if (hit === null) return null;
  const twoPi = 2 * Math.PI;
  const norm = (radians: number): number => ((radians % twoPi) + twoPi) % twoPi;
  const a1 = Math.atan2(hit.d1.y, hit.d1.x);
  const a2 = Math.atan2(hit.d2.y, hit.d2.x);
  // The direct-fold magnitude: the same value measureAngleBetweenLines
  // computes (raw a2-a1 difference, folded into [0, 180]), from the lines'
  // own stored +d1/+d2 rays without regard to which sector the target is in.
  const rawDiff = norm(a2 - a1);
  const directFoldDeg = ((rawDiff <= Math.PI ? rawDiff : twoPi - rawDiff) * 180) / Math.PI;
  const rays: SectorRay[] = [
    { angleDeg: norm(a1), lineId: l1Id },
    { angleDeg: norm(a1 + Math.PI), lineId: l1Id },
    { angleDeg: norm(a2), lineId: l2Id },
    { angleDeg: norm(a2 + Math.PI), lineId: l2Id },
  ].sort((x, y) => x.angleDeg - y.angleDeg);
  const targetAngle = norm(Math.atan2(target.y - hit.point.y, target.x - hit.point.x));
  for (let i = 0; i < 4; i += 1) {
    const start = rays[i];
    const endRayIndex = i === 3 ? 0 : i + 1;
    const endAngle = i === 3 ? rays[0].angleDeg + twoPi : rays[i + 1].angleDeg;
    const c = targetAngle >= start.angleDeg ? targetAngle : targetAngle + twoPi;
    if (c >= start.angleDeg && c <= endAngle + 1e-9) {
      const degrees = ((endAngle - start.angleDeg) * 180) / Math.PI;
      // The sector's magnitude always equals directFoldDeg or its
      // complement (180 - directFoldDeg), up to floating point; whichever
      // it lands closer to determines the flag robustly under that error.
      const supplementary =
        Math.abs(degrees - directFoldDeg) > Math.abs(degrees - (180 - directFoldDeg));
      return {
        vertex: hit.point,
        start: { angleDeg: (start.angleDeg * 180) / Math.PI, lineId: start.lineId },
        end: { angleDeg: (endAngle * 180) / Math.PI, lineId: rays[endRayIndex].lineId },
        degrees,
        supplementary,
      };
    }
  }
  // Unreachable: the four sorted rays always cover the full circle, so some
  // sector always contains the target angle.
  return null;
}

/**
 * The angle, in degrees, of whichever of the two lines' four quadrant
 * sectors around their intersection contains `cursor`, plus whether that
 * sector is the supplementary one (model.ts's AngleDimension.supplementary).
 * This is the angle-dimension's live quadrant pick (Fusion semantics: the
 * sector under the cursor is the one dimensioned, acute or supplementary as
 * that sector dictates), used both by the placement ghost preview and by
 * the store's commit path so both derive the same value (convention 10);
 * solve.ts uses the supplementary flag to convert the committed degrees
 * back into the correct directed solver target (see its derivation
 * comment). Returns null when the lines are parallel (lineIntersection
 * returns null; the caller falls back to its prior behavior of the fixed
 * 0..180 measured angle).
 */
export function angleForCursorSector(
  sketch: Sketch,
  l1Id: string,
  l2Id: string,
  cursor: MmPoint,
): { degrees: number; supplementary: boolean } | null {
  const sector = angleSectorContaining(sketch, l1Id, l2Id, cursor);
  return sector === null ? null : { degrees: sector.degrees, supplementary: sector.supplementary };
}

export interface ArrowheadGraphic {
  at: MmPoint;
  /** Direction the arrowhead points, in degrees (SVG rotate convention). */
  angleDeg: number;
}

export type DimensionGraphics =
  | {
      kind: 'linear';
      witnessLines: { a: MmPoint; b: MmPoint }[];
      dimensionLine: { a: MmPoint; b: MmPoint };
      arrowheads: ArrowheadGraphic[];
      textAt: MmPoint;
      text: string;
    }
  | {
      kind: 'angle';
      arcPath: string;
      /** Thin witness extensions (linear witness line style) from a
       * segment's nearest endpoint out to an arc end that lies beyond that
       * segment's physical extent (angle dimension rule 2), so the arc never
       * ends pointing at nothing. Empty when both arc ends land within their
       * segments' actual extent. */
      witnessLines: { a: MmPoint; b: MmPoint }[];
      arrowheads: ArrowheadGraphic[];
      textAt: MmPoint;
      text: string;
    }
  | {
      kind: 'leader';
      leaderLine: { a: MmPoint; b: MmPoint };
      arrowheads: ArrowheadGraphic[];
      textAt: MmPoint;
      text: string;
    };

/** Degrees of the direction from `from` to `to`. */
function angleDegOf(from: MmPoint, to: MmPoint): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/**
 * Graphics for an axis-flavored point-to-point distance (model.ts's
 * DistanceDimension.axis): the dimension line runs along the fixed axis
 * (horizontal for axis 'x', so it measures the x separation; vertical for
 * axis 'y') at the label's position on the other axis, with witness lines
 * dropped from each point onto it. The generic aligned-distance case above
 * offsets along the segment's own perpendicular instead; this is the H/V
 * counterpart to it.
 */
function axisDistanceGraphics(
  p1: MmPoint,
  p2: MmPoint,
  axis: 'x' | 'y',
  labelAt: MmPoint,
  text: string,
): DimensionGraphics {
  const d1 = axis === 'x' ? { x: p1.x, y: labelAt.y } : { x: labelAt.x, y: p1.y };
  const d2 = axis === 'x' ? { x: p2.x, y: labelAt.y } : { x: labelAt.x, y: p2.y };
  return {
    kind: 'linear',
    witnessLines: [
      { a: p1, b: d1 },
      { a: p2, b: d2 },
    ],
    dimensionLine: { a: d1, b: d2 },
    arrowheads: [
      { at: d1, angleDeg: angleDegOf(d2, d1) + 180 },
      { at: d2, angleDeg: angleDegOf(d1, d2) + 180 },
    ],
    textAt: labelAt,
    text,
  };
}

/**
 * The Fusion-style graphics primitives for one dimension, given the label
 * position it should be drawn at (the stored anchor + labelOffset, or a
 * placement ghost's live cursor position). `text` is pre-formatted by the
 * caller (formatMm/formatDegrees plus the R/D prefix), so this module has no
 * opinion on rounding or unit strings.
 */
export function dimensionGraphics(
  sketch: Sketch,
  dimension: SketchDimension,
  labelAt: MmPoint,
  text: string,
): DimensionGraphics | null {
  switch (dimension.kind) {
    case 'length':
    case 'distance':
    case 'pointLineDistance': {
      const [p1, p2] = ((): readonly [MmPoint | null, MmPoint | null] => {
        if (dimension.kind === 'length') {
          const line = sketch.entities.find((e) => e.id === dimension.lineId);
          if (line === undefined || line.kind !== 'line') return [null, null] as const;
          return [pointOf(sketch, line.p1Id), pointOf(sketch, line.p2Id)] as const;
        }
        if (dimension.kind === 'distance') {
          return [pointOf(sketch, dimension.p1Id), pointOf(sketch, dimension.p2Id)] as const;
        }
        const foot = pointLineFoot(sketch, dimension.pointId, dimension.lineId);
        if (foot === null) return [null, null] as const;
        return [pointOf(sketch, dimension.pointId), foot] as const;
      })();
      if (p1 === null || p2 === null) return null;
      if (dimension.kind === 'distance' && dimension.axis !== undefined) {
        return axisDistanceGraphics(p1, p2, dimension.axis, labelAt, text);
      }
      const u = normalize(sub(p2, p1));
      const n = perp(u);
      const mid = scale(add(p1, p2), 0.5);
      // Signed offset of the label off the p1-p2 line, along the normal.
      const offset = (labelAt.x - mid.x) * n.x + (labelAt.y - mid.y) * n.y;
      const d1 = add(p1, scale(n, offset));
      const d2 = add(p2, scale(n, offset));
      return {
        kind: 'linear',
        witnessLines: [
          { a: p1, b: d1 },
          { a: p2, b: d2 },
        ],
        dimensionLine: { a: d1, b: d2 },
        arrowheads: [
          { at: d1, angleDeg: angleDegOf(d2, d1) + 180 },
          { at: d2, angleDeg: angleDegOf(d1, d2) + 180 },
        ],
        textAt: labelAt,
        text,
      };
    }
    case 'radius':
    case 'diameter': {
      const entity = sketch.entities.find((e) => e.id === dimension.entityId);
      if (entity === undefined || (entity.kind !== 'arc' && entity.kind !== 'circle')) return null;
      const center = pointOf(sketch, entity.centerId);
      const radius =
        entity.kind === 'circle' ? entity.radiusMm : len(sub(pointOf(sketch, entity.startId), center));
      const dir = normalize(sub(labelAt, center));
      const onCurve = add(center, scale(dir, radius));
      return {
        kind: 'leader',
        leaderLine: { a: labelAt, b: onCurve },
        arrowheads: [{ at: onCurve, angleDeg: angleDegOf(labelAt, onCurve) }],
        textAt: labelAt,
        text,
      };
    }
    case 'angle': {
      // The sector whose label direction (from the vertex to labelAt)
      // matches Fusion's "arc follows the label": angleSectorContaining
      // picks among the true 4-way partition of the plane (order-
      // independent in each line's own stored point order), the same
      // function the interactive cursor pick (angleForCursorSector) uses,
      // so the arc always lands on the sector the label is actually placed
      // in (convention 10; this used to be a separate hand-rolled sweep
      // here that could pick the wrong pair of vertically-opposite sectors
      // depending on point order).
      const sector = angleSectorContaining(sketch, dimension.l1Id, dimension.l2Id, labelAt);
      if (sector === null) return null;
      const l1 = sketch.entities.find((e) => e.id === dimension.l1Id);
      const l2 = sketch.entities.find((e) => e.id === dimension.l2Id);
      if (l1 === undefined || l1.kind !== 'line' || l2 === undefined || l2.kind !== 'line') return null;
      const { vertex } = sector;
      const radius = Math.max(len(sub(labelAt, vertex)), 1e-6);
      const rayUnit = (deg: number): MmPoint => ({
        x: Math.cos((deg * Math.PI) / 180),
        y: Math.sin((deg * Math.PI) / 180),
      });
      const start = add(vertex, scale(rayUnit(sector.start.angleDeg), radius));
      const end = add(vertex, scale(rayUnit(sector.end.angleDeg), radius));
      // The 4-ray partition guarantees each sector spans at most 180
      // degrees, so the arc never needs the SVG large-arc flag.
      const arcPath = `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y}`;
      const mid = add(vertex, scale(rayUnit(sector.start.angleDeg + sector.degrees / 2), radius));
      const witnessLines: { a: MmPoint; b: MmPoint }[] = [];
      for (const ray of [sector.start, sector.end]) {
        const line = ray.lineId === l1.id ? l1 : l2;
        const witness = angleWitnessExtension(
          vertex, rayUnit(ray.angleDeg), pointOf(sketch, line.p1Id), pointOf(sketch, line.p2Id), radius,
        );
        if (witness !== null) witnessLines.push(witness);
      }
      return {
        kind: 'angle',
        arcPath,
        witnessLines,
        arrowheads: [
          { at: start, angleDeg: sector.start.angleDeg + 90 },
          { at: end, angleDeg: sector.end.angleDeg - 90 },
        ],
        textAt: mid,
        text,
      };
    }
    default:
      return assertNever(dimension);
  }
}
