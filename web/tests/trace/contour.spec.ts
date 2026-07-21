import { describe, expect, it } from 'vitest';
import { loadOpenCv } from '../../src/worker/opencvLoader';
import { denoiseMask, maskToContour } from '../../src/engine/trace/contour';
import { applyStrokes } from '../../src/engine/trace/strokeMask';
import type { Cv, CvMat } from '../../src/engine/trace/paper';
import type { BrushStroke, MmPoint, PixelPoint } from '../../src/engine/trace/types';

// Synthetic ground truth throughout: masks are drawn at known pixel
// coordinates and the expected mm figures are the drawing literals converted
// by hand once, never recomputed from production formulas.

/** All masks in this file use 0.25 mm per pixel (the rectified resolution). */
const MM_PER_PX = 0.25;

function emptyMask(cv: Cv, rows = 192, cols = 256): CvMat {
  return new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0));
}

function fillRect(cv: Cv, mask: CvMat, x0: number, y0: number, x1: number, y1: number): void {
  cv.rectangle(mask, new cv.Point(x0, y0), new cv.Point(x1, y1), new cv.Scalar(255), -1);
}

/** Measured signed shoelace area of a returned polygon, for orientation and size checks. */
function measuredArea(points: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function bounds(points: MmPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

describe('maskToContour', () => {
  it('converts a rectangle with a hole to mm loops with correct windings', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // Rectangle spanning pixels 40..200 x 30..130 with a circular hole,
    // radius 16 px, centered at (120, 80).
    fillRect(cv, mask, 40, 30, 200, 130);
    cv.circle(mask, new cv.Point(120, 80), 16, new cv.Scalar(0), -1);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 60, y: 50 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outline = result.outline;
    // 40..200 px and 30..130 px at 0.25 mm/px: 10..50 mm and 7.5..32.5 mm,
    // hand-derived once. 0.5 mm tolerance covers the 3x3 morphology kernel
    // plus the 0.2 mm simplification epsilon.
    const box = bounds(outline.outer);
    expect(Math.abs(box.minX - 10)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 50)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.minY - 7.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxY - 32.5)).toBeLessThanOrEqual(0.5);
    // Outer wound with positive shoelace area, holes negative.
    expect(measuredArea(outline.outer)).toBeGreaterThan(0);
    expect(outline.holes).toHaveLength(1);
    // A radius-16 px hole is 4 mm radius: area pi * 16 = 50.27 mm^2,
    // hand-derived once. 10 percent covers rasterization of the circle.
    const holeArea = measuredArea(outline.holes[0]);
    expect(holeArea).toBeLessThan(0);
    expect(Math.abs(holeArea)).toBeGreaterThan(45.2);
    expect(Math.abs(holeArea)).toBeLessThan(55.3);
  });

  it('returns the chosen region in pixel space alongside the mm outline', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // Same rectangle-with-hole as the mm test: pixels 40..200 x 30..130 with a
    // radius-16 px hole centered at (120, 80). The pixel outline literals below
    // are the drawing coordinates, independent of any mm conversion.
    fillRect(cv, mask, 40, 30, 200, 130);
    cv.circle(mask, new cv.Point(120, 80), 16, new cv.Scalar(0), -1);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 60, y: 50 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The pixel outline has one outer loop and one kept hole, and its vertex
    // counts match the mm outline (same simplified polygons before scaling).
    const px = result.pixelOutline;
    expect(px.holes).toHaveLength(1);
    expect(px.outer.length).toBe(result.outline.outer.length);
    expect(px.holes[0].length).toBe(result.outline.holes[0].length);
    // Outer pixel bounds are the drawing coordinates within 2 px, covering the
    // 3x3 morphology kernel and the 0.8 px simplification epsilon.
    const box = bounds(px.outer);
    expect(Math.abs(box.minX - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.maxX - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.minY - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.maxY - 130)).toBeLessThanOrEqual(2);
    // The kept hole is the radius-16 px circle at (120, 80): bounds 104..136 x
    // 64..96, hand-derived once, within 2 px for rasterization and smoothing.
    const holeBox = bounds(px.holes[0]);
    expect(Math.abs(holeBox.minX - 104)).toBeLessThanOrEqual(2);
    expect(Math.abs(holeBox.maxX - 136)).toBeLessThanOrEqual(2);
    expect(Math.abs(holeBox.minY - 64)).toBeLessThanOrEqual(2);
    expect(Math.abs(holeBox.maxY - 96)).toBeLessThanOrEqual(2);
  });

  it('drops a hole smaller than the minimum hole area', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    // Radius 3 px = 0.75 mm: area 1.77 mm^2, below the 3 mm^2 default floor.
    cv.circle(mask, new cv.Point(120, 80), 3, new cv.Scalar(0), -1);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 60, y: 50 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.holes).toHaveLength(0);
  });

  it('ignores speck islands and returns the clicked shape only', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    // Single-pixel noise and a 2x2 speck far from the rectangle.
    fillRect(cv, mask, 230, 20, 231, 21);
    mask.data[10 * 256 + 220] = 255;
    // Denoising is a separate step now; run it as the worker does before tracing.
    denoiseMask(cv, mask);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 60, y: 50 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outline = result.outline;
    // Everything returned stays inside the rectangle's mm bounds; the specks
    // near (220, 10) px = (55, 2.5) mm never appear.
    const box = bounds(outline.outer);
    expect(box.maxX).toBeLessThan(51);
    expect(box.minY).toBeGreaterThan(7);
  });

  it('reports an empty result when the mask holds only noise the denoise pass removes', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    mask.data[50 * 256 + 100] = 255;
    mask.data[80 * 256 + 30] = 255;
    // The morphological open in denoiseMask removes the single-pixel specks.
    denoiseMask(cv, mask);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 100, y: 50 }],
    });
    mask.delete();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });

  it('fails when the click lands outside every contour', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      // 5 px left of the rectangle's edge.
      includePoints: [{ x: 35, y: 80 }],
    });
    mask.delete();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('noContainingRegion');
  });

  it('picks the region containing the most include points over the larger one', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // A smaller left blob and a larger right blob. Two include points land in
    // the left blob and one in the right, so the left blob wins on count even
    // though the right blob has more area.
    fillRect(cv, mask, 20, 30, 90, 130);
    fillRect(cv, mask, 150, 20, 240, 160);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [
        { x: 40, y: 60 },
        { x: 60, y: 100 },
        { x: 190, y: 80 },
      ],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Left blob 20..90 px and 30..130 px at 0.25 mm/px: 5..22.5 mm and
    // 7.5..32.5 mm, hand-derived once. 0.5 mm tolerance covers the morphology
    // kernel plus the simplification epsilon.
    const box = bounds(result.outline.outer);
    expect(Math.abs(box.minX - 5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 22.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.minY - 7.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxY - 32.5)).toBeLessThanOrEqual(0.5);
  });

  it('breaks an equal include-point count by choosing the larger region', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // One include point in each blob is a tie on count; the larger right blob
    // wins the area tiebreak.
    fillRect(cv, mask, 20, 30, 90, 130);
    fillRect(cv, mask, 150, 20, 240, 160);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [
        { x: 55, y: 80 },
        { x: 190, y: 80 },
      ],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Right blob 150..240 px and 20..160 px at 0.25 mm/px: 37.5..60 mm and
    // 5..40 mm, hand-derived once. 0.5 mm tolerance covers the morphology
    // kernel plus the simplification epsilon.
    const box = bounds(result.outline.outer);
    expect(Math.abs(box.minX - 37.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 60)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.minY - 5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxY - 40)).toBeLessThanOrEqual(0.5);
  });

  it('fails with no containing region when no include points are given', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [],
    });
    mask.delete();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('noContainingRegion');
  });

  it('picks the region containing all include points among several blobs', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // A small left blob and a larger right blob; both include points land in
    // the right one, so only that blob's bounds should come back.
    fillRect(cv, mask, 20, 40, 60, 100);
    fillRect(cv, mask, 130, 30, 240, 150);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [
        { x: 150, y: 60 },
        { x: 220, y: 120 },
      ],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 130..240 px and 30..150 px at 0.25 mm/px: 32.5..60 mm and 7.5..37.5 mm,
    // hand-derived once. 0.5 mm tolerance covers the morphology kernel plus
    // the simplification epsilon. The left blob (5..15 mm) never appears.
    const box = bounds(result.outline.outer);
    expect(Math.abs(box.minX - 32.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 60)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.minY - 7.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxY - 37.5)).toBeLessThanOrEqual(0.5);
  });

  it('keeps the clicked blob when many painted points land on a different blob', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // Two disjoint blobs. One include click lands in the left blob; a brush drag
    // deposits many add-stroke vertices in the right blob. Clicks decide, so the
    // painted vote never outweighs the explicit click and the left blob wins.
    fillRect(cv, mask, 20, 30, 90, 130);
    fillRect(cv, mask, 150, 20, 240, 160);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 55, y: 80 }],
      paintedIncludePoints: [
        { x: 180, y: 60 },
        { x: 190, y: 80 },
        { x: 200, y: 100 },
        { x: 210, y: 120 },
        { x: 170, y: 40 },
      ],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Left blob 20..90 px at 0.25 mm/px: 5..22.5 mm, hand-derived once.
    const box = bounds(result.outline.outer);
    expect(Math.abs(box.minX - 5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 22.5)).toBeLessThanOrEqual(0.5);
  });

  it('falls back to painted points to pick a blob when the click lands outside every contour', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // Two disjoint blobs. The include click lands in the gap between them,
    // inside no contour, but painted add-stroke vertices land in the right
    // blob, so the fallback selects that blob.
    fillRect(cv, mask, 20, 30, 90, 130);
    fillRect(cv, mask, 150, 20, 240, 160);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 120, y: 80 }],
      paintedIncludePoints: [
        { x: 180, y: 60 },
        { x: 190, y: 80 },
        { x: 200, y: 100 },
      ],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Right blob 150..240 px at 0.25 mm/px: 37.5..60 mm, hand-derived once.
    const box = bounds(result.outline.outer);
    expect(Math.abs(box.minX - 37.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 60)).toBeLessThanOrEqual(0.5);
  });

  it('still fails with no containing region when only painted points are given', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    // Painted evidence does not relax the "at least one include click" rule.
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [],
      paintedIncludePoints: [{ x: 100, y: 80 }],
    });
    mask.delete();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('noContainingRegion');
  });

  it('returns a single contour whole when a painted bridge merges two regions', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // Two blobs joined by a thin painted bridge become one contour. Left blob
    // 20..90 x 40..120 px, right blob 150..220 x 40..120 px, bridge along
    // y 78..82 px between them.
    fillRect(cv, mask, 20, 40, 90, 120);
    fillRect(cv, mask, 150, 40, 220, 120);
    fillRect(cv, mask, 90, 78, 150, 82);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 55, y: 80 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One outer loop spanning both blobs: 20..220 px = 5..55 mm in x.
    const box = bounds(result.outline.outer);
    expect(Math.abs(box.minX - 5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 55)).toBeLessThanOrEqual(0.5);
  });

  it('behaves unchanged when paintedIncludePoints is omitted', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 60, y: 50 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const box = bounds(result.outline.outer);
    expect(Math.abs(box.minX - 10)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.maxX - 50)).toBeLessThanOrEqual(0.5);
  });

  it('respects the simplification tolerance on a circle', async () => {
    const cv = await loadOpenCv();
    const drawCircleMask = (): CvMat => {
      const mask = emptyMask(cv, 256, 256);
      cv.circle(mask, new cv.Point(128, 128), 80, new cv.Scalar(255), -1);
      return mask;
    };
    const tight = drawCircleMask();
    const tightResult = maskToContour(cv, tight, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 128, y: 128 }],
      toleranceMm: 0.2,
    });
    tight.delete();
    const loose = drawCircleMask();
    const looseResult = maskToContour(cv, loose, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 128, y: 128 }],
      toleranceMm: 2,
    });
    loose.delete();
    expect(tightResult.ok).toBe(true);
    expect(looseResult.ok).toBe(true);
    if (!tightResult.ok || !looseResult.ok) return;
    const tightOutline = tightResult.outline;
    const looseOutline = looseResult.outline;
    // A radius-80 px circle is radius 20 mm centered at (32, 32) mm,
    // hand-derived once. At 0.2 mm tolerance every vertex must sit within
    // the tolerance plus one pixel (0.25 mm) plus the morphology kernel
    // radius (0.25 mm) of the true circle: 0.7 mm.
    for (const point of tightOutline.outer) {
      const radius = Math.hypot(point.x - 32, point.y - 32);
      expect(Math.abs(radius - 20)).toBeLessThanOrEqual(0.7);
    }
    // The coarser tolerance must simplify to strictly fewer vertices.
    expect(looseOutline.outer.length).toBeLessThan(tightOutline.outer.length);
  });
});

