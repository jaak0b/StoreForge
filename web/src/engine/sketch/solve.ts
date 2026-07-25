// Adapter between the Sketch datatype and the FreeCAD PlaneGCS solver
// (@salusoft89/planegcs). Framework-agnostic: the caller (worker or test)
// passes in the loaded GcsWrapper, the same injection pattern the gridfinity
// engine uses for the manifold instance. The adapter maps entities and
// constraints onto PlaneGCS primitives, runs the solver, and writes solved
// coordinates back into a copy of the sketch.
import type { GcsWrapper } from '@salusoft89/planegcs';
import { assertNever } from '../plan/types';
import { cloneSketch, type Sketch, type SketchEntity } from './model';

/** The solver's driven-point drag: pull pointId toward the target. */
export interface DragTarget {
  pointId: string;
  xMm: number;
  yMm: number;
}

export type SketchSolveResult =
  | { status: 'solved'; sketch: Sketch; dof: number }
  | { status: 'conflicting'; conflictingConstraintIds: string[] }
  | { status: 'failed'; message: string };

// PlaneGCS SolveStatus values (planegcs_dist/enums): Success 0, Converged 1,
// Failed 2, SuccessfulSolutionInvalid 3.
const SOLVE_SUCCESS = 0;
const SOLVE_CONVERGED = 1;

/** Internal ids the adapter adds; never reported back as user constraints. */
const DRAG_POINT_ID = '__drag_target';
const DRAG_CONSTRAINT_ID = '__drag_pin';

/**
 * The PlaneGCS primitive fields for a dimension's driven flag: `{ driving:
 * false }` for a driven dimension (measured, never enforced; see model.ts's
 * SketchDimension.driven), or no fields at all for an ordinary driving
 * dimension so PlaneGCS's own default (driving: true) applies.
 */
function drivingFlag(driven: boolean | undefined): { driving?: false } {
  return driven === true ? { driving: false } : {};
}

function arcAngles(
  center: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): { radius: number; startAngle: number; endAngle: number } {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  let endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  // The sketch arc runs counterclockwise from start to end; PlaneGCS expects
  // end_angle >= start_angle along that direction.
  if (endAngle <= startAngle) endAngle += 2 * Math.PI;
  return { radius, startAngle, endAngle };
}

/**
 * Runs the constraint solver over the sketch and returns the solved copy,
 * the remaining degrees of freedom (0 means fully constrained), the
 * conflicting constraint ids, or a user-worded failure. A drag is expressed
 * as PlaneGCS's standard interactive workflow: a fixed target point plus a
 * temporary coincidence, which the solver satisfies as well as the driving
 * constraints allow without reducing the reported dof.
 */
