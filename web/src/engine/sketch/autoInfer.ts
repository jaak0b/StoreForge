// Auto horizontal/vertical inference for freshly drawn lines. This is a UI
// convenience threshold, not a measurement tolerance: convention 12's
// established-algorithm bar governs the measurement pipeline (sheet
// detection, calibration, contour math), not a display-layer snap heuristic
// like this one. Single source used by both the store (constraint applied on
// placement) and the canvas (pre-commit hint glyph), per convention 10.

/** The snap band, in degrees from an axis, within which a drawn line is
 * treated as intentionally horizontal or vertical. */
export const AUTO_HV_SNAP_DEG = 2;

export type HVInference = 'horizontal' | 'vertical' | null;

/**
 * Whether the segment (dx, dy) falls within AUTO_HV_SNAP_DEG of the
 * horizontal or vertical axis. Returns null outside the snap band or for a
 * degenerate (zero-length) segment.
 */
export function inferHVConstraint(dx: number, dy: number): HVInference {
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const angleDeg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (angleDeg <= AUTO_HV_SNAP_DEG) return 'horizontal';
  if (angleDeg >= 90 - AUTO_HV_SNAP_DEG) return 'vertical';
  return null;
}
