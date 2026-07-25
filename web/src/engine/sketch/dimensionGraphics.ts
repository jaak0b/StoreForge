// Computes Fusion-360-style dimension graphics primitives (witness lines,
// dimension line, arrowheads, leader lines, arc sweeps) for a dimension
// constraint, in sketch mm coordinates. Framework-agnostic (convention 3):
// no Vue, no DOM. SketchCanvas.vue is the only renderer, and the placement
// ghost preview reuses the exact same functions so the preview never
// promises a shape the commit would not actually draw (convention 10).
import type { MmPoint } from '../trace/types';
import type { LabelOffset, Sketch, SketchDimension } from './model';
import { assertNever } from '../plan/types';

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

function angleVertex(sketch: Sketch, l1Id: string, l2Id: string): MmPoint | null {
  const hit = lineIntersection(sketch, l1Id, l2Id);
  if (hit !== null) return hit.point;
  const l1 = sketch.entities.find((e) => e.id === l1Id);
  const l2 = sketch.entities.find((e) => e.id === l2Id);
  if (l1 === undefined || l1.kind !== 'line' || l2 === undefined || l2.kind !== 'line') return null;
  const pts = [l1.p1Id, l1.p2Id, l2.p1Id, l2.p2Id].map((id) => pointOf(sketch, id));
  return scale(pts.reduce((s, p) => add(s, p), { x: 0, y: 0 }), 1 / pts.length);
}

/**
 * The angle, in degrees, of whichever of the two lines' four quadrant
 * sectors around their intersection contains `cursor`, plus whether that
 * sector is the supplementary one (model.ts's AngleDimension.supplementary):
 * two intersecting lines split the plane into four sectors bounded by their
 * four rays (each line contributing two opposite rays), alternating between
 * a "direct fold" sector (the one spanning the lines' own +d1/+d2 rays, the
 * same value measureAngleBetweenLines folds to from the stored point order)
 * and its supplementary sector (180 minus that). This is the angle-
 * dimension's live quadrant pick (Fusion semantics: the sector under the
 * cursor is the one dimensioned, acute or supplementary as that sector
 * dictates), used both by the placement ghost preview and by the store's
 * commit path so both derive the same value (convention 10); solve.ts uses
 * the supplementary flag to convert the committed degrees back into the
 * correct directed solver target (see its derivation comment). Returns null
 * when the lines are parallel (lineIntersection returns null; the caller
 * falls back to its prior behavior of the fixed 0..180 measured angle).
 */
export function angleForCursorSector(
  sketch: Sketch,
  l1Id: string,
  l2Id: string,
  cursor: MmPoint,
): { degrees: number; supplementary: boolean } | null {
  const hit = lineIntersection(sketch, l1Id, l2Id);
  if (hit === null) return null;
  const twoPi = 2 * Math.PI;
  const norm = (radians: number): number => ((radians % twoPi) + twoPi) % twoPi;
  const a1 = Math.atan2(hit.d1.y, hit.d1.x);
  const a2 = Math.atan2(hit.d2.y, hit.d2.x);
  // The direct-fold magnitude: the same value measureAngleBetweenLines
  // computes (raw a2-a1 difference, folded into [0, 180]), from the lines'
  // own stored +d1/+d2 rays without regard to which sector the cursor is in.
  const rawDiff = norm(a2 - a1);
  const directFoldDeg = ((rawDiff <= Math.PI ? rawDiff : twoPi - rawDiff) * 180) / Math.PI;
  const rays = [norm(a1), norm(a1 + Math.PI), norm(a2), norm(a2 + Math.PI)].sort((x, y) => x - y);
  const cursorAngle = norm(Math.atan2(cursor.y - hit.point.y, cursor.x - hit.point.x));
  for (let i = 0; i < 4; i += 1) {
    const start = rays[i];
    const end = i === 3 ? rays[0] + 2 * Math.PI : rays[i + 1];
    const c = cursorAngle >= start ? cursorAngle : cursorAngle + 2 * Math.PI;
    if (c >= start && c <= end + 1e-9) {
      const degrees = ((end - start) * 180) / Math.PI;
      // The sector's magnitude always equals directFoldDeg or its
      // complement (180 - directFoldDeg), up to floating point; whichever
      // it lands closer to determines the flag robustly under that error.
      const supplementary =
        Math.abs(degrees - directFoldDeg) > Math.abs(degrees - (180 - directFoldDeg));
      return { degrees, supplementary };
    }
  }
  // Unreachable: the four sorted rays always cover the full circle, so some
  // sector always contains the cursor angle.
  return null;
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
      const hit = lineIntersection(sketch, dimension.l1Id, dimension.l2Id);
      const vertex = hit?.point ?? angleVertex(sketch, dimension.l1Id, dimension.l2Id);
      if (vertex === null || vertex === undefined || hit === null) return null;
      const radius = Math.max(len(sub(labelAt, vertex)), 1e-6);
      let a1 = angleDegOf({ x: 0, y: 0 }, hit.d1);
      let a2 = angleDegOf({ x: 0, y: 0 }, hit.d2);
      // Sweep from a1 to a2 the short way; then rotate the whole sweep, if
      // needed, so it passes through the labelAt side (the direction from
      // vertex to labelAt), matching Fusion's "arc follows the label".
      const labelDeg = angleDegOf(vertex, labelAt);
      const norm = (d: number) => ((d % 360) + 360) % 360;
      let delta = norm(a2 - a1);
      if (delta > 180) {
        [a1, a2] = [a2, a1];
        delta = 360 - delta;
      }
      // If the label sits outside the [a1, a2] sweep, use the reflex lines'
      // opposite rays instead (the other pair of vertical-angle rays), so the
      // arc is drawn on the side the user is actually pointing at.
      const within = (() => {
        const rel = norm(labelDeg - a1);
        return rel <= delta + 1e-6;
      })();
      if (!within) {
        a1 += 180;
        a2 += 180;
      }
      const start = add(vertex, scale({ x: Math.cos((a1 * Math.PI) / 180), y: Math.sin((a1 * Math.PI) / 180) }, radius));
      const end = add(vertex, scale({ x: Math.cos((a2 * Math.PI) / 180), y: Math.sin((a2 * Math.PI) / 180) }, radius));
      const large = delta > 180 ? 1 : 0;
      const arcPath = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
      const mid = add(
        vertex,
        scale(
          {
            x: Math.cos(((a1 + delta / 2) * Math.PI) / 180),
            y: Math.sin(((a1 + delta / 2) * Math.PI) / 180),
          },
          radius,
        ),
      );
      return {
        kind: 'angle',
        arcPath,
        arrowheads: [
          { at: start, angleDeg: a1 + 90 },
          { at: end, angleDeg: a2 - 90 },
        ],
        textAt: mid,
        text,
      };
    }
    default:
      return assertNever(dimension);
  }
}
