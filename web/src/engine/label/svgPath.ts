import type { SimplePolygon } from 'manifold-3d';
import {
  DEFAULT_CHORD_TOLERANCE_MM,
  cleanContour,
  flattenArc,
  flattenCubic,
  flattenQuadratic,
} from './flatten';

/**
 * Minimal SVG path-data parser and flattener. Supports the absolute and
 * relative forms of M, L, H, V, C, S, Q, T, A and Z, which covers filled icon
 * paths. Output contours are in the path's own coordinate system (y down, as
 * in SVG); the caller is responsible for any flip and scaling.
 */

interface Token {
  command: string;
  args: number[];
}

const ARG_COUNTS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

const NUMBER_RE = /^[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/;

/** Split path data into commands with their numeric arguments. */
function tokenize(d: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let currentCommand: string | null = null;
  const skipSeparators = (): void => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const readNumber = (flagArg: boolean): number => {
    skipSeparators();
    // Arc flags may be written without separators ("a1 1 0 011 1").
    if (flagArg && (d[i] === '0' || d[i] === '1')) {
      const flag = Number(d[i]);
      i++;
      return flag;
    }
    const match = NUMBER_RE.exec(d.slice(i));
    if (!match) {
      throw new Error(`Invalid SVG path data: expected a number at index ${i} of "${d}"`);
    }
    i += match[0].length;
    return Number(match[0]);
  };
  while (i < d.length) {
    skipSeparators();
    if (i >= d.length) break;
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) {
      currentCommand = ch;
      i++;
    } else if (currentCommand === null) {
      throw new Error(`Invalid SVG path data: it must start with a command, got "${d}"`);
    } else if (currentCommand.toUpperCase() === 'Z') {
      throw new Error(`Invalid SVG path data: numbers after Z at index ${i} of "${d}"`);
    } else if (currentCommand.toUpperCase() === 'M') {
      // Implicit repetition of M is a lineto of the same relativity.
      currentCommand = currentCommand === 'M' ? 'L' : 'l';
    }
    const upper = currentCommand.toUpperCase();
    const count = ARG_COUNTS[upper];
    if (count === undefined) {
      throw new Error(`Unsupported SVG path command "${currentCommand}" in "${d}"`);
    }
    const args: number[] = [];
    for (let k = 0; k < count; k++) {
      const flagArg = upper === 'A' && (k === 3 || k === 4);
      args.push(readNumber(flagArg));
    }
    tokens.push({ command: currentCommand, args });
    skipSeparators();
  }
  return tokens;
}

/**
 * One flattened subpath: its polyline points in the path's own coordinate
 * system (y down) and whether the subpath was explicitly closed with Z. A
 * closed subpath is a filled outline; an open one is a stroke centreline.
 */
export interface Subpath {
  points: SimplePolygon;
  closed: boolean;
}

/**
 * Parse an SVG path d attribute and flatten every subpath into a polyline,
 * preserving each subpath's open or closed state and keeping short subpaths
 * (down to a single move) that a filled-contour parse would discard. This is
 * the shared core: filled parsing cleans and drops sub-triangle contours,
 * while stroke expansion needs the raw polylines and their closed flags.
 */
