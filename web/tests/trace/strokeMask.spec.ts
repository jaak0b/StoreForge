import { describe, expect, it } from 'vitest';
import { loadOpenCv } from '../../src/worker/opencvLoader';
import { applyStrokes, rasterizeStroke } from '../../src/engine/trace/strokeMask';
import type { Cv, CvMat } from '../../src/engine/trace/paper';
import type { BrushStroke } from '../../src/engine/trace/types';

// Synthetic ground truth: strokes are painted at known pixel coordinates and
// the expected pixel states are read back directly from the mask buffer, never
// recomputed from the production rasterizer.

/** All masks in this file use 0.25 mm per pixel (the rectified resolution). */
const MM_PER_PX = 0.25;

function emptyMask(cv: Cv, rows = 120, cols = 160): CvMat {
  return new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0));
}

/** Reads one pixel of a CV_8UC1 mask by row and column. */
function at(mask: CvMat, x: number, y: number): number {
  return mask.data[y * mask.cols + x];
}

describe('rasterizeStroke', () => {
  it('paints a filled disc around a single vertex', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // Radius 4 mm at 0.25 mm/px is 16 px. Center at (80, 60).
    const stroke: BrushStroke = { mode: 'add', radiusMm: 4, points: [{ x: 80, y: 60 }] };
    rasterizeStroke(cv, mask, stroke, MM_PER_PX);
    // Center painted, a point 10 px from center (inside the 16 px radius)
    // painted, and a point 40 px away (well outside) untouched.
    expect(at(mask, 80, 60)).toBe(255);
    expect(at(mask, 90, 60)).toBe(255);
    expect(at(mask, 80, 100)).toBe(0);
    mask.delete();
  });

  it('covers the capsule connecting two vertices', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // Two vertices 40 px apart on the same row; the connecting segment's
    // midpoint (60, 60) must be painted by the thick line between them.
    const stroke: BrushStroke = {
      mode: 'add',
      radiusMm: 4,
      points: [
        { x: 40, y: 60 },
        { x: 80, y: 60 },
      ],
    };
    rasterizeStroke(cv, mask, stroke, MM_PER_PX);
    expect(at(mask, 60, 60)).toBe(255);
    mask.delete();
  });

  it('clamps a sub-pixel radius up to one pixel so it still marks a pixel', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // 0.01 mm is 0.04 px, which rounds to 0; the clamp keeps the vertex pixel
    // painted rather than leaving an empty mask.
    const stroke: BrushStroke = { mode: 'add', radiusMm: 0.01, points: [{ x: 80, y: 60 }] };
    rasterizeStroke(cv, mask, stroke, MM_PER_PX);
    expect(at(mask, 80, 60)).toBe(255);
    mask.delete();
  });
});

describe('applyStrokes', () => {
  it('unions an add stroke without clearing existing mask pixels', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // A pre-existing rectangle far from the painted disc; both must survive.
    cv.rectangle(mask, new cv.Point(10, 10), new cv.Point(30, 30), new cv.Scalar(255), -1);
    const strokes: BrushStroke[] = [{ mode: 'add', radiusMm: 4, points: [{ x: 100, y: 90 }] }];
    applyStrokes(cv, mask, strokes, MM_PER_PX);
    expect(at(mask, 20, 20)).toBe(255);
    expect(at(mask, 100, 90)).toBe(255);
    mask.delete();
  });

  it('erases only the painted pixels of the mask', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    // A wide filled rectangle; erasing a disc inside it clears the disc center
    // while a corner well outside the disc stays filled.
    cv.rectangle(mask, new cv.Point(20, 20), new cv.Point(140, 100), new cv.Scalar(255), -1);
    const strokes: BrushStroke[] = [{ mode: 'erase', radiusMm: 4, points: [{ x: 80, y: 60 }] }];
    applyStrokes(cv, mask, strokes, MM_PER_PX);
    expect(at(mask, 80, 60)).toBe(0);
    expect(at(mask, 25, 25)).toBe(255);
    mask.delete();
  });

  it('applies strokes in order so an add then erase over the same spot clears it', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    const strokes: BrushStroke[] = [
      { mode: 'add', radiusMm: 4, points: [{ x: 80, y: 60 }] },
      { mode: 'erase', radiusMm: 4, points: [{ x: 80, y: 60 }] },
    ];
    applyStrokes(cv, mask, strokes, MM_PER_PX);
    expect(at(mask, 80, 60)).toBe(0);
    mask.delete();
  });

  it('applies strokes in order so an erase then add over the same spot sets it', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    cv.rectangle(mask, new cv.Point(20, 20), new cv.Point(140, 100), new cv.Scalar(255), -1);
    const strokes: BrushStroke[] = [
      { mode: 'erase', radiusMm: 4, points: [{ x: 80, y: 60 }] },
      { mode: 'add', radiusMm: 4, points: [{ x: 80, y: 60 }] },
    ];
    applyStrokes(cv, mask, strokes, MM_PER_PX);
    expect(at(mask, 80, 60)).toBe(255);
    mask.delete();
  });

  it('leaves the mask unchanged for an empty stroke list', async () => {
    const cv = await loadOpenCv();
    const mask = emptyMask(cv);
    cv.rectangle(mask, new cv.Point(20, 20), new cv.Point(40, 40), new cv.Scalar(255), -1);
    applyStrokes(cv, mask, [], MM_PER_PX);
    expect(at(mask, 30, 30)).toBe(255);
    expect(at(mask, 100, 90)).toBe(0);
    mask.delete();
  });
});