// The worker pipeline is: denoiseMask -> applyStrokes -> maskToContour. These
// tests exercise that order and the raw-contour dropped-paint predicate, the
// two halves of the fix for the false "painted area not connected" warning.

/** Fill one pixel polygon into a CV_8UC1 target, mirroring the worker's fillPolygon. */
function fillPoly(cv: Cv, target: CvMat, polygon: PixelPoint[], value: number): void {
  const flat: number[] = [];
  for (const point of polygon) {
    flat.push(point.x, point.y);
  }
  const mat = cv.matFromArray(polygon.length, 1, cv.CV_32SC2, flat);
  const vec = new cv.MatVector();
  try {
    vec.push_back(mat);
    cv.fillPoly(target, vec, new cv.Scalar(value));
  } finally {
    mat.delete();
    vec.delete();
  }
}

/** Rasterize a chosen region (outer filled, holes cleared) as the worker's `kept`. */
function fillKept(
  cv: Cv,
  rows: number,
  cols: number,
  outer: PixelPoint[],
  holes: PixelPoint[][],
): CvMat {
  const kept = cv.Mat.zeros(rows, cols, cv.CV_8UC1);
  fillPoly(cv, kept, outer, 255);
  for (const hole of holes) {
    fillPoly(cv, kept, hole, 0);
  }
  return kept;
}

