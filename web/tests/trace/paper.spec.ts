import { describe, expect, it } from 'vitest';
import { loadOpenCv } from '../../src/worker/opencvLoader';
import { detectPaper, rectifyPaper } from '../../src/engine/trace/paper';
import type { Cv, CvMat } from '../../src/engine/trace/paper';
import type { PaperCorners, PixelPoint } from '../../src/engine/trace/types';

// Synthetic ground truth throughout: a bright quad is drawn at known corner
// coordinates and the detector/rectifier must recover those seeds. Expected
// values are the drawing literals, never recomputed from production formulas.

const DARK = [40, 40, 40, 255];
const WHITE = [235, 235, 235, 255];

function drawSheet(cv: Cv, corners: PaperCorners, cols = 800, rows = 600): CvMat {
  const mat = new cv.Mat(rows, cols, cv.CV_8UC4, new cv.Scalar(...DARK));
  const { tl, tr, br, bl } = corners;
  const points = cv.matFromArray(4, 1, cv.CV_32SC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  cv.fillConvexPoly(mat, points, new cv.Scalar(...WHITE));
  points.delete();
  return mat;
}

/** Map a point on the physical sheet (mm) to photo pixels via the corner homography. */
function sheetMmToPhotoPx(
  cv: Cv,
  corners: PaperCorners,
  sheetWidthMm: number,
  sheetHeightMm: number,
  point: { xMm: number; yMm: number },
): PixelPoint {
  const { tl, tr, br, bl } = corners;
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, sheetWidthMm, 0, sheetWidthMm, sheetHeightMm, 0, sheetHeightMm,
  ]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const transform = cv.getPerspectiveTransform(src, dst);
  const input = cv.matFromArray(1, 1, cv.CV_32FC2, [point.xMm, point.yMm]);
  const output = new cv.Mat();
  cv.perspectiveTransform(input, output, transform);
  const result = { x: output.data32F[0], y: output.data32F[1] };
  src.delete();
  dst.delete();
  transform.delete();
  input.delete();
  output.delete();
  return result;
}

/** Centroid of pixels darker than 100 in an RGBA mat, from image moments. */
function darkSpotCentroid(cv: Cv, mat: CvMat): PixelPoint {
  const gray = new cv.Mat();
  const mask = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  cv.threshold(gray, mask, 100, 255, cv.THRESH_BINARY_INV);
  const moments = cv.moments(mask, true);
  gray.delete();
  mask.delete();
  expect(moments.m00).toBeGreaterThan(0);
  return { x: moments.m10 / moments.m00, y: moments.m01 / moments.m00 };
}

// A portrait sheet drawn with mild perspective skew.
const portraitCorners: PaperCorners = {
  tl: { x: 250, y: 60 },
  tr: { x: 560, y: 90 },
  br: { x: 540, y: 540 },
  bl: { x: 230, y: 520 },
};

