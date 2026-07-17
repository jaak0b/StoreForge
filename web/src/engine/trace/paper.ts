// Paper sheet detection and mm scale calibration for the tool-trace feature.
// A photo of tools laid on a Letter or A4 sheet is calibrated by finding the
// sheet, warping it to a top-down view, and reading the mm-per-pixel scale
// from the known paper size.
import type {
  PaperCalibration,
  PaperCorners,
  PaperDetectionResult,
  PaperKind,
  PixelPoint,
} from './types';

/** The opencv.js namespace, passed in by the caller so this module stays WASM-free. */
export type Cv = typeof import('@techstark/opencv-js');
/** An opencv.js image matrix. */
export type CvMat = import('@techstark/opencv-js').Mat;

/**
 * Physical sheet dimensions in millimeters.
 * Letter is 8.5 x 11 in per ANSI/ASME Y14.1 (215.9 x 279.4 mm exactly);
 * A4 is 210 x 297 mm per ISO 216.
 */
export const PAPER_SIZES: Record<PaperKind, { shortMm: number; longMm: number }> = {
  letter: { shortMm: 215.9, longMm: 279.4 },
  a4: { shortMm: 210, longMm: 297 },
};

/**
 * Rectified image resolution. 4 px/mm resolves outlines to 0.25 mm, matching
 * the contour fidelity a printed tool cutout needs, while keeping a full A4
 * sheet at 840 x 1188 RGBA pixels (about 4 MB), so memory stays bounded.
 */
export const RECTIFIED_PX_PER_MM = 4;

/** A sheet candidate must cover at least this fraction of the photo. */
const MIN_AREA_FRACTION = 0.2;

/** Physical width and height in mm for a sheet in the given orientation. */
export function paperSizeFor(
  kind: PaperKind,
  orientation: 'portrait' | 'landscape' = 'portrait',
): { widthMm: number; heightMm: number } {
  const size = PAPER_SIZES[kind];
  return orientation === 'landscape'
    ? { widthMm: size.longMm, heightMm: size.shortMm }
    : { widthMm: size.shortMm, heightMm: size.longMm };
}

function distance(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Order four corner points as top-left, top-right, bottom-right, bottom-left. */
function orderCorners(points: PixelPoint[]): PaperCorners {
  // Classic document-scanner ordering: the top-left corner minimizes x + y,
  // the bottom-right maximizes it; top-right maximizes x - y, bottom-left
  // minimizes it. Holds for any convex quad that is roughly axis-aligned.
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.x - a.y - (b.x - b.y));
  return { tl: bySum[0], br: bySum[3], tr: byDiff[3], bl: byDiff[0] };
}

function toGray(cv: Cv, mat: CvMat): CvMat {
  const gray = new cv.Mat();
  if (mat.channels() === 4) {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  } else if (mat.channels() === 3) {
    cv.cvtColor(mat, gray, cv.COLOR_RGB2GRAY);
  } else {
    mat.copyTo(gray);
  }
  return gray;
}

/**
 * Find the sheet of paper as the dominant bright convex quadrilateral.
 * Returns proposed corners in photo pixels with a 0..1 confidence, or a
 * user-worded failure when no plausible sheet is present. The caller is
 * expected to let the user adjust the proposed corners before rectifying.
 */
export function detectPaper(cv: Cv, mat: CvMat): PaperDetectionResult {
  const gray = toGray(cv, mat);
  const blurred = new cv.Mat();
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const imageArea = mat.rows * mat.cols;
  let best: { corners: PaperCorners; area: number; rectangularity: number } | null = null;
  try {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    // Otsu picks the split between the bright sheet and the darker background
    // globally; the sheet then comes out as one large filled component.
    cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const area = cv.contourArea(contour);
        if (area / imageArea < MIN_AREA_FRACTION) {
          continue;
        }
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
        if (approx.rows !== 4 || !cv.isContourConvex(approx)) {
          continue;
        }
        if (best && area <= best.area) {
          continue;
        }
        const points: PixelPoint[] = [];
        for (let p = 0; p < 4; p += 1) {
          points.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
        }
        const rotated = cv.minAreaRect(contour);
        const rotatedArea = rotated.size.width * rotated.size.height;
        best = {
          corners: orderCorners(points),
          area,
          rectangularity: rotatedArea > 0 ? Math.min(1, area / rotatedArea) : 0,
        };
      } finally {
        approx.delete();
        contour.delete();
      }
    }
  } finally {
    gray.delete();
    blurred.delete();
    binary.delete();
    contours.delete();
    hierarchy.delete();
  }
  if (!best) {
    return {
      ok: false,
      error:
        'No paper sheet was found in the photo. Make sure the whole sheet is visible and clearly brighter than the surface it lies on, then try again or place the corners by hand.',
    };
  }
  // How much of the frame the sheet fills (saturating at half the frame) and
  // how close the contour is to a true quadrilateral both raise confidence.
  const areaScore = Math.min(1, best.area / imageArea / 0.5);
  return { ok: true, corners: best.corners, confidence: areaScore * best.rectangularity };
}

/**
 * Warp the photo so the sheet fills a top-down image at RECTIFIED_PX_PER_MM.
 * Orientation (portrait or landscape) is read from the corner geometry.
 * Corners may come from detectPaper or from the user dragging them.
 *
 * The returned mmPerPixel is exact along x by construction
 * (paper width / rectified width). The height is rounded to whole pixels
 * independently, which can make the y scale differ by under 0.01 percent:
 * far below the 0.25 mm contour fidelity target.
 */
export function rectifyPaper(
  cv: Cv,
  mat: CvMat,
  corners: PaperCorners,
  kind: PaperKind,
): { rectified: CvMat; calibration: PaperCalibration } {
  const { tl, tr, br, bl } = corners;
  const horizontalSpan = distance(tl, tr) + distance(bl, br);
  const verticalSpan = distance(tl, bl) + distance(tr, br);
  const orientation = horizontalSpan > verticalSpan ? 'landscape' : 'portrait';
  const { widthMm, heightMm } = paperSizeFor(kind, orientation);
  const rectifiedWidthPx = Math.round(widthMm * RECTIFIED_PX_PER_MM);
  const rectifiedHeightPx = Math.round(heightMm * RECTIFIED_PX_PER_MM);
  const mmPerPixel = widthMm / rectifiedWidthPx;

  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, rectifiedWidthPx, 0, rectifiedWidthPx, rectifiedHeightPx, 0, rectifiedHeightPx,
  ]);
  const transform = cv.getPerspectiveTransform(src, dst);
  const rectified = new cv.Mat();
  try {
    cv.warpPerspective(
      mat,
      rectified,
      transform,
      new cv.Size(rectifiedWidthPx, rectifiedHeightPx),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
  } finally {
    src.delete();
    dst.delete();
    transform.delete();
  }
  return {
    rectified,
    calibration: { corners, kind, mmPerPixel, rectifiedWidthPx, rectifiedHeightPx },
  };
}
