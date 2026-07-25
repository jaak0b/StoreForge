// Which constraint kinds the current sketch selection admits, derived
// strictly from the constraint shapes in model.ts (each constraint's field
// list dictates what kinds of entities and how many it takes). Kept in the
// engine so the Vue toolbar layer only renders buttons for constraints that
// can actually be applied to the current selection, without duplicating this
// derivation inline in a component.
import type { SketchEntity } from './model';

/** The subset of SketchConstraint kinds offered as toolbar buttons (dimensions
 * are driven by the dimension tool, not this row). */
export type ApplicableConstraintKind =
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'coincident'
  | 'symmetric';

/**
 * Constraint kinds the given selection admits, in the toolbar's display
 * order. Each check mirrors the entity shape the constraint's fields require
 * (SketchWorkspace.applyConstraint builds the constraint the same way).
 */
export function applicableConstraintKinds(entities: SketchEntity[]): ApplicableConstraintKind[] {
  const kinds: ApplicableConstraintKind[] = [];
  const lines = entities.filter((e) => e.kind === 'line');
  const points = entities.filter((e) => e.kind === 'point');
  const curves = entities.filter((e) => e.kind === 'arc' || e.kind === 'circle');

  if (entities.length === 1 && lines.length === 1) {
    kinds.push('horizontal', 'vertical');
  }
  if (entities.length === 2 && lines.length === 2) {
    kinds.push('parallel', 'perpendicular');
  }
  // Tangent: two entities, neither a point, at least one an arc or circle
  // (matches validateSketch's tangent rule: curve-curve or curve-line).
  if (entities.length === 2 && points.length === 0 && curves.length >= 1) {
    kinds.push('tangent');
  }
  if (entities.length === 2 && points.length === 2) {
    kinds.push('coincident');
  }
  if (entities.length === 3 && points.length === 2 && lines.length === 1) {
    kinds.push('symmetric');
  }
  return kinds;
}

/** Whether the construction toggle applies: at least one selected entity is
 * not a point (a point's construction flag is not user-facing). */
export function canToggleConstruction(entities: SketchEntity[]): boolean {
  return entities.some((e) => e.kind !== 'point');
}
