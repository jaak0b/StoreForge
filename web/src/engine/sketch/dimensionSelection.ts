// Resolves what dimension kind (if any) a sketch selection produces for the
// dimension tool, matching Fusion 360's pair semantics: one line is a
// length, an arc or circle is a radius, two points are a distance, two
// non-parallel lines are an angle. A point and a line, two parallel lines
// (endpoint of the first to the second), a line and a curve (its center to
// the line), or a circle and a point/circle (center to center) all resolve
// to a point-line distance or a plain distance, per the owner-approved spec
// below. Kept in the engine (framework agnostic, convention 3) so
// SketchWorkspace.vue only wires this into the click handler rather than
// re-deriving the pair rules inline.
import type { LabelOffset, Sketch, SketchDimension, SketchEntity } from './model';
import type { MmPoint } from '../trace/types';
import { assertNever } from '../plan/types';
import { angleForCursorSector, dimensionAnchor } from './dimensionGraphics';
import {
  measureAngleBetweenLines,
  measureDiameter,
  measureLineLength,
  measurePointAxisDistance,
  measurePointDistance,
  measurePointLineDistance,
  measureRadius,
} from './measure';

/** The band, in degrees off the segment's own direction, within which a
 * point-point distance placement is treated as an aligned (true) distance
 * rather than an axis-flavored one: a live placement heuristic (like
 * autoInfer.ts's snap band), not a measurement-pipeline tolerance
 * (convention 12 governs the latter, not this). */
const DISTANCE_AXIS_ALIGNED_BAND_DEG = 20;

function pointOf(sketch: Sketch, id: string): MmPoint {
  const e = sketch.entities.find((x) => x.id === id);
  return e !== undefined && e.kind === 'point' ? { x: e.x, y: e.y } : { x: 0, y: 0 };
}

/**
 * The H/V/aligned flavor a point-to-point distance placement resolves to,
 * live, from the cursor's offset off the two points' midpoint (Fusion 360's
 * point-point dimension semantics): when the cursor's offset direction sits
 * within DISTANCE_AXIS_ALIGNED_BAND_DEG of the segment's own direction, the
 * dimension is the true aligned distance (undefined axis, no witness
 * H/V flavor); otherwise the offset's dominant component picks the flavor
 * for the perpendicular case: an offset displaced mostly along y (away
 * across the segment's own direction) yields the horizontal (x) dimension,
 * and one displaced mostly along x yields the vertical (y) dimension.
 * Degenerate inputs (coincident points, or the cursor sitting exactly on the
 * midpoint) fall back to the aligned distance.
 */
export function pickDistanceAxis(
  sketch: Sketch,
  p1Id: string,
  p2Id: string,
  cursor: MmPoint,
): 'x' | 'y' | undefined {
  const p1 = pointOf(sketch, p1Id);
  const p2 = pointOf(sketch, p2Id);
  const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dx = cursor.x - mid.x;
  const dy = cursor.y - mid.y;
  const offsetLen = Math.hypot(dx, dy);
  if (segLen < 1e-9 || offsetLen < 1e-9) return undefined;
  const ux = (p2.x - p1.x) / segLen;
  const uy = (p2.y - p1.y) / segLen;
  const alongSegment = Math.abs(dx * ux + dy * uy);
  const angleFromSegmentDeg = (Math.acos(Math.min(1, alongSegment / offsetLen)) * 180) / Math.PI;
  if (angleFromSegmentDeg <= DISTANCE_AXIS_ALIGNED_BAND_DEG) return undefined;
  return Math.abs(dy) > Math.abs(dx) ? 'x' : 'y';
}

export type DimensionSelectionKind =
  | { kind: 'length'; lineId: string }
  | { kind: 'distance'; p1Id: string; p2Id: string }
  | { kind: 'radiusOrDiameter'; entityId: string }
  | { kind: 'angle'; l1Id: string; l2Id: string }
  | { kind: 'pointLineDistance'; pointId: string; lineId: string };

export interface DimensionSelectionResult {
  /** The dimension the selection resolves to, or null when the selection is
   * incomplete or inapplicable (see hint for why). */
  resolved: DimensionSelectionKind | null;
  /** A one-line, complete-sentence hint for the toolbar's hint row, shown
   * whenever resolved is null. */
  hint: string;
}

const SELECT_HINT =
  'Select one line for a length, an arc or circle for a radius, two points for a distance, ' +
  'a point and a line for a point-line distance, or two non-parallel lines for an angle.';

/** The angle, in degrees folded to 0..90, between two lines' direction
 * vectors: 0 for parallel or anti-parallel lines. Reused by the parallel
 * check below rather than re-deriving trig already in measure.ts, since that
 * function folds to 0..180 for the angle dimension's own convention. */
