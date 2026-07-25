// The parametric 2D sketch datatype of the sketch workspace. Plain JSON
// throughout so a sketch serializes inside a plan file. All coordinates are
// millimeters in the trace frame (y increasing downward). The sketch carries
// its own schema version so the format can evolve without a plan version
// bump each time.
import type { MmPoint } from '../trace/types';
import { assertNever } from '../plan/types';

export const SKETCH_SCHEMA_VERSION = 1;

/** A sketch point, the only entity carrying coordinates. */
export interface SketchPoint {
  kind: 'point';
  id: string;
  x: number;
  y: number;
  construction: boolean;
}

/** A line segment between two sketch points. */
export interface SketchLine {
  kind: 'line';
  id: string;
  p1Id: string;
  p2Id: string;
  construction: boolean;
}

/**
 * A circular arc running counterclockwise (in the y-down mm frame) from the
 * start point to the end point about the center point. Radius and angles are
 * deliberately not stored: they are derived from the three points when the
 * solver needs them, so there is a single source for the arc's shape.
 */
export interface SketchArc {
  kind: 'arc';
  id: string;
  centerId: string;
  startId: string;
  endId: string;
  construction: boolean;
}

/** A full circle about a center point. */
export interface SketchCircle {
  kind: 'circle';
  id: string;
  centerId: string;
  radiusMm: number;
  construction: boolean;
}

export type SketchEntity = SketchPoint | SketchLine | SketchArc | SketchCircle;

export interface CoincidentConstraint {
  kind: 'coincident';
  id: string;
  p1Id: string;
  p2Id: string;
}
export interface HorizontalConstraint {
  kind: 'horizontal';
  id: string;
  lineId: string;
}
export interface VerticalConstraint {
  kind: 'vertical';
  id: string;
  lineId: string;
}
export interface ParallelConstraint {
  kind: 'parallel';
  id: string;
  l1Id: string;
  l2Id: string;
}
export interface PerpendicularConstraint {
  kind: 'perpendicular';
  id: string;
  l1Id: string;
  l2Id: string;
}
/** Tangency between a line, arc or circle pair; at most one side may be a line. */
export interface TangentConstraint {
  kind: 'tangent';
  id: string;
  aId: string;
  bId: string;
}
/** Two points mirrored across a line (usually a construction line). */
export interface SymmetricConstraint {
  kind: 'symmetric';
  id: string;
  p1Id: string;
  p2Id: string;
  mirrorLineId: string;
}
/**
 * Where a dimension's label is drawn, as a millimeter offset from that
 * dimension kind's anchor point (documented per kind below since each kind
 * anchors somewhere different): length/distance anchor at the midpoint of
 * the two measured points, radius/diameter anchor at the curve's center,
 * angle anchor at the two lines' intersection point (or, when the lines are
 * parallel and never meet, the midpoint of their four endpoints). Optional
 * so an older sketch without a placed label still deserializes; the renderer
 * falls back to a small default offset when absent. Set once when the
 * dimension is placed (dimensionGraphics.ts / SketchWorkspace's placement
 * click) and afterward only by dragging the label (sketchEditor's
 * updateLabelOffset), never by the solver.
 */
export interface LabelOffset {
  x: number;
  y: number;
}
/**
 * True for a dimension that reports a measured value but never constrains
 * the geometry: PlaneGCS receives it with `driving: false` (solve.ts), and
 * after each solve its value is overwritten from the solved geometry
 * (measure.ts's updateDrivenDimensions) rather than the solver moving
 * geometry to match a typed value. Optional and defaulting to false/absent
 * (an ordinary driving dimension) so existing sketches deserialize unchanged.
 */
export interface LengthDimension {
  kind: 'length';
  id: string;
  lineId: string;
  mm: number;
  labelOffset?: LabelOffset;
  driven?: boolean;
}
/**
 * When set, the dimension measures only the x ('x') or y ('y') separation
 * between the two points (a Fusion-style horizontal or vertical dimension)
 * instead of the true point-to-point distance; the flavor is picked live
 * from the cursor while the dimension is placed (dimensionSelection.ts's
 * pickDistanceAxis) and then fixed at commit. Absent means the ordinary
 * aligned (Euclidean) distance, so existing sketches deserialize unchanged.
 */
