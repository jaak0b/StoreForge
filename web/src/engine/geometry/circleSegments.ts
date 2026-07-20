// How finely a circle or a sphere primitive is faceted for a given error
// budget. Pure math: no CSG, no WASM, no dependencies. It lives here rather
// than in either flow that needs it because circle faceting belongs to
// neither: the traced outline offsets and the cutout clearance offset spend
// different tolerances against the same derivation.

/**
 * Floor on segments per full circle so tiny radii still look round. A radius
 * small enough that its whole circle fits inside the error budget would
 * otherwise derive a count of 3.
 */
export const MIN_CIRCLE_SEGMENTS = 12;

/**
 * Segments for a full circle of the given radius under a maximum chordal
 * deviation, rounded up to a multiple of 4 so the four axis extremes land on
 * vertices and a primitive's bounds are exactly the requested dimensions.
 *
 * The chord of one segment subtending an angle `step` departs from the arc by
 * the sagitta `radiusMm * (1 - cos(step / 2))`. Bounding that by `toleranceMm`
 * and solving for the angle gives `step = 2 * acos(1 - toleranceMm / radiusMm)`
 * and a full circle needs `ceil(2 * pi / step)` of them.
 *
 * The same sagitta bound is the faceting error of a sphere primitive, so a
 * clearance offset sphere takes its resolution from here too. What differs
 * between callers is only the tolerance each is willing to spend, which is the
 * caller's own accuracy policy and is passed in.
 */
export function circleSegments(radiusMm: number, toleranceMm: number): number {
  let n = MIN_CIRCLE_SEGMENTS;
  if (radiusMm > toleranceMm) {
    const step = 2 * Math.acos(1 - toleranceMm / radiusMm);
    n = Math.max(MIN_CIRCLE_SEGMENTS, Math.ceil((2 * Math.PI) / step));
  }
  return Math.ceil(n / 4) * 4;
}
