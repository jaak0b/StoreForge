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
import { dimensionAnchor } from './dimensionGraphics';
import {
  measureAngleBetweenLines,
  measureDiameter,
  measureLineLength,
  measurePointDistance,
  measurePointLineDistance,
  measureRadius,
} from './measure';

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

/** The current measured value (mm, or degrees for angle) of a resolved
 * selection, for seeding the draft's default text. radiusKind picks radius
 * vs diameter for a radiusOrDiameter selection. */
export function measuredValueForDimensionSelection(
  sketch: Sketch,
  resolved: DimensionSelectionKind,
  radiusKind: 'radius' | 'diameter',
): number {
  switch (resolved.kind) {
    case 'length':
      return measureLineLength(sketch, resolved.lineId);
    case 'distance':
      return measurePointDistance(sketch, resolved.p1Id, resolved.p2Id);
    case 'radiusOrDiameter':
      return radiusKind === 'radius'
        ? measureRadius(sketch, resolved.entityId)
        : measureDiameter(sketch, resolved.entityId);
    case 'angle':
      return measureAngleBetweenLines(sketch, resolved.l1Id, resolved.l2Id);
    case 'pointLineDistance':
      return measurePointLineDistance(sketch, resolved.pointId, resolved.lineId);
    default:
      return assertNever(resolved);
  }
}

/** Builds the actual constraint a resolved selection commits to, given the
 * radius/diameter choice, a fresh id, the typed value and the placed
 * labelOffset. The single place that turns a DimensionSelectionKind into a
 * real SketchDimension (convention 10), used by the store's commit path. */
export function buildDimensionFromSelection(
  resolved: DimensionSelectionKind,
  radiusKind: 'radius' | 'diameter',
  id: string,
  value: number,
  labelOffset: LabelOffset,
): SketchDimension {
  switch (resolved.kind) {
    case 'length':
      return { kind: 'length', id, lineId: resolved.lineId, mm: value, labelOffset };
    case 'distance':
      return { kind: 'distance', id, p1Id: resolved.p1Id, p2Id: resolved.p2Id, mm: value, labelOffset };
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