export interface DistanceDimension {
  kind: 'distance';
  id: string;
  p1Id: string;
  p2Id: string;
  mm: number;
  axis?: 'x' | 'y';
  labelOffset?: LabelOffset;
  driven?: boolean;
}
export interface RadiusDimension {
  kind: 'radius';
  id: string;
  entityId: string;
  mm: number;
  labelOffset?: LabelOffset;
  driven?: boolean;
}
export interface DiameterDimension {
  kind: 'diameter';
  id: string;
  entityId: string;
  mm: number;
  labelOffset?: LabelOffset;
  driven?: boolean;
}
export interface AngleDimension {
  kind: 'angle';
  id: string;
  l1Id: string;
  l2Id: string;
  degrees: number;
  labelOffset?: LabelOffset;
  driven?: boolean;
}
/**
 * The perpendicular distance from a point to a line (PlaneGCS p2l_distance),
 * for pairs that a plain point-to-point distance cannot express: a point and
 * a line, two parallel lines (endpoint of one to the other), or a line and a
 * curve's center (see dimensionSelection.ts's pair resolution).
 */
export interface PointLineDistanceDimension {
  kind: 'pointLineDistance';
  id: string;
  pointId: string;
  lineId: string;
  mm: number;
  labelOffset?: LabelOffset;
  driven?: boolean;
}

export type SketchConstraint =
  | CoincidentConstraint
  | HorizontalConstraint
  | VerticalConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | TangentConstraint
  | SymmetricConstraint
  | LengthDimension
  | DistanceDimension
  | RadiusDimension
  | DiameterDimension
  | AngleDimension
  | PointLineDistanceDimension;

/** The dimension subset of the constraints, for the click-to-edit labels. */
export type SketchDimension =
  | LengthDimension
  | DistanceDimension
  | RadiusDimension
  | DiameterDimension
  | AngleDimension
  | PointLineDistanceDimension;

