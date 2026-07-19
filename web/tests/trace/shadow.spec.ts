import { describe, expect, it } from 'vitest';
import { loadOpenCv } from '../../src/worker/opencvLoader';
import { multilevelOtsu, removeShadow } from '../../src/engine/trace/shadow';
import type { Cv, CvMat } from '../../src/engine/trace/paper';

// Synthetic ground truth throughout: color sheets and masks are drawn at known
// pixel coordinates and luminance/saturation levels, and every expected result
// is the known truth of those literals, never recomputed from the production
// filter.

/** Bright neutral paper, dark neutral tool, mid-gray neutral shadow (RGBA). */
const BRIGHT_PAPER = [230, 230, 230, 255] as const;
const DARK_TOOL = [30, 30, 30, 255] as const;
const MID_GRAY = [150, 150, 150, 255] as const;
// A mid-luminance, high-saturation blue (dominant B channel): stands in for a
// genuinely colored feature that must survive the neutral-only shadow filter.
const MID_BLUE = [60, 120, 230, 255] as const;

function sheet(cv: Cv, rows: number, cols: number, rgba: readonly number[]): CvMat {
  return new cv.Mat(rows, cols, cv.CV_8UC4, new cv.Scalar(...rgba));
}

function fillRect(
  cv: Cv,
  mat: CvMat,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: readonly number[],
): void {
  cv.rectangle(mat, new cv.Point(x0, y0), new cv.Point(x1, y1), new cv.Scalar(...rgba), -1);
}

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

describe('multilevelOtsu', () => {
  it('splits a three-spike histogram between the spikes', () => {
    // Equal-weight spikes at luminance 20, 128 and 230. The two thresholds must
    // land so that each spike sits in its own class: 20 <= t1 < 128 <= t2 < 230.
    const hist = new Float64Array(256);
    hist[20] = 100;
    hist[128] = 100;
    hist[230] = 100;
    const { t1, t2, classesNonEmpty } = multilevelOtsu(hist);
    expect(t1).toBeGreaterThanOrEqual(20);
    expect(t1).toBeLessThan(128);
    expect(t2).toBeGreaterThanOrEqual(128);
    expect(t2).toBeLessThan(230);
    expect(classesNonEmpty).toBe(true);
  });

  it('reports an empty class for a two-spike histogram', () => {
    // Only dark and bright spikes: the middle class carries no weight, so the
    // caller knows to skip shadow removal.
    const hist = new Float64Array(256);
    hist[30] = 100;
    hist[230] = 100;
    expect(multilevelOtsu(hist).classesNonEmpty).toBe(false);
  });
});

