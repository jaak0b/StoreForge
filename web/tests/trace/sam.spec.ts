import { describe, expect, it } from 'vitest';
import { LOW_RES_MASK_SIZE, selectMaskIndex } from '../../src/engine/trace/sam';
import type { PixelPoint } from '../../src/engine/trace/types';

// selectMaskIndex is pure: synthetic low_res_masks planes are built with known
// logit values in known grid cells, and the assertion is the plane index the
// selector returns. No ONNX, no production formula for the expected value.

const SIZE = LOW_RES_MASK_SIZE;
const STRIDE = SIZE * SIZE;
// Rectified-pixel to low-res-grid factor for these fixtures. A pixel at x is
// grid cell floor(x * SCALE).
const SCALE = 0.25;

/** Allocate `count` all-zero planes (every logit 0, i.e. outside every mask). */
function makePlanes(count: number): Float32Array {
  return new Float32Array(count * STRIDE);
}

/** Place a logit value at grid cell (gx, gy) of a plane. Fixture construction. */
function setCell(planes: Float32Array, plane: number, gx: number, gy: number, value: number): void {
  planes[plane * STRIDE + gy * SIZE + gx] = value;
}

// A rectified pixel mapping to grid cell (50, 30): 200 * 0.25 = 50, 120 * 0.25 = 30.
const INSIDE_POINT: PixelPoint = { x: 200, y: 120 };
// A rectified pixel mapping to grid cell (51, 30): 204 * 0.25 = 51, one cell right.
const ONE_CELL_RIGHT: PixelPoint = { x: 204, y: 120 };

describe('selectMaskIndex', () => {
  it('prefers a qualifying plane over a higher-IoU non-qualifying plane', () => {
    const planes = makePlanes(2);
    // Plane 1 covers the include cell; plane 0 does not, despite higher IoU.
    setCell(planes, 1, 50, 30, 5);
    const iou = new Float32Array([0.9, 0.5]);
    expect(selectMaskIndex(planes, iou, [INSIDE_POINT], [], SCALE)).toBe(1);
  });

  it('rejects a plane whose include cell logit is not positive', () => {
    const planes = makePlanes(2);
    // Plane 0 covers the include cell (logit 5); plane 1 leaves it at 0, which
    // is not > 0, so plane 1 is rejected even with the higher IoU.
    setCell(planes, 0, 50, 30, 5);
    const iou = new Float32Array([0.4, 0.9]);
    expect(selectMaskIndex(planes, iou, [INSIDE_POINT], [], SCALE)).toBe(0);
  });

  it('rejects a plane whose exclude cell logit is positive', () => {
    const planes = makePlanes(2);
    // Both planes cover the include cell; plane 1 also lights up the exclude
    // cell (logit 2 > 0), so it is rejected despite the higher IoU.
    setCell(planes, 0, 50, 30, 5);
    setCell(planes, 1, 50, 30, 5);
    setCell(planes, 1, 60, 30, 2);
    const iou = new Float32Array([0.4, 0.9]);
    const excludePoint: PixelPoint = { x: 240, y: 120 }; // 240 * 0.25 = 60.
    expect(selectMaskIndex(planes, iou, [INSIDE_POINT], [excludePoint], SCALE)).toBe(0);
  });

  it('falls back to argmax IoU when no plane qualifies', () => {
    const planes = makePlanes(2);
    // Neither plane covers the include cell, so the plain IoU winner is chosen.
    const iou = new Float32Array([0.3, 0.8]);
    expect(selectMaskIndex(planes, iou, [INSIDE_POINT], [], SCALE)).toBe(1);
  });

  it('maps a rectified pixel to the exact low-res cell', () => {
    const planes = makePlanes(2);
    // Only plane 0 lights up cell (50, 30); plane 1 stays blank but wins on IoU.
    setCell(planes, 0, 50, 30, 5);
    const iou = new Float32Array([0.4, 0.9]);
    // The include point mapping exactly to (50, 30) qualifies plane 0.
    expect(selectMaskIndex(planes, iou, [INSIDE_POINT], [], SCALE)).toBe(0);
    // One cell to the right maps to (51, 30), which is blank, so no plane
    // qualifies and the selector falls back to the IoU winner, plane 1.
    expect(selectMaskIndex(planes, iou, [ONE_CELL_RIGHT], [], SCALE)).toBe(1);
  });
});
