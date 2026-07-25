// Resolves what dimension kind (if any) a sketch selection produces for the
// dimension tool, matching Fusion 360's pair semantics: one line is a
// length, an arc or circle is a radius, two points are a distance, two
// non-parallel lines are an angle. Two parallel lines have no clean
// representation with the existing constraint kinds (model.ts's distance
// dimension is point-point only; there is no distance-between-lines or
// point-line distance kind), so that pair surfaces a hint instead of a
// dimension, per the owner-approved spec. Kept in the engine (framework
// agnostic, convention 3) so SketchWorkspace.vue only wires this into the
// click handler rather than re-deriving the pair rules inline.
import type { LabelOffset, Sketch, SketchDimension, SketchEntity } from './model';
import type { MmPoint } from '../trace/types';
import { assertNever } from '../plan/types';
import { dimensionAnchor } from './dimensionGraphics';
import { measureAngleBetweenLines, measureDiameter, measureLineLength, measurePointDistance, measureRadius } from './measure';

export type DimensionSelectionKind =
  | { kind: 'length'; lineId: string }
  | { kind: 'distance'; p1Id: string; p2Id: string }
  | { kind: 'radiusOrDiameter'; entityId: string }
  | { kind: 'angle'; l1Id: string; l2Id: string };

export interface DimensionSelectionResult {
  /** The dimension the selection resolves to, or null when the selection is
   * incomplete or inapplicable (see hint for why). */
  resolved: DimensionSelectionKind | null;
  /** A one-line, complete-sentence hint for the toolbar's hint row, shown
   * whenever resolved is null. */
  hint: string;
}

const SELECT_HINT =
  'Select one line for a length, an arc or circle for a radius, two points for a distance, or two lines for an angle.';
const PARALLEL_LINES_HINT = 'Select a point and a line for a distance.';

/** True when two lines' direction vectors are parallel (or anti-parallel)
 * within a small angular tolerance, the same test an angle dimension of 0 or
 * 180 degrees would otherwise measure as "useless". */
function areLinesParallel(sketch: Sketch, l1: SketchEntity, l2: SketchEntity): boolean {
  if (l1.kind !== 'line' || l2.kind !== 'line') return false;
  const pointOf = (id: string) => {
    const e = sketch.entities.find((x) => x.id === id);
    return e !== undefined && e.kind === 'point' ? { x: e.x, y: e.y } : { x: 0, y: 0 };
  };
  const a1 = pointOf(l1.p1Id);
  const b1 = pointOf(l1.p2Id);
  const a2 = pointOf(l2.p1Id);
  const b2 = pointOf(l2.p2Id);
  const d1 = { x: b1.x - a1.x, y: b1.y - a1.y };
  const d2 = { x: b2.x - a2.x, y: b2.y - a2.y };
  const len1 = Math.hypot(d1.x, d1.y) || 1;
  const len2 = Math.hypot(d2.x, d2.y) || 1;
  const cross = (d1.x * d2.y - d1.y * d2.x) / (len1 * len2);
  return Math.abs(cross) < 1e-3;
}

/** Resolves a sketch selection to the dimension it produces, or a hint. */
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
  if (entities.length === 2 && entities.every((e) => e.kind === 'point')) {
    return {
      resolved: { kind: 'distance', p1Id: entities[0].id, p2Id: entities[1].id },
      hint: SELECT_HINT,
    };
  }
  if (entities.length === 2 && entities.every((e) => e.kind === 'line')) {
    if (areLinesParallel(sketch, entities[0], entities[1])) {
      return { resolved: null, hint: PARALLEL_LINES_HINT };
    }
    return {
      resolved: { kind: 'angle', l1Id: entities[0].id, l2Id: entities[1].id },
      hint: SELECT_HINT,
    };
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
    default:
      return assertNever(resolved);
  }
}
