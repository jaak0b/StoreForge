// Manual cavity edits for cutout bins: brush strokes and flatten clicks,
// stored on the plan (plan/types CavityEdit) and folded onto the carved body
// after the model carve and before the label stage. Framework-agnostic; the
// ManifoldToplevel is injected as everywhere else in the engine.
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { circleSegments } from '../geometry/circleSegments';
import { assertNever, type CavityEdit, type Vec3Mm } from '../plan/types';

/** The brush radius bounds the plan validator and the radius field enforce. */
export const CAVITY_EDIT_RADIUS_MIN_MM = 0.2;
export const CAVITY_EDIT_RADIUS_MAX_MM = 50;

/**
 * The geometric error budget one stroke may spend, in mm: a quarter of its
 * own brush radius, the same quarter rule the clearance offset pipeline
 * spends (simplifyToleranceMm in cutoutBin.ts). Spent twice coherently: the
 * Douglas-Peucker simplification of the polyline and the sphere faceting
 * both stay within it, so the painted shape is faithful to brush fidelity.
 */
export function strokeToleranceMm(radiusMm: number): number {
  return radiusMm / 4;
}

function pointSegmentDistanceMm(point: Vec3Mm, a: Vec3Mm, b: Vec3Mm): number {
  const abx = b.xMm - a.xMm;
  const aby = b.yMm - a.yMm;
  const abz = b.zMm - a.zMm;
  const apx = point.xMm - a.xMm;
  const apy = point.yMm - a.yMm;
  const apz = point.zMm - a.zMm;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / lengthSq));
  const dx = apx - t * abx;
  const dy = apy - t * aby;
  const dz = apz - t * abz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Douglas-Peucker polyline simplification in 3D: keep the point farthest
 * from the chord when it exceeds the tolerance, recurse on both halves.
 * The standard algorithm, applied to bound solid cost on long mouse paths
 * without changing the painted shape beyond the stroke's error budget.
 */
export function simplifyStroke(points: Vec3Mm[], toleranceMm: number): Vec3Mm[] {
  if (points.length <= 2) return points.slice();
  let farthestIndex = 0;
  let farthestDistance = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointSegmentDistanceMm(points[i], first, last);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthestIndex = i;
    }
  }
  if (farthestDistance <= toleranceMm) return [first, last];
  const head = simplifyStroke(points.slice(0, farthestIndex + 1), toleranceMm);
  const tail = simplifyStroke(points.slice(farthestIndex), toleranceMm);
  return head.slice(0, -1).concat(tail);
}

function sphereAt(m: ManifoldToplevel, point: Vec3Mm, radiusMm: number, segments: number): Manifold {
  return m.Manifold.sphere(radiusMm, segments).translate([point.xMm, point.yMm, point.zMm]);
}

/**
 * The solid one brush stroke paints: per consecutive point pair, the convex
 * hull of two spheres, which is exactly the capsule over that segment (a
 * standard CSG construction); the segment capsules are unioned into one
 * solid. A single point is one sphere. The sphere faceting follows the same
 * sagitta-bound derivation the clearance offset sphere uses (circleSegments
 * against the quarter-rule budget), so no new constant enters.
 */
export function strokeSolid(m: ManifoldToplevel, points: Vec3Mm[], radiusMm: number): Manifold {
  if (points.length === 0) {
    throw new Error('A brush stroke needs at least one point.');
  }
  const toleranceMm = strokeToleranceMm(radiusMm);
  const segments = circleSegments(radiusMm, toleranceMm);
  const simplified = simplifyStroke(points, toleranceMm);
  if (simplified.length === 1) {
    return sphereAt(m, simplified[0], radiusMm, segments);
  }
  const capsules: Manifold[] = [];
  for (let i = 0; i < simplified.length - 1; i += 1) {
    const a = sphereAt(m, simplified[i], radiusMm, segments);
    const b = sphereAt(m, simplified[i + 1], radiusMm, segments);
    capsules.push(m.Manifold.hull([a, b]));
    a.delete();
    b.delete();
  }
  const union = m.Manifold.union(capsules);
  for (const capsule of capsules) capsule.delete();
  return union;
}

/**
 * The solid one flatten click shaves away: a cylinder of the brush radius,
 * standing on the picked plane and reaching binTopZMm, the same figure the
 * swept pockets reach (sweptReachZ), so the cut provably opens through the
 * lip rather than leaving a roof over the flattened region.
 */
export function flattenSolid(
  m: ManifoldToplevel,
  edit: { centerMm: Vec3Mm; radiusMm: number; planeZMm: number },
  binTopZMm: number,
): Manifold {
  const heightMm = binTopZMm - edit.planeZMm;
  if (!(heightMm > 0)) {
    throw new Error('The flatten height must lie below the top of the bin.');
  }
  return m.Manifold.cylinder(
    heightMm,
    edit.radiusMm,
    edit.radiusMm,
    circleSegments(edit.radiusMm, strokeToleranceMm(edit.radiusMm)),
  ).translate([edit.centerMm.xMm, edit.centerMm.yMm, edit.planeZMm]);
}

/**
 * Folds the edits onto the carved body in list order. Remove and flatten
 * subtract their solid; add unions the stroke solid intersected with the
 * un-carved solid bin body, so Add can only restore material the bin
 * originally had and never grows material outside the bin envelope.
 * Takes ownership of body; binSolid is borrowed. The final body is status
 * checked, and an edit list that empties the bin is a user-worded error.
 */
export function applyCavityEdits(
  m: ManifoldToplevel,
  body: Manifold,
  binSolid: Manifold,
  edits: CavityEdit[],
  binTopZMm: number,
): Manifold {
  let current: Manifold = body;
  const advance = (next: Manifold): void => {
    current.delete();
    current = next;
  };
  try {
    for (const edit of edits) {
      switch (edit.kind) {
        case 'add': {
          const stroke = strokeSolid(m, edit.points, edit.radiusMm);
          const clamped = stroke.intersect(binSolid);
          stroke.delete();
          advance(current.add(clamped));
          clamped.delete();
          break;
        }
        case 'remove': {
          const stroke = strokeSolid(m, edit.points, edit.radiusMm);
          advance(current.subtract(stroke));
          stroke.delete();
          break;
        }
        case 'flatten': {
          const cylinder = flattenSolid(m, edit, binTopZMm);
          advance(current.subtract(cylinder));
          cylinder.delete();
          break;
        }
        default:
          assertNever(edit);
      }
    }
    if (current.isEmpty()) {
      throw new Error('The cavity edits removed the entire bin, so the last edit was not applied.');
    }
    const status = current.status();
    if (status !== 'NoError') {
      throw new Error(`Applying the cavity edits produced an invalid solid (${status}).`);
    }
    const result = current;
    current = null as unknown as Manifold;
    return result;
  } finally {
    // On a throw the working solid is released; on success it was handed out.
    (current as Manifold | null)?.delete();
  }
}

/**
 * Deterministic identity of an edit list, for the worker's edited-body memo:
 * plain JSON of the plain-data edits, which is deterministic because every
 * edit is built with its fields in the fixed literal order above.
 */
export function cavityEditsKey(edits: CavityEdit[]): string {
  return JSON.stringify(edits);
}