export function solveSketch(
  wrapper: GcsWrapper,
  sketch: Sketch,
  drag?: DragTarget,
): SketchSolveResult {
  const byId = new Map<string, SketchEntity>(sketch.entities.map((e) => [e.id, e]));
  const primitives: Record<string, unknown>[] = [];
  // Points first: PlaneGCS requires referenced primitives to be pushed
  // before the primitives and constraints that use them.
  for (const entity of sketch.entities) {
    if (entity.kind === 'point') {
      primitives.push({
        id: entity.id,
        type: 'point',
        x: entity.x,
        y: entity.y,
        fixed: false,
      });
    }
  }
  for (const entity of sketch.entities) {
    switch (entity.kind) {
      case 'point':
        break;
      case 'line':
        primitives.push({ id: entity.id, type: 'line', p1_id: entity.p1Id, p2_id: entity.p2Id });
        break;
      case 'arc': {
        const center = byId.get(entity.centerId) as { x: number; y: number };
        const start = byId.get(entity.startId) as { x: number; y: number };
        const end = byId.get(entity.endId) as { x: number; y: number };
        const derived = arcAngles(center, start, end);
        primitives.push({
          id: entity.id,
          type: 'arc',
          c_id: entity.centerId,
          start_id: entity.startId,
          end_id: entity.endId,
          radius: derived.radius,
          start_angle: derived.startAngle,
          end_angle: derived.endAngle,
        });
        // arc_rules keeps the arc's endpoints, angles and radius consistent.
        primitives.push({ id: `${entity.id}__rules`, type: 'arc_rules', a_id: entity.id });
        break;
      }
      case 'circle':
        primitives.push({
          id: entity.id,
          type: 'circle',
          c_id: entity.centerId,
          radius: entity.radiusMm,
        });
        break;
      default:
        return assertNever(entity);
    }
  }
  for (const c of sketch.constraints) {
    switch (c.kind) {
      case 'coincident':
        primitives.push({ id: c.id, type: 'p2p_coincident', p1_id: c.p1Id, p2_id: c.p2Id });
        break;
      case 'horizontal':
        primitives.push({ id: c.id, type: 'horizontal_l', l_id: c.lineId });
        break;
      case 'vertical':
        primitives.push({ id: c.id, type: 'vertical_l', l_id: c.lineId });
        break;
      case 'parallel':
        primitives.push({ id: c.id, type: 'parallel', l1_id: c.l1Id, l2_id: c.l2Id });
        break;
      case 'perpendicular':
        primitives.push({ id: c.id, type: 'perpendicular_ll', l1_id: c.l1Id, l2_id: c.l2Id });
        break;
      case 'tangent': {
        const a = byId.get(c.aId);
        const b = byId.get(c.bId);
        if (a === undefined || b === undefined) {
          return {
            status: 'failed',
            message: 'A tangent constraint refers to geometry that is not in the sketch.',
          };
        }
        // Normalize so a line, if present, is on the l side. Kind pairs map
        // onto PlaneGCS's typed tangency constraints.
        const [first, second] = a.kind === 'line' ? [a, b] : [b, a];
        if (first.kind === 'line' && second.kind === 'arc') {
          primitives.push({ id: c.id, type: 'tangent_la', l_id: first.id, a_id: second.id });
        } else if (first.kind === 'line' && second.kind === 'circle') {
          primitives.push({ id: c.id, type: 'tangent_lc', l_id: first.id, c_id: second.id });
        } else if (first.kind === 'arc' && second.kind === 'arc') {
          primitives.push({ id: c.id, type: 'tangent_aa', a1_id: first.id, a2_id: second.id });
        } else if (first.kind === 'circle' && second.kind === 'circle') {
          primitives.push({ id: c.id, type: 'tangent_cc', c1_id: first.id, c2_id: second.id });
        } else if (first.kind === 'circle' && second.kind === 'arc') {
          primitives.push({ id: c.id, type: 'tangent_ca', c_id: first.id, a_id: second.id });
        } else if (first.kind === 'arc' && second.kind === 'circle') {
          primitives.push({ id: c.id, type: 'tangent_ca', c_id: second.id, a_id: first.id });
        } else {
          return {
            status: 'failed',
            message: 'A tangent constraint needs an arc or circle on at least one side.',
          };
        }
        break;
      }
      case 'symmetric':
        primitives.push({
          id: c.id,
          type: 'p2p_symmetric_ppl',
          p1_id: c.p1Id,
          p2_id: c.p2Id,
          l_id: c.mirrorLineId,
        });
        break;
      case 'length': {
        const lineEntity = byId.get(c.lineId);
        if (lineEntity === undefined || lineEntity.kind !== 'line') {
          return {
            status: 'failed',
            message: 'A length dimension refers to a line that is not in the sketch.',
          };
        }
        primitives.push({
          id: c.id,
          type: 'p2p_distance',
          p1_id: lineEntity.p1Id,
          p2_id: lineEntity.p2Id,
          distance: c.mm,
          ...drivingFlag(c.driven),
        });
        break;
      }
      case 'distance': {
        if (c.axis === undefined) {
          primitives.push({
            id: c.id,
            type: 'p2p_distance',
            p1_id: c.p1Id,
            p2_id: c.p2Id,
            distance: c.mm,
            ...drivingFlag(c.driven),
          });
          break;
        }
        // An axis-flavored distance has no dedicated PlaneGCS "p2p distance
        // along one axis" constraint; it is built from the general-purpose
        // `difference` constraint (param1 - param2 = difference) over each
        // point's x or y property param, the mechanism PlaneGCS actually
        // offers for this (see solve.ts's module comment for the survey).
        const p1 = byId.get(c.p1Id);
        const p2 = byId.get(c.p2Id);
        if (p1 === undefined || p1.kind !== 'point' || p2 === undefined || p2.kind !== 'point') {
          return {
            status: 'failed',
            message: 'An axis distance dimension refers to a point that is not in the sketch.',
          };
        }
        // `difference` is signed (param1 - param2), but the dimension's
        // stored mm is an unsigned magnitude (model.ts validation requires
        // mm > 0); target the sign the sketch's current arrangement already
        // has, so a driving solve enforces the magnitude without flipping
        // which point is on which side.
        const currentDiff = c.axis === 'x' ? p1.x - p2.x : p1.y - p2.y;
        const signedTarget = currentDiff < 0 ? -c.mm : c.mm;
        primitives.push({
          id: c.id,
          type: 'difference',
          // PlaneGCS's `difference` constraint is param2 minus param1 (empirically
          // verified against the wrapper; not documented in constraints.d.ts), so
          // param1/param2 are swapped here to make `difference` read as p1 - p2,
          // matching signedTarget's sign convention above.
          param1: { o_id: c.p2Id, prop: c.axis },
          param2: { o_id: c.p1Id, prop: c.axis },
          difference: signedTarget,
          ...drivingFlag(c.driven),
        });
        break;
      }
      case 'radius':
      case 'diameter': {
        const target = byId.get(c.entityId);
        if (target === undefined || (target.kind !== 'arc' && target.kind !== 'circle')) {
          return {
            status: 'failed',
            message: 'A radius or diameter dimension needs an arc or a circle.',
          };
        }
        const radiusMm = c.kind === 'diameter' ? c.mm / 2 : c.mm;
        if (target.kind === 'arc') {
          primitives.push({
            id: c.id, type: 'arc_radius', a_id: target.id, radius: radiusMm, ...drivingFlag(c.driven),
          });
        } else {
          primitives.push({
            id: c.id, type: 'circle_radius', c_id: target.id, radius: radiusMm, ...drivingFlag(c.driven),
          });
        }
        break;
      }
      case 'angle':
        primitives.push({
          id: c.id,
          type: 'l2l_angle_ll',
          l1_id: c.l1Id,
          l2_id: c.l2Id,
          angle: (c.degrees * Math.PI) / 180,
          ...drivingFlag(c.driven),
        });
        break;
      case 'pointLineDistance': {
        const lineEntity = byId.get(c.lineId);
        if (lineEntity === undefined || lineEntity.kind !== 'line') {
          return {
            status: 'failed',
            message: 'A point-line distance dimension refers to a line that is not in the sketch.',
          };
        }
        primitives.push({
          id: c.id,
          type: 'p2l_distance',
          p_id: c.pointId,
          l_id: c.lineId,
          distance: c.mm,
          ...drivingFlag(c.driven),
        });
        break;
      }
      default:
        return assertNever(c);
    }
  }
  if (drag !== undefined) {
    primitives.push({ id: DRAG_POINT_ID, type: 'point', x: drag.xMm, y: drag.yMm, fixed: true });
    primitives.push({
      id: DRAG_CONSTRAINT_ID,
      type: 'p2p_coincident',
      p1_id: drag.pointId,
      p2_id: DRAG_POINT_ID,
      temporary: true,
    });
  }

  wrapper.clear_data();
  wrapper.push_primitives_and_params(
    primitives as unknown as Parameters<GcsWrapper['push_primitives_and_params']>[0],
  );
  const status = wrapper.solve();
  // has_gcs_conflicting_constraints() can report a stale conflict left over
  // from an earlier internal solve attempt even when this solve() call
  // itself succeeded (observed with a tangent constraint whose initial
  // guess needed a DogLeg retry), so it is only authoritative once the
  // solve has actually failed.
  if (status !== SOLVE_SUCCESS && status !== SOLVE_CONVERGED) {
    const userConstraintIds = new Set(sketch.constraints.map((c) => c.id));
    if (wrapper.has_gcs_conflicting_constraints()) {
      const offending = wrapper
        .get_gcs_conflicting_constraints()
        .filter((id) => userConstraintIds.has(id));
      if (offending.length > 0) {
        return { status: 'conflicting', conflictingConstraintIds: offending };
      }
    }
    return {
      status: 'failed',
      message:
        'The sketch could not be solved from its current positions. Move the geometry closer to the intended shape and try again.',
    };
  }
  wrapper.apply_solution();
  const dof = wrapper.gcs.dof();
  const solved = cloneSketch(sketch);
  for (const entity of solved.entities) {
    switch (entity.kind) {
      case 'point': {
        const p = wrapper.sketch_index.get_primitive_or_fail(entity.id) as unknown as {
          x: number;
          y: number;
        };
        entity.x = p.x;
        entity.y = p.y;
        break;
      }
      case 'circle': {
        const circle = wrapper.sketch_index.get_primitive_or_fail(entity.id) as unknown as {
          radius: number;
        };
        entity.radiusMm = circle.radius;
        break;
      }
      case 'line':
      case 'arc':
        // Lines and arcs are fully determined by their points; arcs also by
        // arc_rules, which keeps endpoints authoritative.
        break;
      default:
        return assertNever(entity);
    }
  }
  return { status: 'solved', sketch: solved, dof };
}
