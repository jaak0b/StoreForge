import type { Font } from 'opentype.js';
import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { textToPolygons } from './textToPolygons';
import { svgPathToPolygons } from './svgPath';
import type { LabelIcon } from './icons';
import { extrudeLabel } from './extrude';
import type { LabelFillRule } from './extrude';
import {
  binInteriorSizeMm,
  binOuterSizeMm,
  HEIGHT_UNIT,
  OUTER_CORNER_RADIUS,
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

/** Cap height of the second text line relative to the first. */
export const LABEL_LINE2_SCALE = 0.6;

/** Vertical gap between the first and second text line, in millimetres. */
export const LABEL_LINE_GAP = 1;

/**
 * How far text outlines are dilated (per side, in millimetres) before
 * extrusion. Roboto Medium at LABEL_TEXT_HEIGHT (6 mm cap height) has stems
 * around 0.55 mm wide, under one 0.4 mm nozzle extrusion width, so slicers
 * render the embossed strokes as thin, barely-visible perimeters. Offsetting
 * by 0.15 mm per side brings those stems to roughly 0.85 mm, about two
 * extrusion widths, so the text slices as solid, legible strokes. Icons are
 * already bold silhouettes and are left alone. Applied after the label is
 * scaled to its final on-shelf size, so the dilation is always a true 0.15 mm
 * regardless of any scale-to-fit shrink.
 */
export const TEXT_BOLD_OFFSET = 0.15;

/** What to put on the label. Empty text with no icon means no label. */
export interface LabelSpec {
  text: string;
  /** Optional smaller second line rendered under the first. */
  text2?: string;
  icon: LabelIcon | null;
}

/** True when the spec would produce a label (and therefore needs a shelf). */
export function specHasLabel(spec: LabelSpec): boolean {
  return (
    spec.text.trim().length > 0 ||
    (spec.text2 ?? '').trim().length > 0 ||
    spec.icon !== null
  );
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
  /** True for font-outline parts (text), false for icon parts. */
  isText: boolean;
}

/**
 * Lay out the label face in 2D: icon to the left of the text, both sharing
 * the LABEL_TEXT_HEIGHT nominal height, with the optional second text line
 * placed under the first at LABEL_LINE2_SCALE of its cap height. The whole
 * face is uniformly shrunk when it would not fit the available width or
 * depth, and the result is centred on the origin.
 */
export function layoutLabelFace(
  font: Font,
  spec: LabelSpec,
  availableWidthMm: number,
  availableDepthMm: number,
): LabelFacePart[] {
  const text = spec.text.trim();
  const text2 = (spec.text2 ?? '').trim();
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
      isText: false,
    });
  }
  if (text.length > 0) {
    const polygons = textToPolygons(font, text, LABEL_TEXT_HEIGHT);
    const box = boundsOf(polygons);
    parts.push({
      polygons: transform(polygons, 1, -box.minX, 0, false),
      fillRule: 'NonZero',
      isText: true,
    });
  }
  if (parts.length === 0 && text2.length === 0) {
    throw new Error('A label needs text, an icon, or both.');
  }

  // Place the first-line parts side by side, icon first.
  let cursor = 0;
  for (const part of parts) {
    const box = boundsOf(part.polygons);
    part.polygons = transform(part.polygons, 1, cursor, 0, false);
    cursor += box.maxX - box.minX + ICON_TEXT_GAP;
  }

  // The second line sits under the first at a reduced cap height, left
  // aligned with the row, separated by LABEL_LINE_GAP.
  if (text2.length > 0) {
    const polygons = textToPolygons(font, text2, LABEL_TEXT_HEIGHT * LABEL_LINE2_SCALE);
    const box = boundsOf(polygons);
    const rowBottom =
      parts.length > 0 ? boundsOf(parts.flatMap((part) => part.polygons)).minY : 0;
    parts.push({
      polygons: transform(polygons, 1, -box.minX, rowBottom - LABEL_LINE_GAP - box.maxY, false),
      fillRule: 'NonZero',
      isText: true,
    });
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
    isText: part.isText,
  }));
}

/**
 * Dilate a text part's outlines by TEXT_BOLD_OFFSET per side so thin glyph
 * stems slice as solid strokes. Must run after the label has been scaled to
 * its final on-shelf size (see layoutLabelFace's scale-to-fit) so the
 * dilation is a true millimetre figure, not one shrunk along with the text.
 * Offsetting can merge glyphs that already nearly touch; this is accepted as
 * a minor consequence of the same fix (see TEXT_BOLD_OFFSET's doc comment).
 */
