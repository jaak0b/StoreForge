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

/**
 * A finger hole punched through the tool pocket so the tool can be lifted
 * out. Coordinates are tool-local millimeters (the same frame as the tool's
 * outline points); the pocket generator subtracts the circle from the pocket
 * floor region.
 */
export interface FingerHole {
  x: number;
  y: number;
  diameterMm: number;
}

/**
 * A tool destined for a shadow-board pocket, as stored in a plan entry.
 * Plain JSON throughout so it serializes with the plan file.
 *
 * `outline` is the raw traced (or primitive) silhouette in tool-local mm and
 * is never mutated by editing; the editing operations are parameters applied
 * on read. The canonical pipeline, implemented by
 * `resolvedToolOutline(m, tool)` in `engine/trace/edit.ts`, is:
 *
 *   1. mirror (across the vertical axis through the outline centroid),
 *   2. rotate (`rotationDeg` counterclockwise about the same centroid),
 *   3. clearance (`offsetMm` outward offset with rounded joins).
 *
 * Rotation and mirroring are rigid, so the clearance offset commutes with
 * them and the ordering is mathematically free; clearance runs last anyway so
 * there is exactly one canonical pipeline and `offsetMm` reads as a true
 * millimeter figure applied to the final orientation. The result is returned
 * in the same tool-local mm frame, ready for the pocket generator to place
 * and extrude. Finger holes are not merged into the resolved outline; the
 * pocket generator cuts them separately (they pierce the pocket floor, not
 * the silhouette).
 */
export interface TracedTool {
  id: string;
  name: string;
  outline: TracedOutline;
  /** Counterclockwise rotation in degrees applied about the outline centroid. */
  rotationDeg: number;
  /** Outward clearance in mm between tool and pocket wall, 0 to 4.5. */
  offsetMm: number;
  /** Mirror across the vertical axis through the outline centroid. */
  mirrored: boolean;
  fingerHoles: FingerHole[];
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
