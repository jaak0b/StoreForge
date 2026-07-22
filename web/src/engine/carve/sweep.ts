// Flow-neutral sweep and draft machinery for carved bins: the upward Minkowski
// sweep that opens a pocket so an object with an undercut can still drop in, the
// draft-angle validation and defaults, the reach and length derivations, and the
// approximation-budget tolerances the carve pipeline spends. Framework-agnostic;
// the ManifoldToplevel is injected as everywhere else in the engine.
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { CARVE_OVERLAP_EPS } from '../gridfinity/carvedBin';
import { HEIGHT_UNIT, LIP_HEIGHT } from '../gridfinity/constants';
import { circleSegments } from '../geometry/circleSegments';

/**
 * Default draft angle of a swept pocket, in degrees: a straight vertical sweep
 * with no flare. The single home for the figure; the import flow and the plan
 * loader default both read it from here.
 */
export const DEFAULT_DRAFT_ANGLE_DEG = 0;

/**
 * Whether a draft angle is one the sweep can build: a finite number from 0 up
 * to but not including 90 degrees. The upper bound is exclusive because
 * tan(90 degrees) is unbounded, so the cone radius, and with it the pocket,
 * would be infinite; the bound is a property of the geometry, not a tuned
 * figure. The single home for the question: the plan validator and the editor
 * commit both ask it here.
 */
export function isDraftAngleDegValid(draftAngleDeg: number): boolean {
  return Number.isFinite(draftAngleDeg) && draftAngleDeg >= 0 && draftAngleDeg < 90;
}

/** The draft angle bound as a thrown, user-worded message, for the editor commit. */
export function validateDraftAngleDeg(draftAngleDeg: number): void {
  if (!isDraftAngleDegValid(draftAngleDeg)) {
    throw new Error(
      'The draft angle must be a number from 0 up to but not including 90 degrees.',
    );
  }
}

/**
 * The geometric error budget the simplification of one model may spend, in mm:
 * one quarter of that model's own clearance.
 *
 * Manifold documents a simplify tolerance as the maximum distance between the
 * original and the simplified mesh, so it is directly comparable to the
 * clearance, which is the fit budget.
 *
 * Benchmarked 2026-07-20 on a real 127k-triangle model: a tolerance of
 * clearance/10 left 18k triangles and a 40 s Minkowski offset, while
 * clearance/4 (0.1 mm at the 0.4 mm default) leaves about 8k triangles and
 * about 20 s. The worst case is 0.1 mm of one-sided under-dilation in concave
 * detail, so the pocket can be slightly tighter but never looser, and the
 * volume difference is about 1 percent.
 *
 * Per model, because the clearance is. Two models in one bin with different
 * clearances carry different tolerances and one may not be simplified at all;
 * the guarantee is per model, so there is no bin-wide fit property for a
 * bin-wide tolerance to protect.
 */
export function simplifyToleranceMm(clearanceMm: number): number {
  return clearanceMm / 4;
}

/**
 * The geometric error budget the sweep stage of one model may spend, in mm:
 * half of that model's own clearance. One coherent budget for the whole stage:
 * the pre-sweep simplification of the rotated dilated cutter and the sweep
 * cone's faceting both spend it, so the stage's approximation is stated once.
 *
 * Coarser than the clearance offset pipeline's quarter rule above, and
 * deliberately so, because the Minkowski sweep's cost is near-linear in input
 * triangles times cone facet count. Benchmarked 2026-07-20 on a real
 * 25.6k-triangle cutter at draft angle 10: the sweep fell from 143 s to
 * 13.7 s under this budget, with volume within -0.68 percent, the bounding
 * box within 0.05 mm, status NoError and genus preserved. The approximation
 * errs toward a tighter pocket, never a looser one, exactly as the simplify
 * budget above does.
 */
export function sweepToleranceMm(clearanceMm: number): number {
  return clearanceMm / 2;
}

/**
 * Where a swept pocket must reach, in bin-local mm: past the lip crest, which
 * is the bin's physical top, plus the same weld overlap the interior fill
 * uses, so the pocket provably opens through everything the bin has above it
 * rather than leaving lip material overhanging the pocket mouth. Derived from
 * the same envelope figures the rest of the geometry uses (the nominal top is
 * heightUnits * HEIGHT_UNIT, the lip stands LIP_HEIGHT above it); no constant
 * of its own.
 */
export function sweptReachZ(heightUnits: number): number {
  return heightUnits * HEIGHT_UNIT + LIP_HEIGHT + CARVE_OVERLAP_EPS;
}

