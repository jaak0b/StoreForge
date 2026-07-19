import { describe, expect, it } from 'vitest';
import { loadOpenCv } from '../../src/worker/opencvLoader';
import { smoothToResolutionLimit } from '../../src/engine/trace/resolutionFilter';
import type { Cv, CvMat } from '../../src/engine/trace/paper';

// Synthetic ground truth throughout: every mask is drawn at known pixel
// coordinates, and every expected value is the known truth of those literals,
// never recomputed from the production filter.
//
// All the shape cases use a cell pitch of 9 rectified pixels, which is the
// filter's kernel size directly (9 is already odd). "One cell" below therefore
// means 9 px, and a feature is sub-resolution when it is thin compared to the
// blur that a 9 px kernel produces.

function emptyMask(cv: Cv, rows: number, cols: number): CvMat {
  return new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0));
}

function fillMask(cv: Cv, mask: CvMat, x0: number, y0: number, x1: number, y1: number): void {
  cv.rectangle(mask, new cv.Point(x0, y0), new cv.Point(x1, y1), new cv.Scalar(255), -1);
}

/** Read a single mask byte at (x, y). */
function maskAt(mask: CvMat, x: number, y: number): number {
  return mask.data[y * mask.cols + x];
}

/** Snapshot the mask bytes as a plain array, detached from the Mat. */
function snapshot(mask: CvMat): number[] {
  return Array.from(mask.data);
}

describe('smoothToResolutionLimit', () => {
  it('straightens a one-pixel staircase along an otherwise straight edge', async () => {
    const cv = await loadOpenCv();
    // A 60 x 60 mask filled from the left edge to a boundary that alternates
    // between column 29 (even rows) and column 30 (odd rows): a one-pixel
    // staircase on a vertical edge, the exact quantization artifact the filter
    // exists to remove. Column 30 on even rows is the notch.
    const mask = emptyMask(cv, 60, 60);
    for (let y = 0; y < 60; y += 1) {
      fillMask(cv, mask, 0, y, y % 2 === 0 ? 29 : 30, y);
    }

    smoothToResolutionLimit(cv, mask, 9);

    // The notch pixels on even rows fill in to match their odd-row neighbours,
    // so the edge becomes straight at column 30.
    expect(maskAt(mask, 30, 10)).toBe(255);
    expect(maskAt(mask, 30, 12)).toBe(255);
    expect(maskAt(mask, 30, 30)).toBe(255);
    expect(maskAt(mask, 30, 32)).toBe(255);
    // The odd rows that were already filled to column 30 are untouched.
    expect(maskAt(mask, 30, 11)).toBe(255);
    expect(maskAt(mask, 30, 31)).toBe(255);
    // The edge does not creep outward: column 31 stays background on both.
    expect(maskAt(mask, 31, 10)).toBe(0);
    expect(maskAt(mask, 31, 11)).toBe(0);

    mask.delete();
  });

  it('leaves a square spanning many cells intact apart from rounding its apexes', async () => {
    const cv = await loadOpenCv();
    // A 51 x 51 px square at 20..70 in both axes, about five cells on a side.
    // Every edge and the interior span many cells, so the shape is real signal
    // and must survive; only the four single-pixel apexes are sub-resolution
    // detail and get rounded off, which is the resolution limit doing its job.
    const mask = emptyMask(cv, 90, 90);
    fillMask(cv, mask, 20, 20, 70, 70);
    const before = snapshot(mask);

    smoothToResolutionLimit(cv, mask, 9);

    // Exactly four pixels change, and they are the four apexes.
    const after = snapshot(mask);
    const changed: string[] = [];
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) {
        changed.push(`${i % 90},${Math.floor(i / 90)}`);
      }
    }
    expect(changed).toEqual(['20,20', '70,20', '20,70', '70,70']);

    // The pixels immediately inside each rounded apex are untouched, so the
    // corner is still a corner rather than a chamfer.
    expect(maskAt(mask, 21, 20)).toBe(255);
    expect(maskAt(mask, 20, 21)).toBe(255);
    expect(maskAt(mask, 21, 21)).toBe(255);
    expect(maskAt(mask, 69, 70)).toBe(255);
    // Edge midpoints and the interior are untouched.
    expect(maskAt(mask, 45, 20)).toBe(255);
    expect(maskAt(mask, 20, 45)).toBe(255);
    expect(maskAt(mask, 45, 45)).toBe(255);
    // The filter does not grow the square outward.
    expect(maskAt(mask, 19, 45)).toBe(0);
    expect(maskAt(mask, 45, 19)).toBe(0);

    mask.delete();
  });

  it('removes a protrusion narrower than one cell and keeps one several cells wide', async () => {
    const cv = await loadOpenCv();
    // A block spanning 10..80 x 50..95 with two fingers standing up from its
    // top edge across rows 30..49: a one-pixel-wide finger at column 30 (far
    // below one cell, so quantization noise) and a 20 px wide finger at
    // columns 50..69 (over two cells, so real shape).
    const mask = emptyMask(cv, 100, 100);
    fillMask(cv, mask, 10, 50, 80, 95);
    fillMask(cv, mask, 30, 30, 30, 49);
    fillMask(cv, mask, 50, 30, 69, 49);

    smoothToResolutionLimit(cv, mask, 9);

    // The one-pixel finger is gone along its free length.
    expect(maskAt(mask, 30, 32)).toBe(0);
    expect(maskAt(mask, 30, 40)).toBe(0);
    expect(maskAt(mask, 30, 47)).toBe(0);
    // The wide finger survives, at its centre and at its edge column.
    expect(maskAt(mask, 59, 32)).toBe(255);
    expect(maskAt(mask, 59, 40)).toBe(255);
    expect(maskAt(mask, 59, 47)).toBe(255);
    expect(maskAt(mask, 50, 40)).toBe(255);
    // The block the fingers stand on is unaffected.
    expect(maskAt(mask, 45, 70)).toBe(255);

    mask.delete();
  });

  it('leaves the mask unchanged when a cell is at or below the pixel resolution', async () => {
    const cv = await loadOpenCv();
    // Rounding a pitch to the nearest odd integer puts every pitch below 2 at
    // kernel 1, which is an identity blur, so the filter returns early and the
    // mask must come back byte-for-byte identical.
    const mask = emptyMask(cv, 40, 40);
    fillMask(cv, mask, 5, 5, 20, 20);
    const before = snapshot(mask);

    smoothToResolutionLimit(cv, mask, 1);

    expect(snapshot(mask)).toEqual(before);

    smoothToResolutionLimit(cv, mask, 1.8);

    expect(snapshot(mask)).toEqual(before);

    mask.delete();
  });
});