describe('detectPaper', () => {
  it('recovers the drawn corners of a skewed bright quad', async () => {
    const cv = await loadOpenCv();
    const mat = drawSheet(cv, portraitCorners);
    const result = detectPaper(cv, mat);
    mat.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ['tl', 'tr', 'br', 'bl'] as const) {
      // 3 px tolerance: blur plus polygon approximation shifts edges by at
      // most a pixel or two on a clean synthetic image.
      expect(Math.abs(result.corners[key].x - portraitCorners[key].x)).toBeLessThanOrEqual(3);
      expect(Math.abs(result.corners[key].y - portraitCorners[key].y)).toBeLessThanOrEqual(3);
    }
    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('finds the white sheet, not the merged bright chromatic background', async () => {
    const cv = await loadOpenCv();
    // A bright yellow field and the white sheet share luminance 235, so a
    // luminance-only Otsu cannot separate them and would return the yellow
    // field's corners. Yellow is chromatic (high saturation), the sheet is
    // neutral, so the saturation gate isolates the sheet. The dark border
    // anchors Otsu's low class so both surfaces land in the bright class.
    const mat = new cv.Mat(600, 800, cv.CV_8UC4, new cv.Scalar(...DARK));
    const field = cv.matFromArray(4, 1, cv.CV_32SC2, [50, 50, 750, 50, 750, 550, 50, 550]);
    cv.fillConvexPoly(mat, field, new cv.Scalar(255, 255, 80, 255));
    field.delete();
    // Axis-aligned white sheet; these four literals are the ground truth.
    const sheet: PaperCorners = {
      tl: { x: 250, y: 150 },
      tr: { x: 600, y: 150 },
      br: { x: 600, y: 480 },
      bl: { x: 250, y: 480 },
    };
    const sheetPoly = cv.matFromArray(4, 1, cv.CV_32SC2, [
      sheet.tl.x, sheet.tl.y, sheet.tr.x, sheet.tr.y,
      sheet.br.x, sheet.br.y, sheet.bl.x, sheet.bl.y,
    ]);
    cv.fillConvexPoly(mat, sheetPoly, new cv.Scalar(235, 235, 235, 255));
    sheetPoly.delete();
    const result = detectPaper(cv, mat);
    mat.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ['tl', 'tr', 'br', 'bl'] as const) {
      // 3 px tolerance: blur plus polygon approximation shifts edges slightly.
      expect(Math.abs(result.corners[key].x - sheet[key].x)).toBeLessThanOrEqual(3);
      expect(Math.abs(result.corners[key].y - sheet[key].y)).toBeLessThanOrEqual(3);
    }
  });

  it('rescues a bumpy merged blob with the minimum-area rectangle', async () => {
    const cv = await loadOpenCv();
    // A neutral sheet with a bright neutral tab breaking the edge: the tab adds
    // vertices so approxPolyDP cannot reduce the contour to four corners, and
    // the minAreaRect fallback returns the tightest box around sheet plus tab.
    const mat = new cv.Mat(600, 800, cv.CV_8UC4, new cv.Scalar(...DARK));
    const sheet = cv.matFromArray(4, 1, cv.CV_32SC2, [200, 150, 600, 150, 600, 450, 200, 450]);
    cv.fillConvexPoly(mat, sheet, new cv.Scalar(...WHITE));
    sheet.delete();
    // A tab protruding above the top edge, raising the box top to y = 100.
    const tab = cv.matFromArray(4, 1, cv.CV_32SC2, [350, 100, 450, 100, 450, 150, 350, 150]);
    cv.fillConvexPoly(mat, tab, new cv.Scalar(...WHITE));
    tab.delete();
    const result = detectPaper(cv, mat);
    mat.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bounding box of sheet (200..600, 150..450) plus tab (top at 100):
    // x spans 200..600, y spans 100..450. These are the hand-derived box
    // corners, not recomputed from the detector.
    const box: PaperCorners = {
      tl: { x: 200, y: 100 },
      tr: { x: 600, y: 100 },
      br: { x: 600, y: 450 },
      bl: { x: 200, y: 450 },
    };
    for (const key of ['tl', 'tr', 'br', 'bl'] as const) {
      // 4 px tolerance covers rasterizing and the box fit over a stepped edge.
      expect(Math.abs(result.corners[key].x - box[key].x)).toBeLessThanOrEqual(4);
      expect(Math.abs(result.corners[key].y - box[key].y)).toBeLessThanOrEqual(4);
    }
  });

  it('still detects the sheet in a fully grayscale scene', async () => {
    const cv = await loadOpenCv();
    // No chromatic pixels anywhere: the saturation channel is degenerate, so
    // the gate must fall back to luminance-only and recover the sheet corners.
    const grayCorners: PaperCorners = {
      tl: { x: 180, y: 120 },
      tr: { x: 620, y: 120 },
      br: { x: 620, y: 500 },
      bl: { x: 180, y: 500 },
    };
    const mat = drawSheet(cv, grayCorners);
    const result = detectPaper(cv, mat);
    mat.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ['tl', 'tr', 'br', 'bl'] as const) {
      expect(Math.abs(result.corners[key].x - grayCorners[key].x)).toBeLessThanOrEqual(3);
      expect(Math.abs(result.corners[key].y - grayCorners[key].y)).toBeLessThanOrEqual(3);
    }
  });

  it('returns a user-worded error when no plausible sheet exists', async () => {
    const cv = await loadOpenCv();
    const mat = new cv.Mat(600, 800, cv.CV_8UC4, new cv.Scalar(...DARK));
    // A small bright blob well below the sheet area threshold.
    cv.circle(mat, new cv.Point(400, 300), 30, new cv.Scalar(...WHITE), -1);
    const result = detectPaper(cv, mat);
    mat.delete();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/paper sheet/i);
    expect(result.error).toMatch(/visible/i);
  });
});