export interface Sketch {
  schemaVersion: number;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

/** An empty sketch at the current schema version. */
export function emptySketch(): Sketch {
  return { schemaVersion: SKETCH_SCHEMA_VERSION, entities: [], constraints: [] };
}

/** Deep copy through JSON; a Sketch is plain JSON by construction. */
export function cloneSketch(sketch: Sketch): Sketch {
  return JSON.parse(JSON.stringify(sketch)) as Sketch;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** True when `value` is either absent (an older sketch with no placed
 * label) or a finite mm point, the labelOffset field's validation. */
function isValidLabelOffset(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return isFiniteNumber(o.x) && isFiniteNumber(o.y);
}

/** True when `value` is either absent (an ordinary driving dimension) or a
 * boolean, the `driven` field's validation. */
function isValidDriven(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/** True when `value` is either absent (the ordinary aligned distance) or
 * exactly 'x' or 'y', the distance dimension's `axis` field's validation. */
function isValidAxis(value: unknown): boolean {
  return value === undefined || value === 'x' || value === 'y';
}

/**
 * Validates a raw value as a Sketch. Returns null when valid, otherwise one
 * user-worded sentence prefixed with the given subject, following the plan
 * file's validation message convention.
 */
export function validateSketch(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: The sketch must be an object.`;
  }
  const sketch = raw as Record<string, unknown>;
  if (sketch.schemaVersion !== SKETCH_SCHEMA_VERSION) {
    return (
      `${subject}: The sketch has schema version ${String(sketch.schemaVersion)}, ` +
      `but this app reads version ${SKETCH_SCHEMA_VERSION}.`
    );
  }
  if (!Array.isArray(sketch.entities)) {
    return `${subject}: The entities must be a list.`;
  }
  if (!Array.isArray(sketch.constraints)) {
    return `${subject}: The constraints must be a list.`;
  }
  const kinds = new Map<string, SketchEntity['kind']>();
  for (const rawEntity of sketch.entities) {
    if (typeof rawEntity !== 'object' || rawEntity === null || Array.isArray(rawEntity)) {
      return `${subject}: A sketch entity is not an object.`;
    }
    const entity = rawEntity as Record<string, unknown>;
    if (!isId(entity.id)) {
      return `${subject}: A sketch entity is missing its id.`;
    }
    if (kinds.has(entity.id)) {
      return `${subject}: The sketch id ${entity.id} appears twice.`;
    }
    if (typeof entity.construction !== 'boolean') {
      return `${subject}: The entity ${entity.id} is missing its construction flag.`;
    }
    const kind = entity.kind as SketchEntity['kind'];
    switch (kind) {
      case 'point':
        if (!isFiniteNumber(entity.x) || !isFiniteNumber(entity.y)) {
          return `${subject}: The point ${entity.id} needs finite x and y coordinates in mm.`;
        }
        break;
      case 'line':
        if (!isId(entity.p1Id) || !isId(entity.p2Id)) {
          return `${subject}: The line ${entity.id} must connect two sketch points.`;
        }
        break;
      case 'arc':
        if (!isId(entity.centerId) || !isId(entity.startId) || !isId(entity.endId)) {
          return `${subject}: The arc ${entity.id} needs a center, a start and an end point.`;
        }
        break;
      case 'circle':
        if (!isId(entity.centerId)) {
          return `${subject}: The circle ${entity.id} needs a center point.`;
        }
        if (!isFiniteNumber(entity.radiusMm) || entity.radiusMm <= 0) {
          return `${subject}: The circle ${entity.id} needs a radius above 0 mm.`;
        }
        break;
      default:
        return `${subject}: The entity kind must be point, line, arc or circle.`;
    }
    kinds.set(entity.id, kind);
  }
  const isPoint = (id: unknown): boolean => isId(id) && kinds.get(id) === 'point';
  const isLine = (id: unknown): boolean => isId(id) && kinds.get(id) === 'line';
  const isCurveOrCircle = (id: unknown): boolean =>
    isId(id) && (kinds.get(id) === 'arc' || kinds.get(id) === 'circle');
  // Second pass: entity references resolve to the right kinds.
  for (const entity of sketch.entities as Record<string, unknown>[]) {
    const kind = entity.kind as SketchEntity['kind'];
    switch (kind) {
      case 'point':
        break;
      case 'line':
        if (!isPoint(entity.p1Id) || !isPoint(entity.p2Id)) {
          return `${subject}: The line ${entity.id} must connect two sketch points.`;
        }
        break;
      case 'arc':
        if (!isPoint(entity.centerId) || !isPoint(entity.startId) || !isPoint(entity.endId)) {
          return `${subject}: The arc ${entity.id} needs a center, a start and an end point.`;
        }
        break;
      case 'circle':
        if (!isPoint(entity.centerId)) {
          return `${subject}: The circle ${entity.id} needs a center point.`;
        }
        break;
      default:
        return assertNever(kind);
    }
  }
  const constraintIds = new Set<string>();
  for (const rawConstraint of sketch.constraints) {
    if (
      typeof rawConstraint !== 'object' ||
      rawConstraint === null ||
      Array.isArray(rawConstraint)
    ) {
      return `${subject}: A sketch constraint is not an object.`;
    }
    const c = rawConstraint as Record<string, unknown>;
    if (!isId(c.id)) {
      return `${subject}: A sketch constraint is missing its id.`;
    }
    if (constraintIds.has(c.id) || kinds.has(c.id)) {
      return `${subject}: The sketch id ${c.id} appears twice.`;
    }
    constraintIds.add(c.id);
    const missing = `${subject}: The constraint ${c.id} refers to geometry that is not in the sketch.`;
    const kind = c.kind as SketchConstraint['kind'];
    switch (kind) {
      case 'coincident':
        if (!kinds.has(c.p1Id as string) || !kinds.has(c.p2Id as string)) return missing;
        if (!isPoint(c.p1Id) || !isPoint(c.p2Id)) {
          return `${subject}: The coincident constraint ${c.id} needs two points.`;
        }
        break;
      case 'horizontal':
      case 'vertical':
        if (!kinds.has(c.lineId as string)) return missing;
        if (!isLine(c.lineId)) {
          return `${subject}: The ${kind} constraint ${c.id} needs a line.`;
        }
        break;
      case 'parallel':
      case 'perpendicular':
        if (!kinds.has(c.l1Id as string) || !kinds.has(c.l2Id as string)) return missing;
        if (!isLine(c.l1Id) || !isLine(c.l2Id)) {
          return `${subject}: The ${kind} constraint ${c.id} needs two lines.`;
        }
        break;
      case 'tangent': {
        if (!kinds.has(c.aId as string) || !kinds.has(c.bId as string)) return missing;
        const aCurve = isCurveOrCircle(c.aId);
        const bCurve = isCurveOrCircle(c.bId);
        const aLine = isLine(c.aId);
        const bLine = isLine(c.bId);
        if (!((aCurve && (bCurve || bLine)) || (aLine && bCurve))) {
          return `${subject}: The tangent constraint ${c.id} needs an arc or circle on at least one side.`;
        }
        break;
      }
      case 'symmetric':
        if (
          !kinds.has(c.p1Id as string) ||
          !kinds.has(c.p2Id as string) ||
          !kinds.has(c.mirrorLineId as string)
        ) {
          return missing;
        }
        if (!isPoint(c.p1Id) || !isPoint(c.p2Id) || !isLine(c.mirrorLineId)) {
          return `${subject}: The symmetric constraint ${c.id} needs two points and a mirror line.`;
        }
        break;
      case 'length':
        if (!kinds.has(c.lineId as string)) return missing;
        if (!isLine(c.lineId)) {
          return `${subject}: The length constraint ${c.id} needs a line.`;
        }
        if (!isFiniteNumber(c.mm) || c.mm <= 0) {
          return `${subject}: The length constraint ${c.id} needs a value above 0 mm.`;
        }
        if (!isValidLabelOffset(c.labelOffset)) {
          return `${subject}: The length constraint ${c.id}'s label offset must be a finite mm point.`;
        }
        if (!isValidDriven(c.driven)) {
          return `${subject}: The length constraint ${c.id}'s driven flag must be true or false.`;
        }
        break;
      case 'distance':
        if (!kinds.has(c.p1Id as string) || !kinds.has(c.p2Id as string)) return missing;
        if (!isPoint(c.p1Id) || !isPoint(c.p2Id)) {
          return `${subject}: The distance constraint ${c.id} needs two points.`;
        }
        if (!isFiniteNumber(c.mm) || c.mm <= 0) {
          return `${subject}: The distance constraint ${c.id} needs a value above 0 mm.`;
        }
        if (!isValidAxis(c.axis)) {
          return `${subject}: The distance constraint ${c.id}'s axis must be x or y.`;
        }
        if (!isValidLabelOffset(c.labelOffset)) {
          return `${subject}: The distance constraint ${c.id}'s label offset must be a finite mm point.`;
        }
        if (!isValidDriven(c.driven)) {
          return `${subject}: The distance constraint ${c.id}'s driven flag must be true or false.`;
        }
        break;
      case 'radius':
      case 'diameter':
        if (!kinds.has(c.entityId as string)) return missing;
        if (!isCurveOrCircle(c.entityId)) {
          return `${subject}: The ${kind} constraint ${c.id} needs an arc or a circle.`;
        }
        if (!isFiniteNumber(c.mm) || c.mm <= 0) {
          return `${subject}: The ${kind} constraint ${c.id} needs a value above 0 mm.`;
        }
        if (!isValidLabelOffset(c.labelOffset)) {
          return `${subject}: The ${kind} constraint ${c.id}'s label offset must be a finite mm point.`;
        }
        if (!isValidDriven(c.driven)) {
          return `${subject}: The ${kind} constraint ${c.id}'s driven flag must be true or false.`;
        }
        break;
      case 'angle':
        if (!kinds.has(c.l1Id as string) || !kinds.has(c.l2Id as string)) return missing;
        if (!isLine(c.l1Id) || !isLine(c.l2Id)) {
          return `${subject}: The angle constraint ${c.id} needs two lines.`;
        }
        if (!isFiniteNumber(c.degrees)) {
          return `${subject}: The angle constraint ${c.id} needs a finite angle in degrees.`;
        }
        if (!isValidLabelOffset(c.labelOffset)) {
          return `${subject}: The angle constraint ${c.id}'s label offset must be a finite mm point.`;
        }
        if (!isValidDriven(c.driven)) {
          return `${subject}: The angle constraint ${c.id}'s driven flag must be true or false.`;
        }
        break;
      case 'pointLineDistance':
        if (!kinds.has(c.pointId as string) || !kinds.has(c.lineId as string)) return missing;
        if (!isPoint(c.pointId) || !isLine(c.lineId)) {
          return `${subject}: The point-line distance constraint ${c.id} needs a point and a line.`;
        }
        if (!isFiniteNumber(c.mm) || c.mm <= 0) {
          return `${subject}: The point-line distance constraint ${c.id} needs a value above 0 mm.`;
        }
        if (!isValidLabelOffset(c.labelOffset)) {
          return `${subject}: The point-line distance constraint ${c.id}'s label offset must be a finite mm point.`;
        }
        if (!isValidDriven(c.driven)) {
          return `${subject}: The point-line distance constraint ${c.id}'s driven flag must be true or false.`;
        }
        break;
      default:
        return `${subject}: The constraint kind of ${c.id} is not one this app knows.`;
    }
  }
  return null;
}

