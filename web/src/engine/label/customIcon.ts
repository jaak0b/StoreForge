import { svgPathToPolygons } from './svgPath';

/**
 * Validation for user-supplied custom label icons. The input is either bare
 * SVG path data (a d attribute) or a full SVG document with exactly one
 * <path> element. The path is actually converted to polygons with the same
 * parser the label pipeline uses, so anything accepted here is known to be
 * extrudable later. No Vue, no DOM.
 */

/** Result of validating custom icon input. */
export type CustomIconValidation =
  | {
      ok: true;
      /** The extracted (or passed-through) SVG path d attribute. */
      path: string;
      /** Tight bounding box of the path: [minX, minY, width, height]. */
      viewBox: [number, number, number, number];
    }
  | { ok: false; error: string };

const NO_PATH_ERROR = 'No path data found in this file.';
const MULTI_SHAPE_ERROR =
  'This SVG has more than one shape. Combine it into a single filled path ' +
  'before uploading, or trace it in a vector tool with a boolean union.';
const OPEN_OUTLINE_ERROR =
  "This SVG path doesn't look extrudable: it may have an open, unclosed " +
  'outline. Make sure the path forms a closed, filled shape.';

/** Extract the d attribute from SVG markup with exactly one path element. */
function extractPathData(markup: string): CustomIconValidation {
  const pathTags = markup.match(/<path\b[^>]*>/gi) ?? [];
  const otherShapes = markup.match(/<(rect|circle|ellipse|polygon|polyline|line)\b/gi) ?? [];
  if (pathTags.length + otherShapes.length > 1) {
    return { ok: false, error: MULTI_SHAPE_ERROR };
  }
  const firstPath = pathTags[0];
  if (firstPath === undefined) {
    return { ok: false, error: NO_PATH_ERROR };
  }
  const dMatch = /\bd\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(firstPath);
  const d = dMatch?.[1] ?? dMatch?.[2];
  if (d === undefined || d.trim() === '') {
    return { ok: false, error: NO_PATH_ERROR };
  }
  return validatePathData(d.trim());
}

/** Validate bare path data by converting it with the label path parser. */
function validatePathData(d: string): CustomIconValidation {
  let contours;
  try {
    contours = svgPathToPolygons(d);
  } catch (error) {
    // The parser names the exact syntax problem; the user only needs to know
    // the input did not contain usable path data.
    void error;
    return { ok: false, error: NO_PATH_ERROR };
  }
  if (contours.length === 0) {
    return { ok: false, error: NO_PATH_ERROR };
  }
  // Every subpath must be explicitly closed with Z; an unclosed outline is a
  // stroke, not a fillable shape.
  const subpaths = d.split(/(?=[Mm])/).filter((part) => /^[Mm]/.test(part.trim()));
  if (subpaths.some((part) => !/[Zz]\s*$/.test(part))) {
    return { ok: false, error: OPEN_OUTLINE_ERROR };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!(maxX > minX) || !(maxY > minY)) {
    return { ok: false, error: OPEN_OUTLINE_ERROR };
  }
  return { ok: true, path: d, viewBox: [minX, minY, maxX - minX, maxY - minY] };
}

/**
 * Validate custom icon input: a full SVG document, a lone <path> element, or
 * bare path data. Returns the extracted path and its bounding box on success,
 * or a user-worded error naming what is wrong.
 */
export function validateCustomIcon(input: string): CustomIconValidation {
  const text = input.trim();
  if (text === '') {
    return { ok: false, error: NO_PATH_ERROR };
  }
  if (text.includes('<')) {
    return extractPathData(text);
  }
  return validatePathData(text);
}
