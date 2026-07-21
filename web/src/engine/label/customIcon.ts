import type { CrossSection, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { DEFAULT_CHORD_TOLERANCE_MM } from './flatten';
import { flattenPathToPolylines, svgPathToPolygons } from './svgPath';
import {
  applyMatrix,
  matrixScale,
  readSvgShapes,
  type Matrix,
  type ResolvedShape,
} from './svgDocument';

/**
 * Validation and normalization for user-supplied custom label icons. The input
 * is either bare SVG path data or a full SVG document with any mix of filled
 * shapes, primitives (rect, circle, ellipse, line, polyline, polygon) and
 * stroked outlines. Primitives are converted to path data and transforms are
 * flattened, filled shapes are unioned into one set of contours, and stroked
 * shapes are expanded to filled outlines and unioned in as well. The stored
 * result is a single path d string, so the downstream placement and extrusion
 * stages, which read one filled path under the even-odd rule, are unchanged.
 *
 * The union and the stroke expansion are Clipper2 (manifold-3d) operations, so
 * normalizeCustomIcon takes the loaded ManifoldToplevel and runs in the worker;
 * validateCustomIcon stays synchronous for revalidating an already normalized,
 * stored path, which needs no boolean geometry. No Vue, no DOM.
 */

/** Result of validating custom icon input. */
export type CustomIconValidation =
  | {
      ok: true;
      /** The stored SVG path d attribute (a single normalized path). */
      path: string;
      /** Tight bounding box of the path: [minX, minY, width, height]. */
      viewBox: [number, number, number, number];
    }
  | { ok: false; error: string };

const NO_PATH_ERROR = 'No path data found in this file.';
const NO_GEOMETRY_ERROR =
  'This file has no drawable shape to emboss. Add a filled shape or a stroked ' +
  'outline, then upload it again.';
const EMPTY_AREA_ERROR =
  'This SVG produced no filled area. Its shapes may be zero width or fully ' +
  'overlapping in a way that cancels out.';

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Tight bounding box of a set of contours, or null when there are no points. */
function boundingBox(contours: SimplePolygon[]): [number, number, number, number] | null {
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
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX - minX, maxY - minY];
}

/** Twice the total signed area of a set of contours (shoelace), for a degeneracy check. */
function totalDoubleArea(contours: SimplePolygon[]): number {
  let sum = 0;
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const [x1, y1] = contour[i];
      const [x2, y2] = contour[(i + 1) % contour.length];
      sum += x1 * y2 - x2 * y1;
    }
  }
  return Math.abs(sum);
}

