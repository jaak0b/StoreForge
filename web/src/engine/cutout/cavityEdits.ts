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

/** The flatten cut height bounds the plan validator and the height field enforce. */
export const FLATTEN_HEIGHT_MIN_MM = 0.2;
export const FLATTEN_HEIGHT_MAX_MM = 100;

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
 * The extrinsic x-y-z Euler rotation (degrees, matching Manifold's rotate
 * convention, see placeCutter in cutoutBin.ts) that carries the Z axis onto
 * `normalMm`. A cylinder standing along Z is rotationally symmetric about its
 * own axis, so the third (Z) angle is free and left at 0; only the X and Y
 * angles are needed to point the axis, a standard two-angle axis alignment:
 *
 *   Rx(x) * (0,0,1) = (0, -sin x, cos x)
 *   Ry(y) * that     = (sin y cos x, -sin x, cos y cos x)
 *
 * Solving that against normalMm = (nx, ny, nz) gives x = asin(-ny) and
 * y = atan2(nx, nz), with y left at 0 in the degenerate case (normal along
 * +-Y) where cos(x) is 0 and y does not affect the result.
 */
function rotationAligningZTo(normalMm: Vec3Mm): [number, number, number] {
  const { xMm: nx, yMm: ny, zMm: nz } = normalMm;
  const clampedNy = Math.max(-1, Math.min(1, -ny));
  const xRad = Math.asin(clampedNy);
  const cosX = Math.cos(xRad);
  const yRad = Math.abs(cosX) < 1e-9 ? 0 : Math.atan2(nx, nz);
  const toDeg = 180 / Math.PI;
  return [xRad * toDeg, yRad * toDeg, 0];
}

/**
 * The solid one flatten click shaves away: a cylinder of the brush radius,
 * its base disc lying on the tangent plane through centerMm and its axis
 * along normalMm, extending along +normal by exactly edit.heightMm (a user
 * chosen figure, bounded by FLATTEN_HEIGHT_MIN_MM/MAX_MM), so the cut only
 * reaches the material the user intended it to and never punches through
 * unrelated geometry further along the normal.
 */
export function flattenSolid(
  m: ManifoldToplevel,
  edit: { centerMm: Vec3Mm; radiusMm: number; normalMm: Vec3Mm; heightMm: number },
): Manifold {
  const cylinder = m.Manifold.cylinder(
    edit.heightMm,
    edit.radiusMm,
    edit.radiusMm,
    circleSegments(edit.radiusMm, strokeToleranceMm(edit.radiusMm)),
  );
  const rotated = cylinder.rotate(rotationAligningZTo(edit.normalMm));
  cylinder.delete();
  const placed = rotated.translate([edit.centerMm.xMm, edit.centerMm.yMm, edit.centerMm.zMm]);
  rotated.delete();
  return placed;
}

/**
 * Folds one edit onto `current` (owned by the caller, consumed here) and
 * returns the new working solid. `binSolid` is borrowed and only consulted
 * for the Add clamp. Shared by applyCavityEdits and applyCavityEditsMemoized
 * so the two folding paths cannot drift (rule 10).
 */
function foldCavityEdit(
  m: ManifoldToplevel,
  current: Manifold,
  edit: CavityEdit,
  binSolid: Manifold,
): Manifold {
  switch (edit.kind) {
    case 'add': {
      const stroke = strokeSolid(m, edit.points, edit.radiusMm);
      const clamped = stroke.intersect(binSolid);
      stroke.delete();
      const next = current.add(clamped);
      current.delete();
      clamped.delete();
      return next;
    }
    case 'remove': {
      const stroke = strokeSolid(m, edit.points, edit.radiusMm);
      const next = current.subtract(stroke);
      current.delete();
      stroke.delete();
      return next;
    }
    case 'flatten': {
      const cylinder = flattenSolid(m, edit);
      const next = current.subtract(cylinder);
      current.delete();
      cylinder.delete();
      return next;
    }
    default:
      return assertNever(edit);
  }
}

const EDITS_EMPTIED_BIN_MESSAGE =
  'The cavity edits removed the entire bin, so the last edit was not applied.';

function editsProducedInvalidSolidMessage(status: string): string {
  return `Applying the cavity edits produced an invalid solid (${status}).`;
}

/**
 * True when `message` is one of the user-worded failures finishCavityEdits
 * throws: the carve reached the worker and failed specifically because the
 * folded edits themselves are bad (emptied the bin, or left an invalid
 * solid). Callers use this to tell an edit rejection apart from every other
 * carve failure (a missing model file, divider walls on a cutout bin, a bad
 * STL), which must not roll an edit back because the edit was not at fault.
 */
