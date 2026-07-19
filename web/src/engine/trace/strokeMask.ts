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
 * Apply brush strokes to `mask` (CV_8UC1, 0/255) in place, in stored order so
 * the last stroke wins on overlap. Each stroke is rasterized into a scratch Mat
 * and then composited: an 'add' stroke unions its region into the mask with
 * cv.bitwise_or; an 'erase' stroke clears exactly the painted pixels with
 * Mat.setTo using the scratch as the operation mask. An empty stroke list
 * returns immediately without allocating. cv failures propagate.
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
  try {
    for (const stroke of strokes) {
      scratch.setTo(zero);
      rasterizeStroke(cv, scratch, stroke, mmPerPixel);
      if (stroke.mode === 'add') {
        cv.bitwise_or(mask, scratch, mask);
      } else {
        // The scratch marks exactly the painted pixels; setTo with it as the
        // operation mask clears only those pixels of the mask.
        mask.setTo(zero, scratch);
      }
    }
  } finally {
    scratch.delete();
  }
}
