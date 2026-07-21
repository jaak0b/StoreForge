import SVGPathCommander from 'svg-path-commander';

/**
 * Framework-agnostic SVG document reader for custom label icons. Parses the
 * markup into an element tree without a DOM (the engine may not touch one),
 * resolves each drawable element's paint and inherited transform, and converts
 * primitives to path data with svg-path-commander. The geometry itself (curve
 * flattening, boolean union, stroke expansion) is left to the caller, which
 * owns the manifold instance; this module only turns markup into a flat list
 * of resolved shapes.
 */

/** A 2D affine transform stored as [a, b, c, d, e, f] (SVG matrix order). */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose two affine transforms so applyMatrix(multiply(a, b), p) === a(b(p)). */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Map a point through an affine transform. */
export function applyMatrix(m: Matrix, point: [number, number]): [number, number] {
  return [
    m[0] * point[0] + m[2] * point[1] + m[4],
    m[1] * point[0] + m[3] * point[1] + m[5],
  ];
}

/**
 * The uniform-equivalent scale of an affine transform, sqrt(abs(det)). Stroke
 * width is a scalar, so under a transform it scales by this factor: the
 * geometric mean of the two axis scales, which is exact for uniform scales and
 * the standard choice for non-uniform ones.
 */
export function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

const NUMBER_LIST_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/** Parse an SVG transform attribute (translate, scale, rotate, skewX/Y, matrix). */
function parseTransform(value: string): Matrix {
  let result: Matrix = IDENTITY;
  const callRe = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(value)) !== null) {
    const name = match[1];
    const args = (match[2].match(NUMBER_LIST_RE) ?? []).map(Number);
    let step: Matrix = IDENTITY;
    switch (name) {
      case 'matrix':
        if (args.length === 6) step = args as Matrix;
        break;
      case 'translate':
        step = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        step = [sx, 0, 0, args[1] ?? sx, 0, 0];
        break;
      }
      case 'rotate': {
        const rad = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          const cx = args[1];
          const cy = args[2];
          step = multiply([1, 0, 0, 1, cx, cy], multiply(rot, [1, 0, 0, 1, -cx, -cy]));
        } else {
          step = rot;
        }
        break;
      }
      case 'skewX':
        step = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        step = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        break;
    }
    result = multiply(result, step);
  }
  return result;
}

/** One element of the parsed SVG tree: tag, attributes and children. */
interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
  children: SvgElement[];
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const name = (match[1] ?? match[3]).toLowerCase();
    attrs[name] = match[2] ?? match[4];
  }
  return attrs;
}

/**
 * Parse SVG markup into an element tree. This is a small XML reader, not a full
 * parser: it drops comments, CDATA, processing instructions and doctype
 * declarations, then reads element tags with quoted attributes, which is what
 * icon markup is made of. Returns the outermost element, or throws when no
 * element is found so the caller can word the failure.
 */
function parseSvg(markup: string): SvgElement {
  const cleaned = markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const root: SvgElement = { tag: '#root', attrs: {}, children: [] };
  const stack: SvgElement[] = [root];
  const tagRe = /<\s*(\/?)\s*([a-zA-Z_:][-a-zA-Z0-9_:.]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const selfClosing = match[4] === '/';
    if (closing) {
      // Pop to the matching open tag; ignore a stray close with no match.
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const element: SvgElement = { tag, attrs: parseAttrs(match[3]), children: [] };
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
  }

  const svg = root.children.find((child) => child.tag === 'svg') ?? root.children[0];
  if (svg === undefined) {
    throw new Error('No SVG element found in this file.');
  }
  return svg;
}

/** Paint and transform inherited down the element tree. */
interface PaintContext {
  fill: string;
  stroke: string;
  strokeWidth: string;
  fillRule: string;
  matrix: Matrix;
}

function parseStyle(style: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx <= 0) continue;
    map[decl.slice(0, idx).trim().toLowerCase()] = decl.slice(idx + 1).trim();
  }
  return map;
}

/** Read a paint property, preferring an inline style declaration over the attribute. */
function paintProperty(
  attrs: Record<string, string>,
  style: Record<string, string>,
  name: string,
): string | undefined {
  return style[name] ?? attrs[name];
}

function numAttr(attrs: Record<string, string>, name: string, fallback: number): number {
  const raw = attrs[name];
  if (raw === undefined) return fallback;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A drawable shape resolved to path data plus the paint that decides how it
 * contributes to the icon: a filled area, an expanded stroke, or both.
 */
export interface ResolvedShape {
  /** Path data in the element's local coordinate system. */
  d: string;
  /** Accumulated transform from the root to this element. */
  matrix: Matrix;
  /** True when the shape has a fill (fill is not "none"). */
  hasFill: boolean;
  /** Even-odd or non-zero, from the element's fill-rule. */
  fillRule: 'EvenOdd' | 'NonZero';
  /** Stroke width in local units, or null when there is no stroke to expand. */
  strokeWidth: number | null;
}

const DRAWABLE_TAGS = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
]);