/** Result of reading a sketch from untrusted JSON. */
export type SketchParseResult =
  | { ok: true; sketch: Sketch }
  | { ok: false; error: string };

/**
 * Validates and deep-copies a raw value into a Sketch, so an imported plan
 * cannot smuggle extra fields into memory. The copy is field-by-field via the
 * validated shape; validateSketch has already proven every field.
 */
export function deserializeSketch(raw: unknown): SketchParseResult {
  const problem = validateSketch(raw, 'sketch');
  if (problem !== null) return { ok: false, error: problem };
  const source = raw as Sketch;
  const entities: SketchEntity[] = source.entities.map((e) => {
    switch (e.kind) {
      case 'point':
        return { kind: 'point', id: e.id, x: e.x, y: e.y, construction: e.construction };
      case 'line':
        return { kind: 'line', id: e.id, p1Id: e.p1Id, p2Id: e.p2Id, construction: e.construction };
      case 'arc':
        return {
          kind: 'arc',
          id: e.id,
          centerId: e.centerId,
          startId: e.startId,
          endId: e.endId,
          construction: e.construction,
        };
      case 'circle':
        return {
          kind: 'circle',
          id: e.id,
          centerId: e.centerId,
          radiusMm: e.radiusMm,
          construction: e.construction,
        };
      default:
        return assertNever(e);
    }
  });
  const constraints: SketchConstraint[] = source.constraints.map((c) => {
    switch (c.kind) {
      case 'coincident':
        return { kind: 'coincident', id: c.id, p1Id: c.p1Id, p2Id: c.p2Id };
      case 'horizontal':
        return { kind: 'horizontal', id: c.id, lineId: c.lineId };
      case 'vertical':
        return { kind: 'vertical', id: c.id, lineId: c.lineId };
      case 'parallel':
        return { kind: 'parallel', id: c.id, l1Id: c.l1Id, l2Id: c.l2Id };
      case 'perpendicular':
        return { kind: 'perpendicular', id: c.id, l1Id: c.l1Id, l2Id: c.l2Id };
      case 'tangent':
        return { kind: 'tangent', id: c.id, aId: c.aId, bId: c.bId };
      case 'symmetric':
        return {
          kind: 'symmetric',
          id: c.id,
          p1Id: c.p1Id,
          p2Id: c.p2Id,
          mirrorLineId: c.mirrorLineId,
        };
      case 'length':
        return {
          kind: 'length', id: c.id, lineId: c.lineId, mm: c.mm, labelOffset: c.labelOffset,
          driven: c.driven,
        };
      case 'distance':
        return {
          kind: 'distance', id: c.id, p1Id: c.p1Id, p2Id: c.p2Id, mm: c.mm, axis: c.axis,
          labelOffset: c.labelOffset, driven: c.driven,
        };
      case 'radius':
        return {
          kind: 'radius', id: c.id, entityId: c.entityId, mm: c.mm, labelOffset: c.labelOffset,
          driven: c.driven,
        };
      case 'diameter':
        return {
          kind: 'diameter', id: c.id, entityId: c.entityId, mm: c.mm, labelOffset: c.labelOffset,
          driven: c.driven,
        };
      case 'angle':
        return {
          kind: 'angle', id: c.id, l1Id: c.l1Id, l2Id: c.l2Id, degrees: c.degrees,
          labelOffset: c.labelOffset, driven: c.driven,
        };
      case 'pointLineDistance':
        return {
          kind: 'pointLineDistance', id: c.id, pointId: c.pointId, lineId: c.lineId, mm: c.mm,
          labelOffset: c.labelOffset, driven: c.driven,
        };
      default:
        return assertNever(c);
    }
  });
  return {
    ok: true,
    sketch: { schemaVersion: SKETCH_SCHEMA_VERSION, entities, constraints },
  };
}