describe('removeShadow', () => {
  it('throws when the mask and rectified image differ in size', async () => {
    const cv = await loadOpenCv();
    const rectified = sheet(cv, 40, 40, BRIGHT_PAPER);
    const mask = emptyMask(cv, 30, 40);
    expect(() => removeShadow(cv, rectified, mask)).toThrow(/same dimensions/);
    rectified.delete();
    mask.delete();
  });

  it('removes a mid-gray shadow band attached to the tool boundary', async () => {
    const cv = await loadOpenCv();
    // Bright sheet, dark tool at 20..60 x 20..70, a mid-gray shadow band at
    // 61..80 hanging off the tool's right edge. The mask covers tool + shadow.
    const rectified = sheet(cv, 90, 120, BRIGHT_PAPER);
    fillRect(cv, rectified, 20, 20, 60, 70, DARK_TOOL);
    fillRect(cv, rectified, 61, 20, 80, 70, MID_GRAY);
    const mask = emptyMask(cv, 90, 120);
    fillMask(cv, mask, 20, 20, 80, 70);

    removeShadow(cv, rectified, mask);

    // The shadow band pixels are cleared; the dark tool pixels are kept.
    expect(maskAt(mask, 70, 45)).toBe(0);
    expect(maskAt(mask, 40, 45)).toBe(255);

    rectified.delete();
    mask.delete();
  });

  it('keeps a mid-gray patch fully enclosed by the tool', async () => {
    const cv = await loadOpenCv();
    // A mid-gray patch at 40..55 x 40..55 sits fully inside the dark tool
    // (15..75), not adjacent to any background pixel, so it must survive.
    const rectified = sheet(cv, 100, 100, BRIGHT_PAPER);
    fillRect(cv, rectified, 15, 15, 75, 75, DARK_TOOL);
    fillRect(cv, rectified, 40, 40, 55, 55, MID_GRAY);
    const mask = emptyMask(cv, 100, 100);
    fillMask(cv, mask, 15, 15, 75, 75);

    removeShadow(cv, rectified, mask);

    expect(maskAt(mask, 47, 47)).toBe(255);
    expect(maskAt(mask, 20, 20)).toBe(255);

    rectified.delete();
    mask.delete();
  });

  it('keeps a chromatic mid-luminance region on the tool boundary', async () => {
    const cv = await loadOpenCv();
    // Same layout as the attached-shadow case, but the band is saturated blue
    // instead of gray. It fails the low-saturation predicate, so even though it
    // is mid-luminance and touches the border it must survive.
    const rectified = sheet(cv, 90, 120, BRIGHT_PAPER);
    fillRect(cv, rectified, 20, 20, 60, 70, DARK_TOOL);
    fillRect(cv, rectified, 61, 20, 80, 70, MID_BLUE);
    const mask = emptyMask(cv, 90, 120);
    fillMask(cv, mask, 20, 20, 80, 70);

    removeShadow(cv, rectified, mask);

    expect(maskAt(mask, 70, 45)).toBe(255);
    expect(maskAt(mask, 40, 45)).toBe(255);

    rectified.delete();
    mask.delete();
  });

  it('removes a bright paper halo attached to the tool boundary', async () => {
    const cv = await loadOpenCv();
    // Mid-gray scene ground (150) establishes a third luminance population so
    // multilevel Otsu is non-degenerate. A dark tool (20..60 x 20..70) sits in a
    // bright paper rectangle (15..65 x 15..75); the bright band around the tool
    // is the decoder halo. The mask covers the whole bright rectangle, so the
    // halo reaches the mask boundary and is 8-adjacent to the mid-gray ground.
    const rectified = sheet(cv, 90, 120, MID_GRAY);
    fillRect(cv, rectified, 15, 15, 75, 65, BRIGHT_PAPER);
    fillRect(cv, rectified, 20, 20, 60, 60, DARK_TOOL);
    const mask = emptyMask(cv, 90, 120);
    fillMask(cv, mask, 15, 15, 75, 65);

    removeShadow(cv, rectified, mask);

    // The bright halo pixels (here at 17,17: inside the mask, outside the tool)
    // are cleared; the dark tool pixels are kept.
    expect(maskAt(mask, 17, 17)).toBe(0);
    expect(maskAt(mask, 40, 40)).toBe(255);

    rectified.delete();
    mask.delete();
  });

  it('keeps a bright specular highlight fully enclosed by the tool', async () => {
    const cv = await loadOpenCv();
    // Mid-gray scene ground (150), a dark tool (15..75) with a small bright
    // patch (40..55 x 40..55) standing in for a specular highlight on a chrome
    // shaft. The patch is bright but fully enclosed by tool pixels, not adjacent
    // to any background pixel, so the border guard must spare it.
    const rectified = sheet(cv, 100, 100, MID_GRAY);
    fillRect(cv, rectified, 15, 15, 75, 75, DARK_TOOL);
    fillRect(cv, rectified, 40, 40, 55, 55, BRIGHT_PAPER);
    const mask = emptyMask(cv, 100, 100);
    fillMask(cv, mask, 15, 15, 75, 75);

    removeShadow(cv, rectified, mask);

    expect(maskAt(mask, 47, 47)).toBe(255);
    expect(maskAt(mask, 20, 20)).toBe(255);

    rectified.delete();
    mask.delete();
  });

  it('leaves the mask unchanged when the scene has only two luminance populations', async () => {
    const cv = await loadOpenCv();
    // Dark tool on bright paper, no mid-luminance band: multilevel Otsu is
    // degenerate, so the filter is a no-op and the mask is byte-for-byte equal.
    const rectified = sheet(cv, 80, 100, BRIGHT_PAPER);
    fillRect(cv, rectified, 25, 20, 70, 60, DARK_TOOL);
    const mask = emptyMask(cv, 80, 100);
    fillMask(cv, mask, 25, 20, 70, 60);
    const before = mask.clone();

    removeShadow(cv, rectified, mask);

    expect(Array.from(mask.data)).toEqual(Array.from(before.data));

    rectified.delete();
    mask.delete();
    before.delete();
  });
});
