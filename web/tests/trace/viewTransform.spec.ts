import { describe, expect, it } from 'vitest';
import {
  clampPan,
  clampZoom,
  imageToScreen,
  screenToImage,
  zoomToCursor,
} from '../../src/components/trace/viewTransform';

// The view transform maps image pixels to canvas pixels as
//   screen = image * zoom + pan
// so screenToImage inverts it. Expected values below are hand-derived literals,
// never recomputed with the production formula.

describe('clampZoom', () => {
  it('pins zoom below fit to 1', () => {
    expect(clampZoom(0.4)).toBe(1);
  });

  it('caps zoom at 8', () => {
    expect(clampZoom(50)).toBe(8);
  });

  it('leaves an in-range zoom untouched', () => {
    expect(clampZoom(3.5)).toBe(3.5);
  });
});

describe('clampPan', () => {
  it('recentres to (0, 0) at zoom 1 whatever the pan', () => {
    expect(clampPan({ zoom: 1, panX: 50, panY: -30 }, 200, 100)).toEqual({
      panX: 0,
      panY: 0,
    });
  });

  it('clamps a pan that would drag the image out of view', () => {
    // zoom 3 on a 200x100 canvas: panX in [-400, 0], panY in [-200, 0].
    expect(clampPan({ zoom: 3, panX: 100, panY: -500 }, 200, 100)).toEqual({
      panX: 0,
      panY: -200,
    });
  });

  it('leaves an in-range pan untouched', () => {
    expect(clampPan({ zoom: 3, panX: -50, panY: -100 }, 200, 100)).toEqual({
      panX: -50,
      panY: -100,
    });
  });
});

describe('screenToImage round-trips', () => {
  it('inverts the transform at zoom 2', () => {
    const transform = { zoom: 2, panX: -50, panY: -20 };
    // image (30, 40) -> screen (10, 60) -> image (30, 40).
    expect(imageToScreen({ x: 30, y: 40 }, transform)).toEqual({ x: 10, y: 60 });
    expect(screenToImage({ x: 10, y: 60 }, transform)).toEqual({ x: 30, y: 40 });
  });

  it('inverts the transform at zoom 4', () => {
    const transform = { zoom: 4, panX: -30, panY: -10 };
    // image (20, 25) -> screen (50, 90) -> image (20, 25).
    expect(imageToScreen({ x: 20, y: 25 }, transform)).toEqual({ x: 50, y: 90 });
    expect(screenToImage({ x: 50, y: 90 }, transform)).toEqual({ x: 20, y: 25 });
  });
});

describe('zoomToCursor', () => {
  it('keeps the image point under the anchor fixed', () => {
    const before = { zoom: 1, panX: 0, panY: 0 };
    const anchor = { x: 100, y: 50 };
    // At zoom 1 the anchor sits over image (100, 50).
    expect(screenToImage(anchor, before)).toEqual({ x: 100, y: 50 });

    const after = zoomToCursor(before, 2, anchor, 200, 100);
    expect(after).toEqual({ zoom: 2, panX: -100, panY: -50 });
    // The same anchor still sits over image (100, 50) after zooming.
    expect(screenToImage(anchor, after)).toEqual({ x: 100, y: 50 });
  });

  it('clamps the requested zoom before applying it', () => {
    const after = zoomToCursor({ zoom: 4, panX: -300, panY: -150 }, 20, { x: 100, y: 50 }, 200, 100);
    expect(after.zoom).toBe(8);
  });
});