/** dropped = mask AND NOT kept, the worker's count of discarded mask pixels. */
function droppedCount(cv: Cv, mask: CvMat, kept: CvMat): number {
  const notKept = new cv.Mat();
  const dropped = new cv.Mat();
  try {
    cv.bitwise_not(kept, notKept);
    cv.bitwise_and(mask, notKept, dropped);
    return cv.countNonZero(dropped);
  } finally {
    notKept.delete();
    dropped.delete();
  }
}

describe('trace pipeline: denoise then strokes then contour', () => {
  it('keeps a thin add-stroke bridge that connects a painted blob to the clicked region', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // The camera segmentation is only the left region; the click lands in it.
    fillRect(cv, mask, 40, 60, 120, 100);
    // Denoise the segmentation first, exactly as the worker does. The left
    // region is thick and survives untouched.
    denoiseMask(cv, mask);
    // Then the user paints: a far-right blob plus a hair-thin bridge (2 px wide)
    // joining it to the clicked region. Applied AFTER denoising, so the open
    // pass can no longer erode the bridge (the bug this fix removes).
    const strokes: BrushStroke[] = [
      { mode: 'add', radiusMm: 5, points: [{ x: 200, y: 80 }] },
      { mode: 'add', radiusMm: 0.3, points: [{ x: 120, y: 80 }, { x: 180, y: 80 }] },
    ];
    applyStrokes(cv, mask, strokes, MM_PER_PX);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 60, y: 80 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bridge survives, so both blobs are one external contour reaching the
    // painted blob's right edge near 220 px = 55 mm. A severed bridge would
    // instead stop at the left region's 120 px = 30 mm edge.
    const box = bounds(result.outline.outer);
    expect(box.maxX).toBeGreaterThan(50);
  });

  it('does not flag boundary paint as dropped, but does flag a detached paint island', async () => {
    const cv = await loadOpenCv();
    const rows = 256;
    const cols = 256;
    const mask = new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0));
    // A disc whose simplified polygon cuts every corner of the curve.
    cv.circle(mask, new cv.Point(128, 128), 80, new cv.Scalar(255), -1);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 128, y: 128 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      mask.delete();
      return;
    }
    // Filling the RAW contour reproduces the disc pixel for pixel, so nothing is
    // dropped. Filling the SIMPLIFIED polygon leaves a rim of boundary pixels
    // outside `kept`, which the old code miscounted as dropped paint.
    const rawKept = fillKept(cv, rows, cols, result.rawPixelOutline.outer, result.rawPixelOutline.holes);
    const simplifiedKept = fillKept(cv, rows, cols, result.pixelOutline.outer, result.pixelOutline.holes);
    const rawDropped = droppedCount(cv, mask, rawKept);
    const simplifiedDropped = droppedCount(cv, mask, simplifiedKept);
    expect(rawDropped).toBe(0);
    expect(simplifiedDropped).toBeGreaterThan(0);
    rawKept.delete();
    simplifiedKept.delete();

    // A genuinely detached paint island (a separate component) still lands
    // outside `kept` and still counts as dropped, so real disconnection warns.
    cv.rectangle(mask, new cv.Point(20, 20), new cv.Point(50, 50), new cv.Scalar(255), -1);
    const withIsland = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 128, y: 128 }],
    });
    expect(withIsland.ok).toBe(true);
    if (withIsland.ok) {
      const keptWithIsland = fillKept(
        cv,
        rows,
        cols,
        withIsland.rawPixelOutline.outer,
        withIsland.rawPixelOutline.holes,
      );
      expect(droppedCount(cv, mask, keptWithIsland)).toBeGreaterThan(0);
      keptWithIsland.delete();
    }
    mask.delete();
  });

  it('ignores an erase-created speck below the area floor (accepted regression)', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    denoiseMask(cv, mask);
    // An erase stroke runs after denoising, so morphology can no longer sweep
    // the small isolated island it leaves behind. Simulate that leftover as a
    // 4x4 px speck (16 px^2, below the 48 px^2 = 3 mm^2 area floor). The area
    // floor in maskToContour absorbs it, so the trace is unaffected.
    fillRect(cv, mask, 230, 20, 233, 23);
    const result = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoints: [{ x: 60, y: 50 }],
    });
    mask.delete();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the main rectangle comes back; the speck near 230 px = 57.5 mm never
    // appears in the outline.
    const box = bounds(result.outline.outer);
    expect(box.maxX).toBeLessThan(51);
  });
});
