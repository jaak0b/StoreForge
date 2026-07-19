// Post-filter that removes boundary quantization noise from a binary SAM mask.
// The decoder emits its mask on a coarse grid (LOW_RES_MASK_SIZE cells across
// the encoder frame) which is then hard-thresholded and upsampled to the
// rectified image. The resulting boundary carries a pixel staircase whose step
// size is set by the upsampling ratio, not by the tool's real shape: it is
// quantization noise below the model's resolution limit. This module filters
// the mask at that limit so the staircase goes away while any feature the
// decoder could actually resolve is left alone.
import type { Cv, CvMat } from './paper';

/**
 * Smooth a binary mask (CV_8UC1, 0/255) at the segmentation model's own
 * resolution limit, in place. The SAM mask grid is coarser than the rectified
 * image, so boundary detail finer than one mask cell is quantization noise
 * rather than shape information. Gaussian blur with a kernel of one cell pitch
 * followed by a 50 percent level threshold removes exactly that noise while
 * leaving features that span multiple cells untouched.
 *
 * `cellPitchPx` is the size of one mask-grid cell in rectified pixels. `mask`
 * is caller-owned and is never deleted here.
 */
export function smoothToResolutionLimit(cv: Cv, mask: CvMat, cellPitchPx: number): void {
  // Kernel spans one mask cell, rounded to the nearest odd integer because
  // GaussianBlur requires an odd kernel so it has a defined center tap.
  const kernel = 2 * Math.round((cellPitchPx - 1) / 2) + 1;
  if (kernel < 3) {
    // Degenerate case: the mask grid is at or finer than the rectified image,
    // so a cell is a pixel or less and there is no sub-resolution detail to
    // filter. The smallest kernel that averages a pixel with its neighbours is
    // 3; anything below that would be an identity blur. Leave the mask as is.
    return;
  }

  const blurred = new cv.Mat();
  try {
    // Gaussian blur with OpenCV's kernel-derived sigma: passing sigma 0 makes
    // GaussianBlur compute sigma from the kernel size using its documented
    // formula, so the cell pitch remains the only input to the filter's scale.
    cv.GaussianBlur(
      mask,
      blurred,
      new cv.Size(kernel, kernel),
      0,
      0,
      cv.BORDER_REPLICATE,
    );
    // Re-binarize at the 50 percent level of the 0/255 range, the standard
    // level-set threshold for a smoothed binary mask. 127 is the midpoint of
    // that range by definition, not a tuned value.
    cv.threshold(blurred, mask, 127, 255, cv.THRESH_BINARY);
  } finally {
    blurred.delete();
  }
}