function acuteAngleBetween(sketch: Sketch, l1: SketchEntity, l2: SketchEntity): number {
  const deg = measureAngleBetweenLines(sketch, l1.id, l2.id);
  return deg > 90 ? 180 - deg : deg;
}

/**
 * True when two lines are parallel: their measured angle is under 0.5
 * degrees, or a parallel constraint already links them (an exact link the
 * solver enforces, even while the sketch sits at an unsolved, not-yet-
 * parallel initial guess where the angle test alone would miss it).
 */
function areLinesParallel(sketch: Sketch, l1: SketchEntity, l2: SketchEntity): boolean {
  if (l1.kind !== 'line' || l2.kind !== 'line') return false;
  if (acuteAngleBetween(sketch, l1, l2) < 0.5) return true;
  return sketch.constraints.some(
    (c) =>
      c.kind === 'parallel' &&
      ((c.l1Id === l1.id && c.l2Id === l2.id) || (c.l1Id === l2.id && c.l2Id === l1.id)),
  );
}

/** The center point id of an arc or circle entity. */
function centerIdOf(entity: SketchEntity): string | null {
  return entity.kind === 'arc' || entity.kind === 'circle' ? entity.centerId : null;
}

/**
 * Resolves a sketch selection to the dimension it produces, or a hint.
 * Owner-approved pair rules beyond the single-entity and point-point cases:
 * a point and a line resolve to a point-line distance; two parallel lines
 * resolve to a point-line distance from an endpoint of the first line to the
 * second (documented here since there is no other natural anchor for
 * "distance between two parallel lines"); a line and an arc or circle
 * resolve to a point-line distance from the curve's center to the line; two
 * circles, or a circle and a point, resolve to a plain distance between
 * their centers (a circle standing in for its center point). Non-parallel
 * lines still resolve to an angle.
 */
export function resolveDimensionSelection(
  sketch: Sketch,
  entities: SketchEntity[],
): DimensionSelectionResult {
  if (entities.length === 1 && entities[0].kind === 'line') {
    return { resolved: { kind: 'length', lineId: entities[0].id }, hint: SELECT_HINT };
  }
  if (entities.length === 1 && (entities[0].kind === 'arc' || entities[0].kind === 'circle')) {
    return { resolved: { kind: 'radiusOrDiameter', entityId: entities[0].id }, hint: SELECT_HINT };
  }
  if (entities.length === 2) {
    const [a, b] = entities;
    if (a.kind === 'point' && b.kind === 'point') {
      return { resolved: { kind: 'distance', p1Id: a.id, p2Id: b.id }, hint: SELECT_HINT };
    }
    if (a.kind === 'point' && b.kind === 'line') {
      return { resolved: { kind: 'pointLineDistance', pointId: a.id, lineId: b.id }, hint: SELECT_HINT };
    }
    if (a.kind === 'line' && b.kind === 'point') {
      return { resolved: { kind: 'pointLineDistance', pointId: b.id, lineId: a.id }, hint: SELECT_HINT };
    }
    if (a.kind === 'line' && b.kind === 'line') {
      if (areLinesParallel(sketch, a, b)) {
        return { resolved: { kind: 'pointLineDistance', pointId: a.p1Id, lineId: b.id }, hint: SELECT_HINT };
      }
      return { resolved: { kind: 'angle', l1Id: a.id, l2Id: b.id }, hint: SELECT_HINT };
    }
    const aCenter = centerIdOf(a);
    const bCenter = centerIdOf(b);
    if (a.kind === 'line' && bCenter !== null) {
      return { resolved: { kind: 'pointLineDistance', pointId: bCenter, lineId: a.id }, hint: SELECT_HINT };
    }
    if (b.kind === 'line' && aCenter !== null) {
      return { resolved: { kind: 'pointLineDistance', pointId: aCenter, lineId: b.id }, hint: SELECT_HINT };
    }
    if (aCenter !== null && bCenter !== null) {
      return { resolved: { kind: 'distance', p1Id: aCenter, p2Id: bCenter }, hint: SELECT_HINT };
    }
    if (a.kind === 'point' && bCenter !== null) {
      return { resolved: { kind: 'distance', p1Id: a.id, p2Id: bCenter }, hint: SELECT_HINT };
    }
    if (b.kind === 'point' && aCenter !== null) {
      return { resolved: { kind: 'distance', p1Id: aCenter, p2Id: b.id }, hint: SELECT_HINT };
    }
  }
  return { resolved: null, hint: SELECT_HINT };
}