/**
 * Center and orientation of the circle through three points, by the standard
 * circumcenter formula (perpendicular bisector intersection). Returns null
 * for (near-)collinear points. ccw refers to the mathematical orientation in
 * the y-down mm frame: the cross product (mid-start) x (end-start) positive.
 */
export function arcFromThreePoints(
  start: MmPoint,
  mid: MmPoint,
  end: MmPoint,
): { center: MmPoint; ccw: boolean } | null {
  const ax = start.x;
  const ay = start.y;
  const bx = mid.x;
  const by = mid.y;
  const cx = end.x;
  const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d;
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return { center: { x: ux, y: uy }, ccw: cross > 0 };
}

/**
 * The unit tangent direction at `endpoint`, pointing away from the segment
 * (the direction a chain continuing from that endpoint would travel), for a
 * line or arc identified by `segmentId`. Shared by the tangent-arc tool's
 * commit (the store's addThreePointArc, called with tangent=true) and its
 * ghost preview (SketchCanvas), so both read the same "which way does this
 * chain continue" answer. Returns null when the segment or its points are
 * missing, or (for an arc) the endpoint sits on the center (zero radius).
 */
export function tangentDirectionAtPoint(
  sketch: Sketch,
  segmentId: string,
  endpointId: string,
): { ux: number; uy: number } | null {
  const segment = sketch.entities.find((e) => e.id === segmentId);
  if (segment === undefined) return null;
  const pointOf = (id: string): MmPoint | null => {
    const p = sketch.entities.find((e) => e.id === id);
    return p !== undefined && p.kind === 'point' ? { x: p.x, y: p.y } : null;
  };
  const endpoint = pointOf(endpointId);
  if (endpoint === null) return null;
  if (segment.kind === 'line') {
    const otherId = segment.p1Id === endpointId ? segment.p2Id : segment.p1Id;
    const other = pointOf(otherId);
    if (other === null) return null;
    const dx = endpoint.x - other.x;
    const dy = endpoint.y - other.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    return { ux: dx / len, uy: dy / len };
  }
  if (segment.kind === 'arc') {
    const center = pointOf(segment.centerId);
    if (center === null) return null;
    const rx = endpoint.x - center.x;
    const ry = endpoint.y - center.y;
    const r = Math.hypot(rx, ry);
    if (r < 1e-9) return null;
    // The arc is stored counterclockwise from start to end (y-down frame);
    // the tangent direction of travel at either endpoint is the radius
    // vector rotated 90 degrees in the direction of travel. At the end
    // point that is +90 degrees (ccw); at the start point, travelling
    // backward along the arc from the chain's perspective, it is -90.
    const sign = segment.endId === endpointId ? 1 : -1;
    return { ux: (-ry / r) * sign, uy: (rx / r) * sign };
  }
  return null;
}

