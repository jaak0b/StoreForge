// Post-processing of a segmentation mask into a clean tool outline in sheet
// millimeters. The mask comes from the SAM decoder; this module denoises it,
// picks the contour the user clicked, keeps real through-holes, simplifies
// the polygons to a mm tolerance, and converts to physical coordinates.
import type { Cv, CvMat } from './paper';
import type { MmPoint, PixelPoint, TracedOutline } from './types';
import { signedArea } from './edit';

/** A failure reason from maskToContour, mapped to user prose by the caller. */
export type MaskContourFailure = 'empty' | 'noContainingRegion';

/**
 * The chosen region in rectified-image PIXEL coordinates: the same simplified
 * polygons as the mm `outline`, before the mm conversion. The worker rasterizes
 * these back to a pixel mask (outer filled, kept holes cleared) to tell mask
 * pixels that survive into the trace from stray regions that get dropped,
 * reusing this module's selection instead of recomputing it (see the coloring
 * and painted-area checks in the vision worker).
 */
export interface PixelOutline {
  outer: PixelPoint[];
  holes: PixelPoint[][];
}

/** Discriminated result of maskToContour: an outline or a typed failure reason. */
export type MaskContourResult =
  | { ok: true; outline: TracedOutline; pixelOutline: PixelOutline }
  | { ok: false; reason: MaskContourFailure };