/**
 * The expensive sweep step: the Minkowski sum of a dilated cutter with a
 * vertical segment (draft angle 0) or a vertical cone widening upward (draft
 * angle greater than 0), over the given length. The result has no overhang
 * along Z, so the printed pocket can receive an object with an undercut, and
 * a positive draft angle leans the walls outward by exactly that angle.
 *
 * The sweep is world vertical and therefore not rotation invariant: sweeping
 * then rotating is not the same solid as rotating then sweeping. It must run
 * on the ROTATED solid, after the placement rotation. It IS translation
 * invariant (a Minkowski sum commutes with translation), which is what lets
 * the worker cache the swept solid in the rotated frame and merely translate
 * it for every drag.
 *
 * The segment of the draft angle 0 case is modelled as a square prism of
 * half-width CARVE_OVERLAP_EPS, because a true zero width segment is not a
 * manifold; the operand must have volume. The half-width is the shared weld
 * overlap figure, so the horizontal over-carve it adds is bounded by the same
 * 0.01 mm every welded joint in the bin already absorbs, far below FDM
 * positional resolution. The cone of the positive case starts from the same
 * base half-width so the two cases agree at angle 0, and its top radius adds
 * tan(draftAngleDeg) times the sweep length, which is what makes the wall
 * angle exact.
 *
 * The whole sweep stage spends one approximation budget, sweepToleranceMm
 * (clearance / 2), stated once there with its benchmark justification, and it
 * is spent coherently in two places: the rotated dilated cutter is simplified
 * to that tolerance immediately before the sum (the sum's cost is near-linear
 * in input triangles times facet count, and the simplification errs toward a
 * tighter pocket, never a looser one), and the cone's facet count comes from
 * the shared circleSegments derivation against the same tolerance. When the
 * clearance is 0 there is no budget to spend: the input is not simplified
 * (the user asked for an exact subtraction) and the cone facets against the
 * quarter rule evaluated on its own top radius, so no constant enters either
 * way. The faceted cone is inscribed in the true cone, exactly as the
 * clearance sphere is, so the flare dips slightly under nominal between facet
 * vertices and never over it.
 *
 * Takes ownership of `solid` and returns the swept solid to the caller.
 */
export function sweepSolidUpward(
  m: ManifoldToplevel,
  solid: Manifold,
  spec: { lengthMm: number; draftAngleDeg: number; clearanceMm: number },
): Manifold {
  const { lengthMm, draftAngleDeg, clearanceMm } = spec;
  let operand: Manifold | null = null;
  // Holds whichever input solid this function currently owns, so the finally
  // releases exactly one whether the simplify ran, threw, or was skipped.
  let input: Manifold = solid;
  try {
    validateDraftAngleDeg(draftAngleDeg);
    if (clearanceMm > 0) {
      // The stage's own simplification, against the sweep budget; see the doc
      // comment above and sweepToleranceMm for the benchmark.
      const simplified = input.simplify(sweepToleranceMm(clearanceMm));
      input.delete();
      input = simplified;
    }
    const baseHalfWidthMm = CARVE_OVERLAP_EPS;
    if (draftAngleDeg === 0) {
      operand = m.Manifold.cube(
        [2 * baseHalfWidthMm, 2 * baseHalfWidthMm, lengthMm],
        true,
      ).translate([0, 0, lengthMm / 2]);
    } else {
      const radiusHighMm =
        baseHalfWidthMm + Math.tan((draftAngleDeg * Math.PI) / 180) * lengthMm;
      const toleranceMm =
        clearanceMm > 0
          ? sweepToleranceMm(clearanceMm)
          : simplifyToleranceMm(radiusHighMm);
      operand = m.Manifold.cylinder(
        lengthMm,
        baseHalfWidthMm,
        radiusHighMm,
        circleSegments(radiusHighMm, toleranceMm),
      );
    }
    const swept = input.minkowskiSum(operand);
    const status = swept.status();
    if (status !== 'NoError') {
      swept.delete();
      throw new Error(
        `Sweeping a pocket open upward produced an invalid solid: ${status}.`,
      );
    }
    return swept;
  } finally {
    operand?.delete();
    input.delete();
  }
}

/**
 * The shortest sweep length that carries the lowest point of a solid up to the
 * swept reach, floored at the weld overlap so a solid already above the reach
 * still sweeps a degenerate sliver rather than a negative length. Derived from
 * the same figures on both the direct and the memoized path, which is what
 * keeps the two paths identical.
 */
export function minSweepLengthMm(reachZ: number, lowestPointZ: number): number {
  return Math.max(CARVE_OVERLAP_EPS, reachZ - lowestPointZ);
}

/**
 * Finish a swept solid into the cutter the carve subtracts: trim everything
 * above the swept reach. The trim serves two masters at once. It makes the
 * cutter, and with it the footprints and the warnings, independent of the
 * sweep length the solid happened to be built with: every column at or above
 * the minimum length reaches the plane, so any sufficient length yields this
 * identical flat-topped cutter, which is the equality the worker's cache
 * rests on. And it bounds the reported pocket to what the bin can actually
 * contain, instead of a column whose height depends on an internal figure.
 *
 * Takes ownership of `swept`.
 */
export function trimSweptCutter(swept: Manifold, reachZ: number): Manifold {
  const cutter = swept.trimByPlane([0, 0, -1], -reachZ);
  swept.delete();
  return cutter;
}

/**
 * Sweep an already placed cutter straight up and out of the bin, as one call:
 * the sweep step over the derived minimum length, then the trim. The direct,
 * uncached form of what the carved-bin assemblers (buildCutoutBinBody,
 * buildPocketBinBody) assemble from the same parts; the
 * tests hold the two equal. Takes ownership of `placed`.
 */
export function sweepCutterUpward(
  m: ManifoldToplevel,
  placed: Manifold,
  spec: { heightUnits: number; draftAngleDeg: number; clearanceMm: number },
): Manifold {
  const reachZ = sweptReachZ(spec.heightUnits);
  const lengthMm = minSweepLengthMm(reachZ, placed.boundingBox().min[2]);
  const swept = sweepSolidUpward(m, placed, {
    lengthMm,
    draftAngleDeg: spec.draftAngleDeg,
    clearanceMm: spec.clearanceMm,
  });
  return trimSweptCutter(swept, reachZ);
}
