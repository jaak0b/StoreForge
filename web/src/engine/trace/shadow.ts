// Post-filter that removes drop-shadow and paper-halo pixels a SAM mask picked
// up on the white sheet, using the rectified color image. Tools laid on paper
// cast soft gray shadows that share the tool's boundary, and the mask decoder's
// limited resolution often leaves a ring of plain bright paper around the tool;
// SAM folds both into the mask. Neither is part of the tool: a shadow is a gray
// attenuation of the white sheet, the halo is the white sheet itself, and both
// have near-zero saturation. This module identifies the low-saturation pixels
// (mid-luminance shadow or bright paper) that hang off the mask boundary and
// clears them, keeping interior detail and any genuinely colored region.
//
// This stage is opt-in: the caller runs it only when the photo actually has
// strong shadows. Its luminance model cannot tell a gray cast shadow from a
// gray metal tool, because on a sheet where paper owns the bright Otsu class
// both of them occupy the middle class. A chrome tool photographed on paper is
// therefore classified as shadow and deleted, so the stage must not run by
// default.
import { extractSaturation, type Cv, type CvMat } from './paper';

/** Three-class luminance split from multilevel Otsu. */
export interface MultilevelOtsuResult {
  /** Upper bound of the dark class: v <= t1 is dark tool, v > t1 is removable. */
  t1: number;
  /** Upper bound of the middle class: t1 < v <= t2 is the mid-luminance shadow. */
  t2: number;
  /** True when all three classes carry nonzero histogram weight. */
  classesNonEmpty: boolean;
}

/**
 * Three-class (two-threshold) Otsu on a 256-bin luminance histogram. Finds the
 * threshold pair (t1, t2) with 0 <= t1 < t2 <= 255 maximizing the between-class
 * variance, the standard multilevel Otsu criterion (Otsu 1979, generalized to
 * multiple thresholds). Prefix sums of hist[i] (class weight) and i*hist[i]
 * (class intensity moment) make the between-class variance of each candidate
 * pair an O(1) lookup, so the exhaustive search over all pairs is O(256^2).
 *
 * classesNonEmpty is false when any of the three classes {v<=t1}, {t1<v<=t2},
 * {v>t2} carries zero weight at the chosen split, which signals a degenerate
 * (fewer than three luminance populations) image to the caller.
 */
export function multilevelOtsu(hist: ArrayLike<number>): MultilevelOtsuResult {
  const bins = 256;
  // Prefix sums: weightPrefix[k] = sum of hist[0..k-1], momentPrefix[k] the
  // same weighted by intensity. Length bins+1 so a class [a, b) is a simple
  // difference of prefix entries.
  const weightPrefix = new Float64Array(bins + 1);
  const momentPrefix = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i += 1) {
    weightPrefix[i + 1] = weightPrefix[i] + hist[i];
    momentPrefix[i + 1] = momentPrefix[i] + i * hist[i];
  }
  const totalWeight = weightPrefix[bins];
  const totalMoment = momentPrefix[bins];

  // Between-class variance for a class spanning bins [a, b): weight * mean^2.
  // Summing this term across the three classes is equivalent to maximizing the
  // full between-class variance because the total mean term is constant.
  const classTerm = (a: number, b: number): number => {
    const weight = weightPrefix[b] - weightPrefix[a];
    if (weight === 0) {
      return 0;
    }
    const mean = (momentPrefix[b] - momentPrefix[a]) / weight;
    return weight * mean * mean;
  };

  let bestT1 = 0;
  let bestT2 = 1;
  let bestVariance = -1;
  for (let t1 = 0; t1 < bins - 1; t1 += 1) {
    // Dark class covers bins [0, t1]; encoded as the half-open range [0, t1+1).
    const darkTerm = classTerm(0, t1 + 1);
    for (let t2 = t1 + 1; t2 < bins; t2 += 1) {
      // Middle class bins [t1+1, t2] and bright class bins [t2+1, 255].
      const midTerm = classTerm(t1 + 1, t2 + 1);
      const brightTerm = classTerm(t2 + 1, bins);
      const variance = darkTerm + midTerm + brightTerm;
      if (variance > bestVariance) {
        bestVariance = variance;
        bestT1 = t1;
        bestT2 = t2;
      }
    }
  }

  const darkWeight = weightPrefix[bestT1 + 1];
  const midWeight = weightPrefix[bestT2 + 1] - weightPrefix[bestT1 + 1];
  const brightWeight = totalWeight - weightPrefix[bestT2 + 1];
  // totalMoment is referenced so the between-class formulation stays explicit;
  // it carries no per-pair cost.
  void totalMoment;
  return {
    t1: bestT1,
    t2: bestT2,
    classesNonEmpty: darkWeight > 0 && midWeight > 0 && brightWeight > 0,
  };
}

