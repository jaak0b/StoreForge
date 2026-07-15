import type { Font } from 'opentype.js';
import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { textToPolygons } from './textToPolygons';
import { svgPathToPolygons } from './svgPath';
import type { LabelIcon } from './icons';
import { extrudeLabel } from './extrude';
import type { LabelFillRule } from './extrude';
import {
  FOOT_HEIGHT,
  HEIGHT_UNIT,
  PITCH,
} from '../gridfinity/constants';
import type { BinParams } from '../gridfinity/types';

/**
 * Front-wall emboss placement. The label (icon left, text right) is raised
 * off the front outer wall and vertically centred on the wall band between
 * the top of the feet and the top of the walls. Structured as one placement
 * flavour so a label-shelf placement can be added as a sibling module later.
 */

/** How far the embossed label stands proud of the outer wall, in millimetres. */
export const EMBOSS_HEIGHT = 0.6;

/** How far the label extends into the wall so the two solids are welded. */
export const EMBOSS_WELD_DEPTH = 0.4;

/** Cap height of the label text at full size, in millimetres. */
export const LABEL_TEXT_HEIGHT = 6;

/** Clear margin kept between the label and the bin's vertical edges. */
export const LABEL_MARGIN = 3;

/** Horizontal gap between the icon and the text when both are present. */
export const ICON_TEXT_GAP = 2;

/** What to put on the label. Empty text with no icon means no label. */
export interface LabelSpec {
  text: string;
  icon: LabelIcon | null;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function boundsOf(polygons: SimplePolygon[]): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of polygons) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) {
    throw new Error('There are no points to measure.');
  }
  return { minX, maxX, minY, maxY };
}

function transform(
  polygons: SimplePolygon[],
  scale: number,
  dx: number,
  dy: number,
  flipY: boolean,
): SimplePolygon[] {
  const sy = flipY ? -scale : scale;
  return polygons.map((contour) =>
    contour.map(([x, y]) => [x * scale + dx, y * sy + dy] as [number, number]),
  );
}

/**
 * One laid-out piece of the label face with the fill rule its contours are
 * designed for: icons use even-odd, font outlines use non-zero (glyphs may
 * legitimately be drawn from overlapping contours).
 */
export interface LabelFacePart {
  polygons: SimplePolygon[];
  fillRule: LabelFillRule;
}

/**
 * Lay out the label face in 2D: icon to the left of the text, both sharing
 * the LABEL_TEXT_HEIGHT nominal height, uniformly shrunk when the row would
 * not fit the available width. The result is centred on the origin.
 */
export function layoutLabelFace(
  font: Font,
  spec: LabelSpec,
  availableWidthMm: number,
): LabelFacePart[] {
  const text = spec.text.trim();
  const parts: LabelFacePart[] = [];

  if (spec.icon) {
    const raw = svgPathToPolygons(spec.icon.path);
    const box = boundsOf(raw);
    const scale = LABEL_TEXT_HEIGHT / (box.maxY - box.minY);
    // SVG is y down; flip so the icon is upright, and rest it on y = 0 like
    // the text baseline, spanning y = 0 to LABEL_TEXT_HEIGHT.
    parts.push({
      polygons: transform(raw, scale, -box.minX * scale, box.maxY * scale, true),
      fillRule: 'EvenOdd',
    });
  }
  if (text.length > 0) {
    const polygons = textToPolygons(font, text, LABEL_TEXT_HEIGHT);
    const box = boundsOf(polygons);
    parts.push({
      polygons: transform(polygons, 1, -box.minX, 0, false),
      fillRule: 'NonZero',
    });
  }
  if (parts.length === 0) {
    throw new Error('A label needs text, an icon, or both.');
  }

  // Place the parts side by side, icon first.
  let cursor = 0;
  for (const part of parts) {
    const box = boundsOf(part.polygons);
    part.polygons = transform(part.polygons, 1, cursor, 0, false);
    cursor += box.maxX - box.minX + ICON_TEXT_GAP;
  }

  // Shrink to fit the available width, then centre on the origin.
  const all = parts.flatMap((part) => part.polygons);
  const box = boundsOf(all);
  const fit =
    box.maxX - box.minX > availableWidthMm ? availableWidthMm / (box.maxX - box.minX) : 1;
  const cx = ((box.minX + box.maxX) / 2) * fit;
  const cy = ((box.minY + box.maxY) / 2) * fit;
  return parts.map((part) => ({
    polygons: transform(part.polygons, fit, -cx, -cy, false),
    fillRule: part.fillRule,
  }));
}

/**
 * Build the label solid embossed on the bin's front outer wall (the wall
 * facing -Y). The solid stands EMBOSS_HEIGHT proud of the wall and reaches
 * EMBOSS_WELD_DEPTH into it, so unioning it with the bin body welds them.
 * Returns null when the spec is empty.
 */
export function buildLabelManifold(
  m: ManifoldToplevel,
  font: Font,
  params: BinParams,
  spec: LabelSpec,
): Manifold | null {
  if (spec.text.trim().length === 0 && !spec.icon) return null;

  const outerWidth = params.gridX * PITCH - 0.5;
  const outerDepth = params.gridY * PITCH - 0.5;
  const bodyTop = params.heightUnits * HEIGHT_UNIT;

  const parts = layoutLabelFace(font, spec, outerWidth - 2 * LABEL_MARGIN);
  const depth = EMBOSS_HEIGHT + EMBOSS_WELD_DEPTH;
  const solids = parts.map((part) => extrudeLabel(m, part.polygons, depth, part.fillRule));
  const flat = solids.length === 1 ? solids[0] : m.Manifold.union(solids);
  if (solids.length > 1) {
    for (const solid of solids) solid.delete();
  }
  // The face is extruded along +Z; rotate it upright against the front wall
  // (extrusion pointing along -Y) and centre it vertically on the wall band
  // between the top of the feet and the top of the walls.
  const wallCentreZ = (FOOT_HEIGHT + bodyTop) / 2;
  const label = flat
    .rotate(90, 0, 0)
    .translate(0, -outerDepth / 2 + EMBOSS_WELD_DEPTH, wallCentreZ);
  flat.delete();
  if (label.status() !== 'NoError') {
    throw new Error(`Label placement produced an invalid solid: ${label.status()}`);
  }
  return label;
}
