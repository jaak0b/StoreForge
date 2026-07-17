/** Reference sheet sizes supported by the tool-trace calibration. */
export type PaperKind = 'letter' | 'a4';

/** A point in image pixel coordinates. */
export interface PixelPoint {
  x: number;
  y: number;
}

/** Sheet corners in photo pixels, ordered top-left, top-right, bottom-right, bottom-left. */
export interface PaperCorners {
  tl: PixelPoint;
  tr: PixelPoint;
  br: PixelPoint;
  bl: PixelPoint;
}

/** Result of proposing sheet corners in a photo; the user may still adjust them. */
export type PaperDetectionResult =
  | { ok: true; corners: PaperCorners; confidence: number }
  | { ok: false; error: string };

/** A click prompt for segmentation, in rectified-image pixels. Label 1 includes, 0 excludes. */
export interface SamPoint {
  x: number;
  y: number;
  label: 0 | 1;
}

/** A point in millimeters on the physical sheet, y increasing downward as in the image. */
export interface MmPoint {
  x: number;
  y: number;
}

/**
 * A traced tool outline in sheet millimeters. Coordinates live in the
 * rectified image frame (origin at the sheet's top-left corner, y increasing
 * downward). The outer loop has positive shoelace area and each hole has
 * negative shoelace area, so an EvenOdd or NonZero fill of outer plus holes
 * reproduces the tool silhouette with its through-holes.
 */
export interface TracedOutline {
  outer: MmPoint[];
  holes: MmPoint[][];
}

/** Scale calibration derived from rectifying the sheet to a top-down image. */
export interface PaperCalibration {
  /** The photo-pixel corners the rectification was computed from. */
  corners: PaperCorners;
  kind: PaperKind;
  /**
   * Millimeters per rectified pixel. Derived from the known paper width and
   * the rectified width in `engine/trace/paper.ts`; every later mm readout
   * must come from this figure.
   */
  mmPerPixel: number;
  rectifiedWidthPx: number;
  rectifiedHeightPx: number;
}
