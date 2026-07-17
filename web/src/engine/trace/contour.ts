// Post-processing of a segmentation mask into a clean tool outline in sheet
// millimeters. The mask comes from the SAM decoder; this module denoises it,
// picks the contour the user clicked, keeps real through-holes, simplifies
// the polygons to a mm tolerance, and converts to physical coordinates.
import type { Cv, CvMat } from './paper';
import type { MmPoint, PixelPoint, TracedOutline } from './types';

/** Options for maskToContour. */
export interface MaskContourOptions {
  /** Millimeters per mask pixel, from the paper calibration. */
  mmPerPixel: number;
  /** The first include click, in mask pixels; selects the intended contour. */
  includePoint: PixelPoint;
  /**
   * Polygon simplification tolerance in mm (approxPolyDP epsilon). 0.2 mm by
   * default: below the 0.25 mm rectified pixel size, so simplification never
   * costs more accuracy than the raster already did.
   */
  toleranceMm?: number;
  /**
   * Holes smaller than this area in mm^2 are dropped as segmentation noise;
   * larger ones (a tool's hanging hole) are kept. 3 mm^2 by default, just
   * under a 2 mm drill hole, the smallest hanging hole worth reproducing.
   */
  minHoleAreaMm2?: number;
}

const DEFAULT_TOLERANCE_MM = 0.2;
const DEFAULT_MIN_HOLE_AREA_MM2 = 3;

/** Signed shoelace area; positive for one winding direction, negative for the other. */
function shoelaceArea(points: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Simplify a contour Mat with approxPolyDP and convert its vertices to mm. */
function contourToMmPolygon(
  cv: Cv,
  contour: CvMat,
  epsilonPx: number,
  mmPerPixel: number,
): MmPoint[] {
  const approx = new cv.Mat();
  try {
    cv.approxPolyDP(contour, approx, epsilonPx, true);
    const points: MmPoint[] = [];
    for (let i = 0; i < approx.rows; i += 1) {
      points.push({
        x: approx.data32S[i * 2] * mmPerPixel,
        y: approx.data32S[i * 2 + 1] * mmPerPixel,
      });
    }
    return points;
  } finally {
    approx.delete();
  }
}

/** Reverse the polygon in place if its shoelace area sign does not match. */
function orient(points: MmPoint[], positive: boolean): MmPoint[] {
  const area = shoelaceArea(points);
  if ((area > 0) !== positive) {
    points.reverse();
  }
  return points;
}

/**
 * Extract a clean tool outline from a binary mask (CV_8UC1, nonzero inside).
 *
 * The mask is denoised with a morphological open (removes speck islands and
 * single-pixel whiskers) followed by close. The close doubles as the smoothing
 * step: it rounds pixel stair-steps below the kernel radius before polygon
 * approximation, while a vertex moving average would instead displace the true
 * corners of straight tool edges, so closing is the better fit for hard-edged
 * tool silhouettes.
 *
 * Among the denoised external contours, the largest one containing the include
 * click is chosen (or, if the click landed just outside every contour, the
 * nearest one). Its holes above minHoleAreaMm2 are kept as children.
 *
 * Returns null when the mask contains no usable contour after denoising.
 */
export function maskToContour(
  cv: Cv,
  mask: CvMat,
  options: MaskContourOptions,
): TracedOutline | null {
  const { mmPerPixel, includePoint } = options;
  const toleranceMm = options.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  const minHoleAreaMm2 = options.minHoleAreaMm2 ?? DEFAULT_MIN_HOLE_AREA_MM2;
  const epsilonPx = toleranceMm / mmPerPixel;
  const minHoleAreaPx = minHoleAreaMm2 / (mmPerPixel * mmPerPixel);

  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  const clean = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.morphologyEx(mask, clean, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(clean, clean, cv.MORPH_CLOSE, kernel);
    // RETR_CCOMP yields a two-level hierarchy: external contours and the
    // holes directly inside them. Hierarchy rows are [next, prev, child, parent].
    cv.findContours(clean, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

    const click = { x: includePoint.x, y: includePoint.y };
    let chosen = -1;
    let chosenArea = 0;
    let nearest = -1;
    let nearestDistance = -Infinity;
    for (let i = 0; i < contours.size(); i += 1) {
      if (hierarchy.data32S[i * 4 + 3] !== -1) {
        continue; // A hole, handled through its parent below.
      }
      const contour = contours.get(i);
      try {
        const area = cv.contourArea(contour);
        // The open pass removes small specks; this floor drops any leftover
        // island too small to be a tool (reusing the hole threshold, since a
        // real tool outline is orders of magnitude larger).
        if (area < minHoleAreaPx) {
          continue;
        }
        // Signed distance in px: positive inside, negative outside.
        const distance = cv.pointPolygonTest(contour, click, true);
        if (distance >= 0) {
          if (chosen === -1 || area > chosenArea) {
            chosen = i;
            chosenArea = area;
          }
        } else if (distance > nearestDistance) {
          nearest = i;
          nearestDistance = distance;
        }
      } finally {
        contour.delete();
      }
    }
    if (chosen === -1) {
      chosen = nearest;
    }
    if (chosen === -1) {
      return null;
    }

    const outerContour = contours.get(chosen);
    let outer: MmPoint[];
    try {
      outer = orient(contourToMmPolygon(cv, outerContour, epsilonPx, mmPerPixel), true);
    } finally {
      outerContour.delete();
    }
    if (outer.length < 3) {
      return null;
    }

    const holes: MmPoint[][] = [];
    for (
      let child = hierarchy.data32S[chosen * 4 + 2];
      child !== -1;
      child = hierarchy.data32S[child * 4]
    ) {
      const holeContour = contours.get(child);
      try {
        if (cv.contourArea(holeContour) < minHoleAreaPx) {
          continue;
        }
        const hole = orient(contourToMmPolygon(cv, holeContour, epsilonPx, mmPerPixel), false);
        if (hole.length >= 3) {
          holes.push(hole);
        }
      } finally {
        holeContour.delete();
      }
    }
    return { outer, holes };
  } finally {
    kernel.delete();
    clean.delete();
    contours.delete();
    hierarchy.delete();
  }
}