/**
 * The anchor point (dimensionAnchor's per-kind convention) a resolved-but-
 * not-yet-committed selection would use, built from a minimal placeholder
 * dimension object (id/mm/degrees are irrelevant to anchor position).
 * Single source (convention 10) for both the placement click's labelOffset
 * computation and the inline input's on-screen position while still a draft.
 */
export function anchorForDimensionSelection(sketch: Sketch, resolved: DimensionSelectionKind): MmPoint {
  switch (resolved.kind) {
    case 'length':
      return dimensionAnchor(sketch, { kind: 'length', id: '_', lineId: resolved.lineId, mm: 0 });
    case 'distance':
      return dimensionAnchor(sketch, {
        kind: 'distance', id: '_', p1Id: resolved.p1Id, p2Id: resolved.p2Id, mm: 0,
      });
    case 'radiusOrDiameter':
      return dimensionAnchor(sketch, { kind: 'radius', id: '_', entityId: resolved.entityId, mm: 0 });
    case 'angle':
      return dimensionAnchor(sketch, {
        kind: 'angle', id: '_', l1Id: resolved.l1Id, l2Id: resolved.l2Id, degrees: 0,
      });
    case 'pointLineDistance':
      return dimensionAnchor(sketch, {
        kind: 'pointLineDistance', id: '_', pointId: resolved.pointId, lineId: resolved.lineId, mm: 0,
      });
    default:
      return assertNever(resolved);
  }
}

/**
 * The current measured value (mm, or degrees for angle) of a resolved
 * selection, for seeding the draft's default text. radiusKind picks radius
 * vs diameter for a radiusOrDiameter selection. cursor is the live placement
 * position, consulted only by the two kinds with a cursor-picked flavor:
 * distance (pickDistanceAxis's H/V/aligned pick) and angle
 * (angleForCursorSector's quadrant pick, falling back to the fixed 0..180
 * measured angle when the lines are parallel).
 */
export function measuredValueForDimensionSelection(
  sketch: Sketch,
  resolved: DimensionSelectionKind,
  radiusKind: 'radius' | 'diameter',
  cursor: MmPoint,
): number {
  switch (resolved.kind) {
    case 'length':
      return measureLineLength(sketch, resolved.lineId);
    case 'distance': {
      const axis = pickDistanceAxis(sketch, resolved.p1Id, resolved.p2Id, cursor);
      return axis === undefined
        ? measurePointDistance(sketch, resolved.p1Id, resolved.p2Id)
        : measurePointAxisDistance(sketch, resolved.p1Id, resolved.p2Id, axis);
    }
    case 'radiusOrDiameter':
      return radiusKind === 'radius'
        ? measureRadius(sketch, resolved.entityId)
        : measureDiameter(sketch, resolved.entityId);
    case 'angle':
      return (
        angleForCursorSector(sketch, resolved.l1Id, resolved.l2Id, cursor) ??
        measureAngleBetweenLines(sketch, resolved.l1Id, resolved.l2Id)
      );
    case 'pointLineDistance':
      return measurePointLineDistance(sketch, resolved.pointId, resolved.lineId);
    default:
      return assertNever(resolved);
  }
}

/**
 * Builds the actual constraint a resolved selection commits to, given the
 * radius/diameter choice, a fresh id, the typed value and the placed
 * labelOffset. The single place that turns a DimensionSelectionKind into a
 * real SketchDimension (convention 10), used by the store's commit path.
 * distanceAxis is the H/V/aligned flavor pickDistanceAxis resolved at
 * placement (undefined for the ordinary aligned distance, or for any
 * resolved kind other than 'distance', which ignores it).
 */
export function buildDimensionFromSelection(
  resolved: DimensionSelectionKind,
  radiusKind: 'radius' | 'diameter',
  id: string,
  value: number,
  labelOffset: LabelOffset,
  distanceAxis?: 'x' | 'y',
): SketchDimension {
  switch (resolved.kind) {
    case 'length':
      return { kind: 'length', id, lineId: resolved.lineId, mm: value, labelOffset };
    case 'distance':
      return {
        kind: 'distance', id, p1Id: resolved.p1Id, p2Id: resolved.p2Id, mm: value, axis: distanceAxis,
        labelOffset,
      };
    case 'radiusOrDiameter':
      return { kind: radiusKind, id, entityId: resolved.entityId, mm: value, labelOffset };
    case 'angle':
      return { kind: 'angle', id, l1Id: resolved.l1Id, l2Id: resolved.l2Id, degrees: value, labelOffset };
    case 'pointLineDistance':
      return {
        kind: 'pointLineDistance', id, pointId: resolved.pointId, lineId: resolved.lineId, mm: value,
        labelOffset,
      };
    default:
      return assertNever(resolved);
  }
}
