/**
 * Manual cavity edits: brush strokes and flatten operations a user applies to
 * a cutout bin's interior after the model carve. This module is the single
 * home for shared cavity-edit constants; the validator (planFile.ts) and the
 * editing UI both import from here rather than each defining their own bound.
 * Geometry application follows in a later task.
 */

/** Smallest brush radius a cavity edit may specify, in mm. */
export const CAVITY_EDIT_RADIUS_MIN_MM = 0.2;

/** Largest brush radius a cavity edit may specify, in mm. */
export const CAVITY_EDIT_RADIUS_MAX_MM = 50;