/**
 * Center and orientation of the arc that starts at `start` tangent to
 * `tangentDir` and passes through `end`, by the standard tangent-arc
 * construction: the center lies on the line through `start` perpendicular to
 * the tangent direction, equidistant from `start` and `end`. Returns null
 * when `end` coincides with `start` (any radius would fit) or the tangent
 * direction is degenerate.
 */
export function arcTangentToPoint(
  start: MmPoint,
  tangentDir: { ux: number; uy: number },
  end: MmPoint,
): { center: MmPoint; ccw: boolean } | null {
  const tLen = Math.hypot(tangentDir.ux, tangentDir.uy);
  if (tLen < 1e-9) return null;
  const ux = tangentDir.ux / tLen;
  const uy = tangentDir.uy / tLen;
  // Normal to the tangent direction, defining the line the center sits on.
  const nx = -uy;
  const ny = ux;
  const dx = start.x - end.x;
  const dy = start.y - end.y;
  const denom = 2 * (nx * dx + ny * dy);
  if (Math.abs(denom) < 1e-9) return null;
  const t = -(dx * dx + dy * dy) / denom;
  const center = { x: start.x + nx * t, y: start.y + ny * t };
  const cross = (end.x - start.x) * uy - (end.y - start.y) * ux;
  return { center, ccw: cross < 0 };
}