export function isCavityEditRejectionMessage(message: string): boolean {
  return (
    message === EDITS_EMPTIED_BIN_MESSAGE ||
    /^Applying the cavity edits produced an invalid solid \(.+\)\.$/.test(message)
  );
}

/** Status-checks and empties-checks the final folded body, or throws a user-worded error. */
function finishCavityEdits(current: Manifold): Manifold {
  if (current.isEmpty()) {
    throw new Error(EDITS_EMPTIED_BIN_MESSAGE);
  }
  const status = current.status();
  if (status !== 'NoError') {
    throw new Error(editsProducedInvalidSolidMessage(status));
  }
  return current;
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
): Manifold {
  let current: Manifold = body;
  try {
    for (const edit of edits) {
      current = foldCavityEdit(m, current, edit, binSolid);
    }
    const result = finishCavityEdits(current);
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

/**
 * Storage for the worker's single-entry edited-body memo. The worker's
 * CavityEditedBodyCache implements this; the engine only depends on the
 * interface, keeping cavityEdits.ts framework-agnostic (rule 3).
 */
export interface CavityEditedBodyMemo {
  /** The memoized edited body under this key, borrowed, or null. */
  get(key: string): Manifold | null;
  /** Stores the edited body under this key, taking ownership of the given handle. */
  put(key: string, body: Manifold): void;
}

/**
 * Deterministic identity of the folded body after the first `count` edits of
 * `edits`, applied to the carve identified by `recipeKey`. Any change to the
 * carve recipe, to an earlier edit, or to the edit count changes this key, so
 * a stale memo entry is never mistaken for the requested prefix.
 */
export function cavityEditPrefixKey(recipeKey: string, edits: CavityEdit[], count: number): string {
  return `${recipeKey}|${count}|${cavityEditsKey(edits.slice(0, count))}`;
}

/**
 * Folds the edits onto the carved body, like applyCavityEdits, but with an
 * optional single-entry memo for the append case: painting one more stroke
 * onto an unchanged carve reuses the previously folded body instead of
 * refolding every earlier edit.
 *
 * With a memo, the prefix key for `edits.length - 1` is consulted first. On a
 * hit, folding starts from a retained handle of the memoized body
 * (`translate([0, 0, 0])`, a new handle over the same shared lazy CSG node,
 * so the cache entry itself stays valid) and only the last edit is folded. On
 * a miss, every edit is folded from the fresh carve body, exactly as
 * applyCavityEdits does. Either way, the final body is stored under the
 * full-list prefix key as a retained handle, so the next append hits.
 *
 * Undo, reorder, a radius change, or any carve recipe change misses (the
 * prefix key changes) and rebuilds fully: that is the single-entry contract,
 * not a bug in it.
 *
 * `makeBinSolid` is only invoked, at most once, when a folded edit is an Add
 * (the clamp needs the un-carved bin envelope); its result is deleted before
 * this function returns. Takes ownership of `body`.
 */
export function applyCavityEditsMemoized(
  m: ManifoldToplevel,
  body: Manifold,
  makeBinSolid: () => Manifold,
  edits: CavityEdit[],
  memo?: { store: CavityEditedBodyMemo; recipeKey: string },
): Manifold {
  const binSolidRef: { value: Manifold | null } = { value: null };
  const getBinSolid = (): Manifold => {
    if (binSolidRef.value === null) binSolidRef.value = makeBinSolid();
    return binSolidRef.value;
  };
  let current: Manifold | null = null;
  try {
    let startIndex = 0;
    if (memo !== undefined && edits.length > 0) {
      const hitKey = cavityEditPrefixKey(memo.recipeKey, edits, edits.length - 1);
      const hit = memo.store.get(hitKey);
      if (hit !== null) {
        current = hit.translate([0, 0, 0]);
        startIndex = edits.length - 1;
      }
    }
    if (current === null) {
      current = body;
      startIndex = 0;
    } else {
      // The memo hit is the working solid; the fresh carve body is unused.
      body.delete();
    }
    for (let i = startIndex; i < edits.length; i += 1) {
      current = foldCavityEdit(m, current, edits[i], getBinSolid());
    }
    const result = finishCavityEdits(current);
    current = null;
    if (memo !== undefined) {
      const storeKey = cavityEditPrefixKey(memo.recipeKey, edits, edits.length);
      memo.store.put(storeKey, result.translate([0, 0, 0]));
    }
    return result;
  } finally {
    current?.delete();
    binSolidRef.value?.delete();
  }
}