/**
 * Remove border-connected shadow and paper-halo pixels from a binary SAM mask
 * in place, using the rectified color sheet. Mutates `mask` (CV_8UC1, 0/255).
 * `rectified` is the RGBA (CV_8UC4) top-down sheet image at the same dimensions
 * as the mask.
 *
 * Both `mask` and `rectified` are caller-owned and are never deleted here.
 * A dimension mismatch is a programming error and throws rather than being
 * silently tolerated.
 */
export function removeShadow(cv: Cv, rectified: CvMat, mask: CvMat): void {
  if (rectified.rows !== mask.rows || rectified.cols !== mask.cols) {
    throw new Error(
      `removeShadow: rectified (${rectified.rows}x${rectified.cols}) and mask ` +
        `(${mask.rows}x${mask.cols}) must have the same dimensions.`,
    );
  }

  const gray = new cv.Mat();
  let sat: CvMat | null = null;
  const satMask = new cv.Mat();
  const removable = new cv.Mat();
  const labels = new cv.Mat();
  const bg = new cv.Mat();
  const bgDilated = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  try {
    // Step 0: luminance. Mirror paper.ts toGray channel handling for robustness
    // to non-RGBA inputs.
    if (rectified.channels() === 4) {
      cv.cvtColor(rectified, gray, cv.COLOR_RGBA2GRAY);
    } else if (rectified.channels() === 3) {
      cv.cvtColor(rectified, gray, cv.COLOR_RGB2GRAY);
    } else {
      rectified.copyTo(gray);
    }

    // Step 1: multilevel (3-class) Otsu on the luminance histogram. Build the
    // histogram with a plain loop so no extra Mats are needed.
    const hist = new Float64Array(256);
    const grayData = gray.data;
    for (let i = 0; i < grayData.length; i += 1) {
      hist[grayData[i]] += 1;
    }
    const { t1, classesNonEmpty } = multilevelOtsu(hist);
    if (!classesNonEmpty) {
      // Degenerate multilevel Otsu: a luminance class is empty, skip shadow
      // removal. With fewer than three luminance populations there is no
      // middle band to attribute to a shadow, so leave the mask untouched.
      return;
    }

    // Step 2: 2-class Otsu on the saturation channel. The RGBA -> RGB -> HSV
    // channel path lives in paper.ts's extractSaturation, shared so it is not
    // duplicated here. Otsu splits neutral (gray) from chromatic pixels;
    // 255 = chromatic, 0 = neutral.
    sat = extractSaturation(cv, rectified);
    // On a fully grayscale scene the saturation channel is just sensor noise,
    // and Otsu will still split it into "neutral" and "chromatic" halves, so
    // some neutral pixels get classed chromatic and are spared from removal.
    // That only makes the filter remove less than it could (it never removes a
    // pixel it should have kept), which is the safe failure direction here.
    cv.threshold(sat, satMask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    // Step 3: removable candidate = in the SAM mask AND low saturation AND not
    // dark tool (mid-luminance shadow or bright paper halo, v > t1). The bright
    // class is included so plain paper the decoder wrapped around the tool is a
    // candidate too, not just the mid-luminance shadow band. One pass over the
    // flat buffers.
    removable.create(mask.rows, mask.cols, cv.CV_8UC1);
    const maskData = mask.data;
    const satMaskData = satMask.data;
    const removableData = removable.data;
    for (let i = 0; i < maskData.length; i += 1) {
      const v = grayData[i];
      removableData[i] =
        maskData[i] && v > t1 && satMaskData[i] === 0 ? 255 : 0;
    }

    // Step 4: keep only candidate components that touch the background. A real
    // interior midtone or bright speckle (a decal or a specular highlight on the
    // tool) is fully enclosed by tool pixels and must survive; a cast shadow or
    // paper halo hangs off the tool's edge and is 8-adjacent to background.
    // Label the candidate with connected components, then dilate the ORIGINAL
    // mask's complement by a 3x3 rect kernel so a candidate pixel is 8-adjacent
    // to background exactly where the dilated complement is nonzero.
    cv.connectedComponents(removable, labels, 8, cv.CV_32S);
    cv.bitwise_not(mask, bg);
    cv.dilate(bg, bgDilated, kernel);
    const labelData = labels.data32S;
    const bgDilatedData = bgDilated.data;
    const touches = new Map<number, boolean>();
    for (let i = 0; i < removableData.length; i += 1) {
      if (removableData[i] === 0) {
        continue;
      }
      const label = labelData[i];
      if (label === 0) {
        continue; // Label 0 is background of the candidate image itself.
      }
      if (bgDilatedData[i]) {
        touches.set(label, true);
      }
    }
    for (let i = 0; i < removableData.length; i += 1) {
      if (removableData[i] !== 0 && touches.get(labelData[i])) {
        maskData[i] = 0;
      }
    }
  } finally {
    gray.delete();
    if (sat) {
      sat.delete();
    }
    satMask.delete();
    removable.delete();
    labels.delete();
    bg.delete();
    bgDilated.delete();
    kernel.delete();
  }
}
