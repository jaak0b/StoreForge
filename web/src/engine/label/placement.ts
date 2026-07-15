import type { Font } from 'opentype.js';
import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { textToPolygons } from './textToPolygons';
import { svgPathToPolygons } from './svgPath';
import type { LabelIcon } from './icons';
import { extrudeLabel } from './extrude';
import type { LabelFillRule } from './extrude';
import {
  HEIGHT_UNIT,
  OUTER_CORNER_RADIUS,
  PITCH,
  WALL_THICKNESS,
} from '../gridfinity/constants';
import { roundedRectPolygon } from '../gridfinity/binGenerator';
import type { BinParams } from '../gridfinity/types';

/**
 * Label-shelf placement. A flat plate spans the top front edge of the bin
 * interior, its top face flush with the nominal bin top (below the stacking
 * lip), and the label (icon left, text right) is embossed on that face so it
 * reads from above when the bin sits in a drawer. Structured as one placement
 * flavour so another placement can be added as a sibling module later.
 */

/**
 * How deep the shelf reaches into the bin from the interior front wall, in
 * millimetres. This matches the common flat label-shelf designs in the
 * Gridfinity ecosystem; kennetek/gridfinity-rebuilt-openscad's label tab is a
 * different, angled design (15.85 mm deep at a 36-degree support angle), so
 * its figure is not applicable here.
 */
export const SHELF_DEPTH = 12;

/** Thickness of the flat shelf plate, matching the bin wall thickness. */
export const SHELF_THICKNESS = WALL_THICKNESS;

/** How far the embossed label stands proud of the shelf top face. */
export const EMBOSS_HEIGHT = 0.6;

/** How far the label extends into the shelf so the two solids are welded. */
export const EMBOSS_WELD_DEPTH = 0.4;

/** Cap height of the label text at full size, in millimetres. */
export const LABEL_TEXT_HEIGHT = 6;

/** Clear margin kept between the label and the interior side walls. */
export const LABEL_MARGIN = 3;

/** Clear margin kept between the label and the shelf's front and back edges. */
export const SHELF_DEPTH_MARGIN = 1.5;

/** Horizontal gap between the icon and the text when both are present. */
export const ICON_TEXT_GAP = 2;

/** What to put on the label. Empty text with no icon means no label. */
export interface LabelSpec {
  text: string;
  icon: LabelIcon | null;
}

/** True when the spec would produce a label (and therefore needs a shelf). */
export function specHasLabel(spec: LabelSpec): boolean {
  return spec.text.trim().length > 0 || spec.icon !== null;
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
 * not fit the available width or depth. The result is centred on the origin.
 */
export function layoutLabelFace(
  font: Font,
  spec: LabelSpec,
  availableWidthMm: number,
  availableDepthMm: number,
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

  // Shrink to fit the available width and depth, then centre on the origin.
  const all = parts.flatMap((part) => part.polygons);
  const box = boundsOf(all);
  const fit = Math.min(
    1,
    availableWidthMm / (box.maxX - box.minX),
    availableDepthMm / (box.maxY - box.minY),
  );
  const cx = ((box.minX + box.maxX) / 2) * fit;
  const cy = ((box.minY + box.maxY) / 2) * fit;
  return parts.map((part) => ({
    polygons: transform(part.polygons, fit, -cx, -cy, false),
    fillRule: part.fillRule,
  }));
}

/**
 * Build the label shelf: a flat plate along the interior front wall, full
 * interior width, SHELF_DEPTH deep, its top face flush with the nominal bin
 * top, with a 45-degree support chamfer running from the plate's inner bottom
 * edge down to the front wall so it prints without supports. The profile
 * reaches into the front wall so unioning it with the bin body welds them,
 * and the prism is clipped to the bin's rounded outer outline so it also
 * welds to the side walls without protruding outside the bin.
 */
export function buildLabelShelf(m: ManifoldToplevel, params: BinParams): Manifold {
  const outerWidth = params.gridX * PITCH - 0.5;
  const outerDepth = params.gridY * PITCH - 0.5;
  const bodyTop = params.heightUnits * HEIGHT_UNIT;

  const yOuter = -outerDepth / 2;
  const yInner = yOuter + WALL_THICKNESS;
  const yBack = yInner + SHELF_DEPTH;
  const plateBottom = bodyTop - SHELF_THICKNESS;
  const chamferBottom = plateBottom - SHELF_DEPTH;

  // Shelf profile in the (y, z) plane: flat plate on top, 45-degree chamfer
  // underneath from the plate's inner bottom edge to the interior wall face.
  const profile: SimplePolygon = [
    [yOuter, bodyTop],
    [yBack, bodyTop],
    [yBack, plateBottom],
    [yInner, chamferBottom],
    [yOuter, chamferBottom],
  ];
  const section = new m.CrossSection([profile], 'NonZero');
  let prism: Manifold;
  try {
    // Extrude along +Z, then permute axes (x, y, z) -> (z, x, y) so the
    // profile lands in the (y, z) plane with the extrusion running along X.
    prism = section
      .extrude(outerWidth)
      .rotate(90, 0, 90)
      .translate(-outerWidth / 2, 0, 0);
  } finally {
    section.delete();
  }

  // Clip to the bin's rounded outer outline so the shelf's front corners
  // follow the corner radius instead of poking outside the bin.
  const outline = m.Manifold.extrude(
    [roundedRectPolygon(outerWidth, outerDepth, OUTER_CORNER_RADIUS)],
    bodyTop,
  );
  const shelf = m.Manifold.intersection(prism, outline);
  prism.delete();
  outline.delete();
  if (shelf.status() !== 'NoError') {
    throw new Error(`Label shelf construction produced an invalid solid: ${shelf.status()}`);
  }
  return shelf;
}

/**
 * Build the label solid embossed on the shelf's top face. The face lies flat
 * (readable from above, right-side-up when viewed from the bin front), stands
 * EMBOSS_HEIGHT proud of the shelf and reaches EMBOSS_WELD_DEPTH into it, so
 * unioning it with the bin body welds them. Returns null when the spec is
 * empty.
 */
export function buildLabelManifold(
  m: ManifoldToplevel,
  font: Font,
  params: BinParams,
  spec: LabelSpec,
): Manifold | null {
  if (!specHasLabel(spec)) return null;

  const outerWidth = params.gridX * PITCH - 0.5;
  const outerDepth = params.gridY * PITCH - 0.5;
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const interiorWidth = outerWidth - 2 * WALL_THICKNESS;

  const parts = layoutLabelFace(
    font,
    spec,
    interiorWidth - 2 * LABEL_MARGIN,
    SHELF_DEPTH - 2 * SHELF_DEPTH_MARGIN,
  );
  const depth = EMBOSS_HEIGHT + EMBOSS_WELD_DEPTH;
  const solids = parts.map((part) => extrudeLabel(m, part.polygons, depth, part.fillRule));
  const flat = solids.length === 1 ? solids[0] : m.Manifold.union(solids);
  if (solids.length > 1) {
    for (const solid of solids) solid.delete();
  }
  // The face is extruded along +Z and already reads correctly from the bin
  // front (baseline parallel to the front wall); move it onto the middle of
  // the shelf, sunk EMBOSS_WELD_DEPTH into the plate.
  const shelfCentreY = -outerDepth / 2 + WALL_THICKNESS + SHELF_DEPTH / 2;
  const label = flat.translate(0, shelfCentreY, bodyTop - EMBOSS_WELD_DEPTH);
  flat.delete();
  if (label.status() !== 'NoError') {
    throw new Error(`Label placement produced an invalid solid: ${label.status()}`);
  }
  return label;
}
