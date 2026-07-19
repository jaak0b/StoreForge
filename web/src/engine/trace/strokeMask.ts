// Applies freehand brush strokes to a segmentation mask in place. Strokes come
// from the painting tool in rectified-image pixels with a radius in mm; each
// stroke is rasterized as a swept disc (a capsule per segment, a filled disc
// per vertex) and then unioned into or subtracted from the mask. Runs after
// shadow removal so painted pixels are never touched by the shadow filter.
import type { Cv, CvMat } from './paper';
import type { BrushStroke } from './types';

/**
 * Rasterize one stroke as white (255) onto `target` (CV_8UC1, caller-owned and
 * not cleared here). The swept disc is drawn as a filled cv.circle at every
 * vertex plus a cv.line of thickness 2 * radiusPx between consecutive vertices.
 * opencv.js line has no round-cap flag, so the per-vertex filled circles supply
 * the round caps and joins the capsule needs. An empty points array is a no-op.
 */
export function rasterizeStroke(
  cv: Cv,
  target: CvMat,
  stroke: BrushStroke,
  mmPerPixel: number,
): void {
  if (stroke.points.length === 0) {
    return;
  }
  // A stroke must mark at least one pixel, so clamp the radius up from any
  // sub-pixel brush size to 1.
  const radiusPx = Math.max(1, Math.round(stroke.radiusMm / mmPerPixel));
  const white = new cv.Scalar(255);
  for (const point of stroke.points) {
    cv.circle(target, new cv.Point(point.x, point.y), radiusPx, white, -1);
  }
  for (let i = 1; i < stroke.points.length; i += 1) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    cv.line(
      target,
      new cv.Point(a.x, a.y),
      new cv.Point(b.x, b.y),
      white,
      2 * radiusPx,
      cv.LINE_8,
    );
  }
}

/**
 * Median-filter aperture in pixels for a smooth stroke, derived from the
 * stroke's own radius (the user's chosen smoothing scale) via mmPerPixel.
 * cv.medianBlur requires an odd aperture greater than 1, so the pixel radius is
 * forced odd and clamped up to 3. No upper clamp is applied: for CV_8U OpenCV
 * runs the constant-time histogram median, so a large aperture stays tractable
 * and capping it would silently shrink the smoothing the user asked for.
 */
function medianKernelSize(stroke: BrushStroke, mmPerPixel: number): number {
  const radiusPx = Math.round(stroke.radiusMm / mmPerPixel);
  const odd = radiusPx % 2 === 0 ? radiusPx + 1 : radiusPx;
  return Math.max(3, odd);
}

/**
 * Apply brush strokes to `mask` (CV_8UC1, 0/255) in place, in stored order so
 * the last stroke wins on overlap. Each stroke is rasterized into a scratch Mat
 * and then composited: an 'add' stroke unions its region into the mask with
 * cv.bitwise_or; an 'erase' stroke clears exactly the painted pixels with
 * Mat.setTo using the scratch as the operation mask; a 'smooth' stroke replaces
 * the mask with its median-filtered self inside the painted pixels only. An
 * empty stroke list returns immediately without allocating. cv failures
 * propagate.
 */
export function applyStrokes(
  cv: Cv,
  mask: CvMat,
  strokes: BrushStroke[],
  mmPerPixel: number,
): void {
  if (strokes.length === 0) {
    return;
  }
  const zero = new cv.Scalar(0);
  const scratch = new cv.Mat(mask.rows, mask.cols, cv.CV_8UC1, zero);
  // Second scratch for the median-filtered mask, allocated on the first smooth
  // stroke so add-only and erase-only stroke lists cost nothing extra.
  let filtered: CvMat | null = null;
  try {
    for (const stroke of strokes) {
      scratch.setTo(zero);
      rasterizeStroke(cv, scratch, stroke, mmPerPixel);
      if (stroke.mode === 'add') {
        cv.bitwise_or(mask, scratch, mask);
      } else if (stroke.mode === 'smooth') {
        // Median filter, an edge-preserving smoother: it removes boundary
        // staircase and speckle while leaving a straight edge in place. The
        // whole mask is filtered and then copied back only where the stroke
        // was painted, so mask area the user did not brush is untouched.
        if (filtered === null) {
          filtered = new cv.Mat(mask.rows, mask.cols, cv.CV_8UC1, zero);
        }
        cv.medianBlur(mask, filtered, medianKernelSize(stroke, mmPerPixel));
        filtered.copyTo(mask, scratch);
      } else {
        // The scratch marks exactly the painted pixels; setTo with it as the
        // operation mask clears only those pixels of the mask.
        mask.setTo(zero, scratch);
      }
    }
  } finally {
    scratch.delete();
    if (filtered !== null) {
      filtered.delete();
    }
  }
}