type ShapeOps = Parameters<typeof SVGPathCommander.shapeToPathArray>[0];

/** Convert one primitive element to path data, or null when it draws nothing. */
function primitiveToPathData(el: SvgElement): string | null {
  const a = el.attrs;
  let ops: ShapeOps | null = null;
  switch (el.tag) {
    case 'rect': {
      const width = numAttr(a, 'width', 0);
      const height = numAttr(a, 'height', 0);
      if (!(width > 0) || !(height > 0)) return null;
      ops = {
        type: 'rect',
        width,
        height,
        x: numAttr(a, 'x', 0),
        y: numAttr(a, 'y', 0),
        rx: numAttr(a, 'rx', 0),
        ry: numAttr(a, 'ry', 0),
      } as ShapeOps;
      break;
    }
    case 'circle': {
      const r = numAttr(a, 'r', 0);
      if (!(r > 0)) return null;
      ops = { type: 'circle', cx: numAttr(a, 'cx', 0), cy: numAttr(a, 'cy', 0), r } as ShapeOps;
      break;
    }
    case 'ellipse': {
      const rx = numAttr(a, 'rx', 0);
      const ry = numAttr(a, 'ry', 0);
      if (!(rx > 0) || !(ry > 0)) return null;
      ops = { type: 'ellipse', cx: numAttr(a, 'cx', 0), cy: numAttr(a, 'cy', 0), rx, ry } as ShapeOps;
      break;
    }
    case 'line':
      ops = {
        type: 'line',
        x1: numAttr(a, 'x1', 0),
        y1: numAttr(a, 'y1', 0),
        x2: numAttr(a, 'x2', 0),
        y2: numAttr(a, 'y2', 0),
      } as ShapeOps;
      break;
    case 'polyline':
    case 'polygon': {
      const points = a.points;
      if (points === undefined || points.trim() === '') return null;
      ops = { type: el.tag, points } as ShapeOps;
      break;
    }
    default:
      return null;
  }
  const array = SVGPathCommander.shapeToPathArray(ops);
  if (array === false) return null;
  return SVGPathCommander.pathToString(array);
}

/**
 * Read SVG markup and return every drawable shape with its resolved paint and
 * accumulated transform. Fill and stroke are inherited down the tree the way
 * SVG paints them: the initial fill is black, so an element that never sets a
 * fill is filled, while fill="none" on an ancestor turns off fill for its
 * subtree (Lucide and Tabler icons, which are stroke only). Throws only when
 * the markup contains no SVG element at all; a document with no drawable shape
 * simply returns an empty list.
 */
export function readSvgShapes(markup: string): ResolvedShape[] {
  const svg = parseSvg(markup);
  const shapes: ResolvedShape[] = [];

  const walk = (el: SvgElement, ctx: PaintContext): void => {
    const style = el.attrs.style ? parseStyle(el.attrs.style) : {};
    const fill = paintProperty(el.attrs, style, 'fill') ?? ctx.fill;
    const stroke = paintProperty(el.attrs, style, 'stroke') ?? ctx.stroke;
    const strokeWidth = paintProperty(el.attrs, style, 'stroke-width') ?? ctx.strokeWidth;
    const fillRule = paintProperty(el.attrs, style, 'fill-rule') ?? ctx.fillRule;
    const transform = el.attrs.transform ? parseTransform(el.attrs.transform) : IDENTITY;
    const next: PaintContext = {
      fill,
      stroke,
      strokeWidth,
      fillRule,
      matrix: multiply(ctx.matrix, transform),
    };

    if (DRAWABLE_TAGS.has(el.tag)) {
      const d = el.tag === 'path' ? el.attrs.d : primitiveToPathData(el);
      if (d !== undefined && d !== null && d.trim() !== '') {
        const hasFill = fill !== 'none';
        const parsedWidth = parseFloat(strokeWidth);
        const width = Number.isFinite(parsedWidth) ? parsedWidth : 1;
        const hasStroke = stroke !== 'none' && width > 0;
        if (hasFill || hasStroke) {
          shapes.push({
            d,
            matrix: next.matrix,
            hasFill,
            fillRule: fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero',
            strokeWidth: hasStroke ? width : null,
          });
        }
      }
    }

    for (const child of el.children) walk(child, next);
  };

  walk(svg, {
    fill: 'black',
    stroke: 'none',
    strokeWidth: '1',
    fillRule: 'nonzero',
    matrix: IDENTITY,
  });
  return shapes;
}