/** Format a coordinate compactly without corrupting it below print resolution. */
function formatCoord(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** Serialize contours as one SVG path d string with a closing Z on each contour. */
function contoursToPathData(contours: SimplePolygon[]): string {
  return contours
    .map((contour) => {
      const commands = contour
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${formatCoord(x)} ${formatCoord(y)}`)
        .join('');
      return `${commands}Z`;
    })
    .join('');
}

/** Apply an affine transform to every point of a set of contours. */
function transformContours(contours: SimplePolygon[], matrix: Matrix): SimplePolygon[] {
  if (matrix === IDENTITY) return contours;
  return contours.map((contour) => contour.map((point) => applyMatrix(matrix, point)));
}

/**
 * Number of segments to approximate a full circle of the given radius so each
 * chord stays within the chord tolerance, from the sagitta relation
 * sagitta = r (1 - cos(step / 2)) <= tolerance (the same bound flatten.ts uses
 * for arcs). Used for the round stroke caps and joins.
 */
function circleSegments(radius: number): number {
  const maxStep = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - DEFAULT_CHORD_TOLERANCE_MM / radius)));
  return Math.max(8, Math.ceil((2 * Math.PI) / Math.max(maxStep, 1e-3)));
}

/**
 * Expand a stroked centreline into filled cross-sections: the Minkowski sum of
 * the polyline with a disk of radius half the stroke width. That is exactly an
 * SVG stroke with round joins and round caps, and it is built as the union of a
 * disk at every vertex (the round joins and end caps) and a rectangle along
 * every segment (the stroke body). A straight line therefore grows to its
 * length plus the stroke width by the stroke width, and a near-zero-length
 * segment collapses to a single round dot. Manifold has no open-path offset, so
 * this disk dilation stands in for CrossSection.offset(radius, 'Round') on an
 * open path; the round joins and caps are the same result.
 */
function strokeToPieces(
  m: ManifoldToplevel,
  points: SimplePolygon,
  closed: boolean,
  radius: number,
): CrossSection[] {
  const pieces: CrossSection[] = [];
  const segments = circleSegments(radius);
  for (const [x, y] of points) {
    pieces.push(m.CrossSection.circle(radius, segments).translate(x, y));
  }
  const segmentCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    // The stroke body: the segment offset by the radius on either side. The
    // round caps and joins are supplied by the vertex disks above.
    const nx = (-dy / length) * radius;
    const ny = (dx / length) * radius;
    const rectangle: SimplePolygon = [
      [ax + nx, ay + ny],
      [bx + nx, by + ny],
      [bx - nx, by - ny],
      [ax - nx, ay - ny],
    ];
    pieces.push(new m.CrossSection([rectangle], 'NonZero'));
  }
  return pieces;
}

/** Build the filled and stroked cross-section pieces contributed by one shape. */
function shapeToPieces(m: ManifoldToplevel, shape: ResolvedShape): CrossSection[] {
  const pieces: CrossSection[] = [];
  if (shape.hasFill) {
    const filled = transformContours(svgPathToPolygons(shape.d), shape.matrix);
    if (filled.length > 0) pieces.push(new m.CrossSection(filled, shape.fillRule));
  }
  if (shape.strokeWidth !== null) {
    const radius = (shape.strokeWidth * matrixScale(shape.matrix)) / 2;
    for (const subpath of flattenPathToPolylines(shape.d)) {
      const points = subpath.points.map((point) => applyMatrix(shape.matrix, point));
      pieces.push(...strokeToPieces(m, points, subpath.closed, radius));
    }
  }
  return pieces;
}

/**
 * Normalize custom icon input into a single filled path. Reads the SVG (or a
 * bare path treated as one filled shape), unions every filled and expanded-
 * stroke piece with a Clipper2 boolean union, and returns the merged contours
 * as one path d string. User-fixable problems come back as worded messages.
 */
export function normalizeCustomIcon(
  m: ManifoldToplevel,
  input: string,
): CustomIconValidation {
  const text = input.trim();
  if (text === '') return { ok: false, error: NO_PATH_ERROR };

  let shapes: ResolvedShape[];
  if (text.includes('<')) {
    try {
      shapes = readSvgShapes(text);
    } catch {
      // The reader names the exact structural problem; the user only needs to
      // know the file held no usable drawing.
      return { ok: false, error: NO_GEOMETRY_ERROR };
    }
  } else {
    // Bare path data: one filled shape with no transform.
    shapes = [{ d: text, matrix: IDENTITY, hasFill: true, fillRule: 'NonZero', strokeWidth: null }];
  }

  const pieces: CrossSection[] = [];
  try {
    for (const shape of shapes) pieces.push(...shapeToPieces(m, shape));
  } catch {
    // A parse or offset failure on any shape means the input is not usable.
    for (const piece of pieces) piece.delete();
    return { ok: false, error: NO_GEOMETRY_ERROR };
  }

  if (pieces.length === 0) {
    return { ok: false, error: NO_GEOMETRY_ERROR };
  }

  let contours: SimplePolygon[];
  const union = m.CrossSection.union(pieces);
  try {
    contours = union.toPolygons();
  } finally {
    union.delete();
    for (const piece of pieces) piece.delete();
  }

  const viewBox = boundingBox(contours);
  if (viewBox === null || !(viewBox[2] > 0) || !(viewBox[3] > 0) || totalDoubleArea(contours) <= 1e-9) {
    return { ok: false, error: EMPTY_AREA_ERROR };
  }
  return { ok: true, path: contoursToPathData(contours), viewBox };
}

/**
 * Validate an already normalized, stored icon path (a bare d string). Confirms
 * it still parses to filled contours with a non-zero area, so a corrupted store
 * can never feed an unusable path into the label pipeline. Synchronous because
 * a stored path is a single filled path and needs no boolean geometry.
 */
export function validateCustomIcon(input: string): CustomIconValidation {
  const text = input.trim();
  if (text === '') return { ok: false, error: NO_PATH_ERROR };
  let contours: SimplePolygon[];
  try {
    contours = svgPathToPolygons(text);
  } catch {
    return { ok: false, error: NO_PATH_ERROR };
  }
  if (contours.length === 0) {
    return { ok: false, error: NO_PATH_ERROR };
  }
  const viewBox = boundingBox(contours);
  if (viewBox === null || !(viewBox[2] > 0) || !(viewBox[3] > 0)) {
    return { ok: false, error: NO_PATH_ERROR };
  }
  return { ok: true, path: text, viewBox };
}