export function pathToSubpaths(
  d: string,
  toleranceMm: number = DEFAULT_CHORD_TOLERANCE_MM,
): Subpath[] {
  const tokens = tokenize(d);
  const subpaths: Subpath[] = [];
  let current: SimplePolygon = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // Previous control point for the S and T shorthand reflections.
  let prevCubicControl: [number, number] | null = null;
  let prevQuadControl: [number, number] | null = null;

  const finish = (closed: boolean): void => {
    if (current.length > 0) subpaths.push({ points: current, closed });
    current = [];
  };

  for (const { command, args } of tokens) {
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const ox = relative ? cx : 0;
    const oy = relative ? cy : 0;
    if (upper !== 'C' && upper !== 'S') prevCubicControl = null;
    if (upper !== 'Q' && upper !== 'T') prevQuadControl = null;
    switch (upper) {
      case 'M':
        finish(false);
        cx = ox + args[0];
        cy = oy + args[1];
        startX = cx;
        startY = cy;
        current.push([cx, cy]);
        break;
      case 'L':
        cx = ox + args[0];
        cy = oy + args[1];
        current.push([cx, cy]);
        break;
      case 'H':
        cx = ox + args[0];
        current.push([cx, cy]);
        break;
      case 'V':
        cy = relative ? cy + args[0] : args[0];
        current.push([cx, cy]);
        break;
      case 'C': {
        const p1: [number, number] = [ox + args[0], oy + args[1]];
        const p2: [number, number] = [ox + args[2], oy + args[3]];
        const p3: [number, number] = [ox + args[4], oy + args[5]];
        flattenCubic(current, [cx, cy], p1, p2, p3, toleranceMm);
        prevCubicControl = p2;
        [cx, cy] = p3;
        break;
      }
      case 'S': {
        const p1: [number, number] = prevCubicControl
          ? [2 * cx - prevCubicControl[0], 2 * cy - prevCubicControl[1]]
          : [cx, cy];
        const p2: [number, number] = [ox + args[0], oy + args[1]];
        const p3: [number, number] = [ox + args[2], oy + args[3]];
        flattenCubic(current, [cx, cy], p1, p2, p3, toleranceMm);
        prevCubicControl = p2;
        [cx, cy] = p3;
        break;
      }
      case 'Q': {
        const p1: [number, number] = [ox + args[0], oy + args[1]];
        const p2: [number, number] = [ox + args[2], oy + args[3]];
        flattenQuadratic(current, [cx, cy], p1, p2, toleranceMm);
        prevQuadControl = p1;
        [cx, cy] = p2;
        break;
      }
      case 'T': {
        const p1: [number, number] = prevQuadControl
          ? [2 * cx - prevQuadControl[0], 2 * cy - prevQuadControl[1]]
          : [cx, cy];
        const p2: [number, number] = [ox + args[0], oy + args[1]];
        flattenQuadratic(current, [cx, cy], p1, p2, toleranceMm);
        prevQuadControl = p1;
        [cx, cy] = p2;
        break;
      }
      case 'A': {
        const ex = ox + args[5];
        const ey = oy + args[6];
        flattenArc(
          current,
          cx,
          cy,
          args[0],
          args[1],
          args[2],
          args[3] !== 0,
          args[4] !== 0,
          ex,
          ey,
          toleranceMm,
        );
        cx = ex;
        cy = ey;
        break;
      }
      case 'Z':
        cx = startX;
        cy = startY;
        finish(true);
        break;
      default:
        throw new Error(`Unsupported SVG path command "${command}"`);
    }
  }
  finish(false);
  return subpaths;
}

/**
 * Parse an SVG path d attribute and flatten it into closed polygon contours
 * suitable for an even-odd filled cross-section. Subpaths that collapse to
 * fewer than three distinct points carry no fillable area and are dropped.
 */
export function svgPathToPolygons(
  d: string,
  toleranceMm: number = DEFAULT_CHORD_TOLERANCE_MM,
): SimplePolygon[] {
  const contours: SimplePolygon[] = [];
  for (const subpath of pathToSubpaths(d, toleranceMm)) {
    const cleaned = cleanContour(subpath.points);
    if (cleaned) contours.push(cleaned);
  }
  return contours;
}

/**
 * Parse an SVG path d attribute and flatten it into open or closed polylines,
 * keeping every subpath with at least two points (including the degenerate
 * two-point lengths that draw a rounded dot when stroked). Used by stroke
 * expansion, which needs the centrelines rather than filled contours.
 */
export function flattenPathToPolylines(
  d: string,
  toleranceMm: number = DEFAULT_CHORD_TOLERANCE_MM,
): Subpath[] {
  return pathToSubpaths(d, toleranceMm).filter((subpath) => subpath.points.length >= 2);
}