describe('rectifyPaper', () => {
  it('rectifies a portrait Letter sheet to the expected size and scale', async () => {
    const cv = await loadOpenCv();
    const mat = drawSheet(cv, portraitCorners);
    const { rectified, calibration } = rectifyPaper(cv, mat, portraitCorners, 'letter');
    mat.delete();
    // Letter is 215.9 x 279.4 mm at 4 px/mm, rounded to whole pixels.
    expect(calibration.rectifiedWidthPx).toBe(864);
    expect(calibration.rectifiedHeightPx).toBe(1118);
    expect(rectified.cols).toBe(864);
    expect(rectified.rows).toBe(1118);
    // 215.9 mm across 864 px, hand-derived once.
    expect(calibration.mmPerPixel).toBeCloseTo(0.24988426, 7);
    expect(calibration.kind).toBe('letter');
    rectified.delete();
  });

  it('detects landscape orientation from the corner geometry', async () => {
    const cv = await loadOpenCv();
    const landscapeCorners: PaperCorners = {
      tl: { x: 100, y: 150 },
      tr: { x: 650, y: 170 },
      br: { x: 640, y: 470 },
      bl: { x: 90, y: 450 },
    };
    const mat = drawSheet(cv, landscapeCorners);
    const { rectified, calibration } = rectifyPaper(cv, mat, landscapeCorners, 'letter');
    mat.delete();
    expect(calibration.rectifiedWidthPx).toBe(1118);
    expect(calibration.rectifiedHeightPx).toBe(864);
    rectified.delete();
  });

  it('gives an exact 0.25 mm per pixel for A4', async () => {
    const cv = await loadOpenCv();
    const mat = drawSheet(cv, portraitCorners);
    const { rectified, calibration } = rectifyPaper(cv, mat, portraitCorners, 'a4');
    mat.delete();
    // A4 is 210 x 297 mm: both divide evenly at 4 px/mm.
    expect(calibration.rectifiedWidthPx).toBe(840);
    expect(calibration.rectifiedHeightPx).toBe(1188);
    expect(calibration.mmPerPixel).toBe(0.25);
    rectified.delete();
  });

  it('maps a marker at a known mm position to the expected rectified pixel', async () => {
    const cv = await loadOpenCv();
    const mat = drawSheet(cv, portraitCorners);
    // A dark dot at 60 mm, 100 mm from the top-left corner of an A4 sheet,
    // placed in the photo through the same corner homography the sheet has.
    const markerPhotoPx = sheetMmToPhotoPx(cv, portraitCorners, 210, 297, {
      xMm: 60,
      yMm: 100,
    });
    cv.circle(
      mat,
      new cv.Point(Math.round(markerPhotoPx.x), Math.round(markerPhotoPx.y)),
      8,
      new cv.Scalar(20, 20, 20, 255),
      -1,
    );
    const { rectified } = rectifyPaper(cv, mat, portraitCorners, 'a4');
    mat.delete();
    const centroid = darkSpotCentroid(cv, rectified);
    rectified.delete();
    // 60 mm and 100 mm at 0.25 mm per pixel: 240 px, 400 px. 3 px tolerance
    // covers rasterizing the dot in photo space and warping it back.
    expect(Math.abs(centroid.x - 240)).toBeLessThanOrEqual(3);
    expect(Math.abs(centroid.y - 400)).toBeLessThanOrEqual(3);
  });
});
