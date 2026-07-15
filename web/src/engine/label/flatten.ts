import type { SimplePolygon } from 'manifold-3d';

/**
 * Curve flattening helpers shared by the text and SVG path converters.
 * All routines append line-segment endpoints to an output contour so the
 * result deviates from the true curve by at most the chord tolerance.
 */

/** Default chord tolerance in millimetres for flattening curves. */
export const DEFAULT_CHORD_TOLERANCE_MM = 0.02;

type Point = [number, number];

/** Distance of point p from the line through a and b. */
function distanceToLine(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

/**
 * Adaptively flatten a quadratic Bezier from p0 to p2 with control point p1,
 * appending all points after p0 (including p2) to out.
 */
export function flattenQuadratic(
  out: SimplePolygon,
  p0: Point,
  p1: Point,
  p2: Point,
  tolerance: number,
  depth: number = 0,
): void {
  if (depth >= 16 || distanceToLine(p1, p0, p2) <= tolerance) {
    out.push(p2);
    return;
  }
  const p01: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const p12: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const mid: Point = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2];
  flattenQuadratic(out, p0, p01, mid, tolerance, depth + 1);
  flattenQuadratic(out, mid, p12, p2, tolerance, depth + 1);
}

/**
 * Adaptively flatten a cubic Bezier from p0 to p3 with control points p1 and
 * p2, appending all points after p0 (including p3) to out.
 */
export function flattenCubic(
  out: SimplePolygon,
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  tolerance: number,
  depth: number = 0,
): void {
  const flat =
    distanceToLine(p1, p0, p3) <= tolerance && distanceToLine(p2, p0, p3) <= tolerance;
  if (depth >= 16 || flat) {
    out.push(p3);
    return;
  }
  const p01: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const p12: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const p23: Point = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
  const p012: Point = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2];
  const p123: Point = [(p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2];
  const mid: Point = [(p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2];
  flattenCubic(out, p0, p01, p012, mid, tolerance, depth + 1);
  flattenCubic(out, mid, p123, p23, p3, tolerance, depth + 1);
}

/**
 * Flatten an SVG elliptical arc (endpoint parameterisation, as in the A path
 * command) from (x1, y1) to (x2, y2), appending all points after the start
 * point (including the end point) to out. Implements the endpoint-to-centre
 * conversion from the SVG 1.1 specification, appendix B.2.4.
 */
export function flattenArc(
  out: SimplePolygon,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  xAxisRotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
  tolerance: number,
): void {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    out.push([x2, y2]);
    return;
  }
  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: transform to the ellipse-aligned frame.
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Correct out-of-range radii.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  // Step 2: centre in the ellipse-aligned frame.
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  // Step 3: centre in the original frame.
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // Step 4: start angle and sweep extent.
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  // Segment count so each chord stays within the tolerance of the arc:
  // for a circular arc, sagitta = r (1 - cos(step / 2)) <= tolerance.
  const rMax = Math.max(rx, ry);
  const maxStep = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - tolerance / rMax)));
  const segments = Math.max(1, Math.ceil(Math.abs(deltaTheta) / Math.max(maxStep, 1e-3)));

  for (let i = 1; i <= segments; i++) {
    const t = theta1 + (deltaTheta * i) / segments;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cosPhi * ex - sinPhi * ey + cx, sinPhi * ex + cosPhi * ey + cy]);
  }
}

/**
 * Drop consecutive duplicate points (and a duplicated closing point) from a
 * contour, returning null when fewer than three distinct points remain.
 */
export function cleanContour(contour: SimplePolygon): SimplePolygon | null {
  const eps = 1e-9;
  const cleaned: SimplePolygon = [];
  for (const point of contour) {
    const last = cleaned[cleaned.length - 1];
    if (last && Math.abs(last[0] - point[0]) < eps && Math.abs(last[1] - point[1]) < eps) {
      continue;
    }
    cleaned.push(point);
  }
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first[0] - last[0]) < eps && Math.abs(first[1] - last[1]) < eps) {
      cleaned.pop();
    }
  }
  return cleaned.length >= 3 ? cleaned : null;
}
