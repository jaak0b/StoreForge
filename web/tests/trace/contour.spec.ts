import { describe, expect, it } from 'vitest';
import { loadOpenCv } from '../../src/worker/opencvLoader';
import { maskToContour } from '../../src/engine/trace/contour';
import type { Cv, CvMat } from '../../src/engine/trace/paper';
import type { MmPoint } from '../../src/engine/trace/types';

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
    const outline = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoint: { x: 60, y: 50 },
    });
    mask.delete();
    expect(outline).not.toBeNull();
    if (!outline) return;
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

  it('drops a hole smaller than the minimum hole area', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    // Radius 3 px = 0.75 mm: area 1.77 mm^2, below the 3 mm^2 default floor.
    cv.circle(mask, new cv.Point(120, 80), 3, new cv.Scalar(0), -1);
    const outline = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoint: { x: 60, y: 50 },
    });
    mask.delete();
    expect(outline).not.toBeNull();
    expect(outline?.holes).toHaveLength(0);
  });

  it('ignores speck islands and returns the clicked shape only', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    // Single-pixel noise and a 2x2 speck far from the rectangle.
    fillRect(cv, mask, 230, 20, 231, 21);
    mask.data[10 * 256 + 220] = 255;
    const outline = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoint: { x: 60, y: 50 },
    });
    mask.delete();
    expect(outline).not.toBeNull();
    if (!outline) return;
    // Everything returned stays inside the rectangle's mm bounds; the specks
    // near (220, 10) px = (55, 2.5) mm never appear.
    const box = bounds(outline.outer);
    expect(box.maxX).toBeLessThan(51);
    expect(box.minY).toBeGreaterThan(7);
  });

  it('returns null when the mask holds only noise the denoise pass removes', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    mask.data[50 * 256 + 100] = 255;
    mask.data[80 * 256 + 30] = 255;
    const outline = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      includePoint: { x: 100, y: 50 },
    });
    mask.delete();
    expect(outline).toBeNull();
  });

  it('falls back to the nearest contour when the click lands just outside', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    fillRect(cv, mask, 40, 30, 200, 130);
    const outline = maskToContour(cv, mask, {
      mmPerPixel: MM_PER_PX,
      // 5 px left of the rectangle's edge.
      includePoint: { x: 35, y: 80 },
    });
    mask.delete();
    expect(outline).not.toBeNull();
    if (!outline) return;
    const box = bounds(outline.outer);
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
    const tightOutline = maskToContour(cv, tight, {
      mmPerPixel: MM_PER_PX,
      includePoint: { x: 128, y: 128 },
      toleranceMm: 0.2,
    });
    tight.delete();
    const loose = drawCircleMask();
    const looseOutline = maskToContour(cv, loose, {
      mmPerPixel: MM_PER_PX,
      includePoint: { x: 128, y: 128 },
      toleranceMm: 2,
    });
    loose.delete();
    expect(tightOutline).not.toBeNull();
    expect(looseOutline).not.toBeNull();
    if (!tightOutline || !looseOutline) return;
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
