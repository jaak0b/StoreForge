/** Reference sheet sizes supported by the tool-trace calibration. */
export type PaperKind = 'letter' | 'a4';

/** A point in image pixel coordinates. */
export interface PixelPoint {
  x: number;
  y: number;
}

/**
 * A freehand brush stroke painted onto the segmentation mask, in
 * rectified-image pixels (the same frame as TracedTool.clicks). An 'add'
 * stroke unions its swept-disc region into the mask; an 'erase' stroke
 * subtracts it; a 'smooth' stroke leaves the mask's set and cleared regions
 * alone and instead median-filters the mask inside its swept disc, cleaning up
 * a ragged boundary. Strokes apply in stored order, last stroke wins on
 * overlap.
 */
export interface BrushStroke {
  mode: 'add' | 'erase' | 'smooth';
  /** Brush radius in millimeters; the swept disc has this radius. */
  radiusMm: number;
  /** Polyline vertices in rectified-image pixels; one vertex is a dot. */
  points: PixelPoint[];
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

/**
 * Per-request settings for a segmentation run. Every field must be a plain
 * structured-cloneable value, because this object crosses the worker boundary.
 */
export interface SegmentOptions {
  /**
   * True when the photo has strong cast shadows around the tools, which turns
   * on the shadow and paper-halo post-filter. Default false: that filter reads
   * a gray metal tool as a gray shadow and deletes it, so it only runs when the
   * user states that the photo needs it.
   */
  removeShadows?: boolean;
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
 * outline points); the pocket generator subtracts the hole's outline from the
 * pocket floor region. The hole is a capsule: a circle of diameterMm swept
 * from (x, y) to the optional second endpoint (x2, y2). When the second
 * endpoint is absent or equals the first, the hole is a plain circle.
 */
export interface FingerHole {
  x: number;
  y: number;
  /** Second endpoint of an elongated (slot) hole; absent for a circle. */
  x2?: number;
  y2?: number;
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
 *   1. mirror (across the vertical axis through the outline centroid) and
 *      rotate (`rotationDeg` counterclockwise about the same centroid),
 *   2. remove the holes named in `filledHoleIndices`,
 *   3. cull holes narrower than `minHoleWidthMm`,
 *   4. clearance (`offsetMm` outward offset with rounded joins).
 *
 * A hole in the outline leaves a standing island inside the pocket (the
 * cross-section is an EvenOdd fill of outer plus holes); removing a hole cuts
 * that island away. Steps 2 and 3 both drop holes so no unwanted island is
 * left standing: step 2 by the user's explicit choice, step 3 by a width test
 * against the raw (pre-clearance) hole. Culling runs before clearance so the
 * width figure is measured on the hole as traced; the two compose freely, and
 * the clearance offset independently drops any hole thinner than
 * 2 * offsetMm.
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
  /**
   * The click prompts (rectified-image pixels) that produced the outline,
   * kept so re-tracing from the stored photo can restore and continue the
   * segmentation. Empty for primitive shapes and for tools imported from
   * plans that predate click storage.
   */
  clicks: SamPoint[];
  /**
   * Brush strokes painted onto the mask during tracing (rectified-image
   * pixels), kept so re-tracing can restore and reapply them. Absent for
   * primitive shapes and for tools imported from plans that predate painting.
   */
  brushStrokes?: BrushStroke[];
  /** Counterclockwise rotation in degrees applied about the outline centroid. */
  rotationDeg: number;
  /** Outward clearance in mm between tool and pocket wall, 0 to 4.5. */
  offsetMm: number;
  /** Mirror across the vertical axis through the outline centroid. */
  mirrored: boolean;
  /**
   * Interior holes narrower than this (their thinnest width) are filled during
   * resolve so no thin island is left standing in the pocket. 0 keeps every
   * hole. Measured by the polygon erosion emptiness test in edit.ts.
   */
  minHoleWidthMm: number;
  /**
   * Indices into `outline.holes` that the user manually filled, so their
   * islands are cut away. Stable for the life of the outline; cleared on
   * re-trace.
   */
  filledHoleIndices: number[];
  fingerHoles: FingerHole[];
}

/**
 * One tool's position in a pocket bin, as stored in a plan entry (plain JSON).
 * The offset is added to every point of the tool's resolved outline (see
 * `resolvedToolOutline`) and to its finger-hole centres, mapping tool-local mm
 * directly onto bin-local mm with the bin centred on the origin.
 */
export interface ToolPlacement {
  toolId: string;
  /** Bin-local X offset of the tool's outline origin, in mm. */
  xMm: number;
  /** Bin-local Y offset of the tool's outline origin, in mm. */
  yMm: number;
  /** How far the pocket sinks below the nominal bin top, in mm. */
  pocketDepthMm: number;
  /**
   * How far the tool-outline pocket's walls lean outward toward the top, in
   * degrees, matching the swept-pocket draft on a cutout model (see
   * DEFAULT_DRAFT_ANGLE_DEG and isDraftAngleDegValid in engine/carve/sweep.ts).
   * 0 means straight vertical walls. It applies to the tool outline pocket
   * only, never to the finger holes, which are always cut straight through.
   */
  draftAngleDeg: number;
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