function boldenText(m: ManifoldToplevel, part: LabelFacePart): LabelFacePart {
  if (!part.isText) return part;
  const section = new m.CrossSection(part.polygons, part.fillRule);
  try {
    const offsetSection = section.offset(TEXT_BOLD_OFFSET, 'Round');
    try {
      return { polygons: offsetSection.toPolygons(), fillRule: part.fillRule, isText: true };
    } finally {
      offsetSection.delete();
    }
  } finally {
    section.delete();
  }
}

/**
 * Widest unsupported gap allowed between two shelf ribs, in millimetres. The
 * plate's top face is a flat bridge between rib tops; 16 mm is a short,
 * reliable bridging distance for any common filament.
 */
export const RIB_MAX_CLEAR_SPAN = 16;

/** Thickness of one shelf support rib, matching the bin wall thickness. */
export const RIB_THICKNESS = WALL_THICKNESS;

/**
 * Number of support ribs under a shelf plate spanning the given width: the
 * smallest count that keeps every clear gap between neighbouring ribs at or
 * under RIB_MAX_CLEAR_SPAN, with one rib flush against each end. Solving
 * (width - n * t) / (n - 1) <= span for the rib count n.
 */
export function shelfRibCount(spanWidth: number): number {
  return Math.max(
    2,
    Math.ceil((spanWidth + RIB_MAX_CLEAR_SPAN) / (RIB_MAX_CLEAR_SPAN + RIB_THICKNESS)),
  );
}

/**
 * Build the label shelf: a flat plate along the interior front wall, full
 * interior width, SHELF_DEPTH deep, its top face flush with the nominal bin
 * top. Instead of a solid support wedge under the full plate, the plate rests
 * on evenly spaced triangular gussets (our own design, not taken from any
 * reference implementation): each rib keeps the 45-degree profile from the
 * plate's inner bottom edge down to the front wall, so ribs and plate still
 * print without supports, and the plate top bridges the short spans between
 * ribs. A rib sits flush at each end so the plate is anchored at the side
 * walls. The profile reaches into the front wall so unioning it with the bin
 * body welds them, and the solid is clipped to the bin's rounded outer
 * outline so it also welds to the side walls without protruding outside the
 * bin.
 */
export function buildLabelShelf(m: ManifoldToplevel, params: BinParams): Manifold {
  const outerWidth = binOuterSizeMm(params.gridX);
  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;

  const yOuter = -outerDepth / 2;
  const yInner = yOuter + WALL_THICKNESS;
  const yBack = yInner + SHELF_DEPTH;
  const plateBottom = bodyTop - SHELF_THICKNESS;
  const chamferBottom = plateBottom - SHELF_DEPTH;

  // Profiles in the (y, z) plane. The plate is the solid label surface; each
  // rib is the 45-degree support triangle that used to run the full width.
  const plateProfile: SimplePolygon = [
    [yOuter, bodyTop],
    [yBack, bodyTop],
    [yBack, plateBottom],
    [yOuter, plateBottom],
  ];
  const ribProfile: SimplePolygon = [
    [yOuter, plateBottom],
    [yBack, plateBottom],
    [yInner, chamferBottom],
    [yOuter, chamferBottom],
  ];

  // Extrude along +Z, then permute axes (x, y, z) -> (z, x, y) so the
  // profile lands in the (y, z) plane with the extrusion running along X.
  const prismFromProfile = (profile: SimplePolygon, width: number): Manifold => {
    const section = new m.CrossSection([profile], 'NonZero');
    try {
      return section.extrude(width).rotate(90, 0, 90);
    } finally {
      section.delete();
    }
  };

  const parts: Manifold[] = [
    prismFromProfile(plateProfile, outerWidth).translate(-outerWidth / 2, 0, 0),
  ];
  const ribCount = shelfRibCount(outerWidth);
  const ribStep = (outerWidth - RIB_THICKNESS) / (ribCount - 1);
  for (let i = 0; i < ribCount; i++) {
    parts.push(
      prismFromProfile(ribProfile, RIB_THICKNESS).translate(
        -outerWidth / 2 + i * ribStep,
        0,
        0,
      ),
    );
  }
  const prism = m.Manifold.union(parts);
  for (const part of parts) part.delete();

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

  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const interiorWidth = binInteriorSizeMm(params.gridX);

  // Reserve TEXT_BOLD_OFFSET on every side of the fit box: boldenText grows
  // text outlines by that much after layout, so shrinking the target here
  // keeps the bolded result within LABEL_MARGIN / SHELF_DEPTH_MARGIN.
  const parts = layoutLabelFace(
    font,
    spec,
    interiorWidth - 2 * LABEL_MARGIN - 2 * TEXT_BOLD_OFFSET,
    SHELF_DEPTH - 2 * SHELF_DEPTH_MARGIN - 2 * TEXT_BOLD_OFFSET,
  ).map((part) => boldenText(m, part));
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
