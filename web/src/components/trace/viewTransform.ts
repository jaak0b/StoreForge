/**
 * Pure view-transform math for the trace canvas zoom and pan.
 *
 * The canvas is drawn in image pixels through an affine transform
 *   screen = image * zoom + pan
 * applied with ctx.setTransform(zoom, 0, 0, zoom, panX, panY). These helpers
 * compute and constrain that transform without touching the DOM so the screen
 * point under the cursor stays fixed while zooming, the image never leaves the
 * viewport, and clicks and brush strokes invert back to image pixels at any
 * zoom. "screen" here means canvas pixels (the canvas backing-store space,
 * el.width by el.height), not CSS pixels; the caller maps CSS to canvas pixels
 * before invoking these.
 */

/** The smallest zoom: fit, matching the untransformed canvas. */
export const MIN_ZOOM = 1;
/** The largest zoom the wheel and reset math allow. */
export const MAX_ZOOM = 8;

/** A 2D point in either screen (canvas) or image pixels. */
export interface Vec2 {
  x: number;
  y: number;
}

/** The zoom factor and translation of the canvas view transform. */
export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

/** A supported zoom range, min and max inclusive. */
export interface ZoomRange {
  min: number;
  max: number;
}

/** The default zoom range every caller gets unless it passes its own. */
export const DEFAULT_ZOOM_RANGE: ZoomRange = { min: MIN_ZOOM, max: MAX_ZOOM };

/**
 * Clamps a zoom factor into a supported range, [MIN_ZOOM, MAX_ZOOM] unless the
 * caller passes a different range (e.g. the sketch canvas's wider zoom-out
 * range for its unbounded design space).
 */
export function clampZoom(zoom: number, range: ZoomRange = DEFAULT_ZOOM_RANGE): number {
  if (zoom < range.min) return range.min;
  if (zoom > range.max) return range.max;
  return zoom;
}

/**
 * Clamps the pan so the scaled image always covers the canvas viewport, so it
 * can never be dragged fully out of view. With zoom >= 1 the image is at least
 * as large as the canvas, so panX lies in [canvasWidth * (1 - zoom), 0] and
 * panY in [canvasHeight * (1 - zoom), 0]. At zoom 1 the only valid pan is
 * (0, 0), which recentres the view.
 */
export function clampPan(
  transform: ViewTransform,
  canvasWidth: number,
  canvasHeight: number,
): { panX: number; panY: number } {
  const minPanX = canvasWidth * (1 - transform.zoom);
  const minPanY = canvasHeight * (1 - transform.zoom);
  return {
    panX: Math.min(0, Math.max(minPanX, transform.panX)),
    panY: Math.min(0, Math.max(minPanY, transform.panY)),
  };
}

/** Maps a screen (canvas) point to image pixels through the inverse transform. */
export function screenToImage(screen: Vec2, transform: ViewTransform): Vec2 {
  return {
    x: (screen.x - transform.panX) / transform.zoom,
    y: (screen.y - transform.panY) / transform.zoom,
  };
}

/** Maps an image point to screen (canvas) pixels through the transform. */
export function imageToScreen(image: Vec2, transform: ViewTransform): Vec2 {
  return {
    x: image.x * transform.zoom + transform.panX,
    y: image.y * transform.zoom + transform.panY,
  };
}

/**
 * Produces the transform after zooming to newZoom while keeping the image point
 * currently under the given screen (canvas) anchor stationary: standard
 * zoom-to-cursor. The new zoom is clamped and the resulting pan is clamped so
 * the image stays in view; the anchor stays fixed exactly whenever the clamp
 * does not bind.
 */
export function zoomToCursor(
  transform: ViewTransform,
  newZoom: number,
  anchor: Vec2,
  canvasWidth: number,
  canvasHeight: number,
  zoomRange: ZoomRange = DEFAULT_ZOOM_RANGE,
): ViewTransform {
  const zoom = clampZoom(newZoom, zoomRange);
  const imagePoint = screenToImage(anchor, transform);
  const panned = {
    zoom,
    panX: anchor.x - imagePoint.x * zoom,
    panY: anchor.y - imagePoint.y * zoom,
  };
  const { panX, panY } = clampPan(panned, canvasWidth, canvasHeight);
  return { zoom, panX, panY };
}