/** Options for maskToContour. */
export interface MaskContourOptions {
  /** Millimeters per mask pixel, from the paper calibration. */
  mmPerPixel: number;
  /**
   * The include clicks (all label-1 prompts), in mask pixels. The chosen
   * contour is the one containing the most of these points.
   */
  includePoints: PixelPoint[];
  /**
   * Additional include evidence from add-stroke vertices (rectified pixels).
   * Counted toward each contour's include score exactly like includePoints,
   * so a region the user painted becomes selectable, but they do not relax
   * the "at least one include click" precondition. Default empty.
   */
  paintedIncludePoints?: PixelPoint[];
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

/** Simplify a contour Mat with approxPolyDP, returning its vertices in pixels. */
function contourToPixelPolygon(cv: Cv, contour: CvMat, epsilonPx: number): PixelPoint[] {
  const approx = new cv.Mat();
  try {
    cv.approxPolyDP(contour, approx, epsilonPx, true);
    const points: PixelPoint[] = [];
    for (let i = 0; i < approx.rows; i += 1) {
      points.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
    }
    return points;
  } finally {
    approx.delete();
  }
}

/** Scale a pixel polygon to millimeters, preserving vertex order and winding. */
function pixelToMmPolygon(points: PixelPoint[], mmPerPixel: number): MmPoint[] {
  return points.map((p) => ({ x: p.x * mmPerPixel, y: p.y * mmPerPixel }));
}

/**
 * Reverse the polygon in place if its shoelace area sign does not match. The
 * pixel-to-mm scaling is a positive uniform scale, so the winding sign is the
 * same in either frame; orienting the pixel polygon fixes both.
 */
function orient(points: PixelPoint[], positive: boolean): PixelPoint[] {
  const area = signedArea(points);
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
 * Selection follows a strict hierarchy over the denoised external contours
 * above the area floor. First, include clicks decide: the chosen contour
 * contains the most include clicks (pointPolygonTest >= 0), ties breaking to
 * the largest by area. Only when no contour contains any include click do
 * add-stroke vertices (paintedIncludePoints) rescue the selection, rescored the
 * same way (plurality, area tiebreak), so a region the user painted can still
 * be picked when the clicks miss. Painted vertices never dilute the click vote:
 * a brush drag contributes many vertices whose count would otherwise swamp the
 * explicit clicks and vary with the pointer sampling rate. Connected paint still
 * merges into the clicked contour before selection, so a bridging stroke grows
 * the clicked region rather than competing with it. The requirement that at
 * least one include click was given is never relaxed. The chosen contour's
 * holes above minHoleAreaMm2 are kept as children. There is no nearest-contour
 * fallback: a point that lands outside every contour contributes to no count.
 *
 * Returns { ok: false, reason } when no contour survives denoising ('empty')
 * or when contours survive but none contains any include point
 * ('noContainingRegion').
 */
export function maskToContour(
  cv: Cv,
  mask: CvMat,
  options: MaskContourOptions,
): MaskContourResult {
  const { mmPerPixel, includePoints } = options;
  if (includePoints.length === 0) {
    // No include points would make every contour vacuously qualify; refuse.
    return { ok: false, reason: 'noContainingRegion' };
  }
  const toleranceMm = options.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  const minHoleAreaMm2 = options.minHoleAreaMm2 ?? DEFAULT_MIN_HOLE_AREA_MM2;
  const epsilonPx = toleranceMm / mmPerPixel;
  const minHoleAreaPx = minHoleAreaMm2 / (mmPerPixel * mmPerPixel);

  // 3x3 is the minimal ellipse kernel: at the mask's working resolution
  // (RECTIFIED_PX_PER_MM = 4 px/mm) its radius reaches about 0.75 mm, enough
  // to remove single-pixel speckle without rounding off real tool corners
  // that a larger kernel would erode.
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

    // Collect the external contours above the area floor once. The open pass
    // removes small specks; this floor drops any leftover island too small to
    // be a tool (reusing the hole threshold, since a real tool outline is
    // orders of magnitude larger).
    const eligible: { index: number; area: number }[] = [];
    for (let i = 0; i < contours.size(); i += 1) {
      if (hierarchy.data32S[i * 4 + 3] !== -1) {
        continue; // A hole, handled through its parent below.
      }
      const contour = contours.get(i);
      try {
        const area = cv.contourArea(contour);
        if (area >= minHoleAreaPx) {
          eligible.push({ index: i, area });
        }
      } finally {
        contour.delete();
      }
    }

    // Score the eligible contours by how many of the given points each contains
    // (pointPolygonTest with measureDist=false returns >= 0 inside, boundary
    // counting as inside). The winner holds the most; area breaks ties. Returns
    // -1 when no contour contains any point.
    const selectByPoints = (points: PixelPoint[]): number => {
      const testPoints = points.map((point) => new cv.Point(point.x, point.y));
      let chosenIndex = -1;
      let chosenArea = 0;
      let chosenCount = 0;
      for (const { index, area } of eligible) {
        const contour = contours.get(index);
        try {
          const count = testPoints.reduce(
            (total, point) => total + (cv.pointPolygonTest(contour, point, false) >= 0 ? 1 : 0),
            0,
          );
          if (count > 0 && (count > chosenCount || (count === chosenCount && area > chosenArea))) {
            chosenIndex = index;
            chosenArea = area;
            chosenCount = count;
          }
        } finally {
          contour.delete();
        }
      }
      return chosenIndex;
    };

    // Include clicks decide the selection. Only when no contour contains any
    // include click do painted add-stroke vertices rescue it, rescored the same
    // way; a painted region that is physically connected to the clicked region
    // by a brush stroke has already merged into one contour before this point.
    let chosen = selectByPoints(includePoints);
    if (chosen === -1) {
      chosen = selectByPoints(options.paintedIncludePoints ?? []);
    }
    if (chosen === -1) {
      return { ok: false, reason: eligible.length > 0 ? 'noContainingRegion' : 'empty' };
    }

    const outerContour = contours.get(chosen);
    let outerPx: PixelPoint[];
    try {
      outerPx = orient(contourToPixelPolygon(cv, outerContour, epsilonPx), true);
    } finally {
      outerContour.delete();
    }
    if (outerPx.length < 3) {
      return { ok: false, reason: 'empty' };
    }

    const holesPx: PixelPoint[][] = [];
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
        const holePx = orient(contourToPixelPolygon(cv, holeContour, epsilonPx), false);
        if (holePx.length >= 3) {
          holesPx.push(holePx);
        }
      } finally {
        holeContour.delete();
      }
    }
    const outer = pixelToMmPolygon(outerPx, mmPerPixel);
    const holes = holesPx.map((hole) => pixelToMmPolygon(hole, mmPerPixel));
    return {
      ok: true,
      outline: { outer, holes },
      pixelOutline: { outer: outerPx, holes: holesPx },
    };
  } finally {
    kernel.delete();
    clean.delete();
    contours.delete();
    hierarchy.delete();
  }
}
