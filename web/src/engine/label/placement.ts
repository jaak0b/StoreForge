import type { Font } from 'opentype.js';
import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { textToPolygons } from './textToPolygons';
import { svgPathToPolygons } from './svgPath';
import type { LabelIcon } from './icons';
import type { LabelFillRule } from './extrude';
import {
  binInteriorSizeMm,
  binOuterSizeMm,
  FLOOR_TOP,
  HEIGHT_UNIT,
  OUTER_CORNER_RADIUS,
  PITCH,
  WALL_THICKNESS,
} from '../gridfinity/constants';
import { prismFromProfile, roundedRectPolygon } from '../gridfinity/binGenerator';
import type { BinParams } from '../gridfinity/types';

/**
 * Label face layout and the shared shelf structure. The label face (icon
 * left, text right) is laid out here and inlaid into the swappable label
 * insert (see ./slot.ts); the plate-and-ribs shelf structure below carries
 * the insert channel floor along the bin's interior front wall.
 */

/**
 * Thickness of the flat shelf plate. Measured from the Pred reference bin
 * (printables.com/model/592545, 1x1x6 mesh): channel floor at z 36.25 with
 * the plate underside at z 35.25, a 1.0 mm plate.
 */
export const SHELF_THICKNESS = 1.0;

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
export function boldenText(m: ManifoldToplevel, part: LabelFacePart): LabelFacePart {
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
 * Thickness of one shelf support rib. Measured from the Pred reference bin
 * (1x1x6 mesh, plan section at y 33): rib slabs span x 9.962..10.762,
 * 20.475..21.275 and 30.987..31.788, each 0.8 mm thick.
 */
export const RIB_THICKNESS = 0.8;

/**
 * Centre-to-centre spacing of the shelf support ribs: a quarter of the grid
 * pitch. Measured from the Pred reference bin (1x1x6 mesh): rib centres
 * 10.51 mm apart, three ribs across the one-cell interior.
 */
export const RIB_PITCH = PITCH / 4;

/**
 * X centres of the support ribs under a bin spanning `cells` grid cells:
 * every multiple of RIB_PITCH (centred on the bin, like the reference) whose
 * rib lies fully inside the clear interior. The reference 1x1 bin gets three
 * ribs, matching its measured mesh; the plate top bridges the 9.7 mm clear
 * spans between ribs and the slightly wider spans to the side walls.
 */
export function shelfRibCentresMm(cells: number): number[] {
  const interiorHalf = binInteriorSizeMm(cells) / 2;
  const centres: number[] = [];
  const maxIndex = Math.floor((interiorHalf - RIB_THICKNESS / 2) / RIB_PITCH);
  for (let i = -maxIndex; i <= maxIndex; i++) centres.push(i * RIB_PITCH);
  return centres;
}

/**
 * The shared shelf structure carrying the insert channel floor, ported from
 * the measured Pred reference bin (1x1x6 mesh): a SHELF_THICKNESS plate along
 * the interior front wall whose back edge is a 45-degree chamfer rising from
 * the underside at rampStartY (the channel's back edge) to the plate top
 * (measured chamfer from y 27.15 at the underside to y 26.15 at the floor
 * level, against the end stop's back at 26.25), resting on RIB_PITCH-spaced
 * triangular ribs: each rib runs a 45-degree hypotenuse from the plate's
 * underside at rampStartY down to the front wall's interior face (measured
 * from (y 27.15, z 35.25) to the wall face at (40.25, 22.15), exactly 45
 * degrees), so plate and ribs print without supports. On a bin too short for
 * the full hypotenuse the rib is truncated at the interior floor top and
 * rests on the floor plate instead of the wall (the same triangle, clipped by
 * the floor it welds into), so shallow bins stay valid watertight solids.
 * The profiles reach into the front wall (and, when truncated, just into the
 * floor plate) so unioning with the bin body welds them, and the solid is
 * clipped to the bin's rounded outer outline so it also welds to the side
 * walls without protruding outside the bin. The slot shelf (see ./slot.ts)
 * places it one slot height below the nominal bin top as the floor of the
 * insert channel; the fused label's shelf places it at the nominal top at a
 * greater thickness, which is what the trailing thickness parameter is for
 * (the back chamfer stays at 45 degrees whatever the plate thickness, and the
 * ribs start at the plate underside, so they grow with it). The trailing riser
 * parameter puts a short vertical face at the plate's back edge before the
 * chamfer starts: the chamfer then begins riser below the plate top, so a
 * thicker plate keeps the reference bin's inner-end silhouette (a vertical
 * step down to the flat label surface) instead of chamfering straight off the
 * top face. It stays a 45 degree chamfer at any riser, and the ramp foot stays
 * at rampStartY, because the chamfer's run and its drop are both reduced by
 * the riser. Zero (the default) is the plain chamfered plate.
 */
export function buildShelfStructure(
  m: ManifoldToplevel,
  params: BinParams,
  plateTop: number,
  rampStartY: number,
  thickness: number = SHELF_THICKNESS,
  riser: number = 0,
): Manifold {
  const outerWidth = binOuterSizeMm(params.gridX);
  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const eps = 0.01;

  const yOuter = -outerDepth / 2;
  const yInner = yOuter + WALL_THICKNESS;
  const plateBottom = plateTop - thickness;

  // Profiles in the (y, z) plane. The plate carries the measured 45-degree
  // back chamfer under the end stop, preceded by the riser's vertical face;
  // each rib is the measured 45-degree support triangle.
  const chamferBackY = rampStartY + (thickness - riser);
  const plateProfile: SimplePolygon = [
    [yOuter, plateTop],
    [chamferBackY, plateTop],
    // A zero riser would repeat the previous vertex, so it is left out.
    ...(riser > 0 ? ([[chamferBackY, plateTop - riser]] as SimplePolygon) : []),
    [rampStartY, plateBottom],
    [yOuter, plateBottom],
  ];
  // Truncation rule: the rib's 45-degree hypotenuse ends at the front wall's
  // interior face, or at the interior floor top (reaching eps into the floor
  // plate for the weld) when the wall intersection would lie below the floor.
  const ribDrop = Math.min(rampStartY - yInner, plateBottom - (FLOOR_TOP - eps));
  const ribBottom = plateBottom - ribDrop;
  const ribProfile: SimplePolygon = [
    [yOuter, plateBottom],
    [rampStartY, plateBottom],
    [rampStartY - ribDrop, ribBottom],
    [yOuter, ribBottom],
  ];

  const parts: Manifold[] = [
    prismFromProfile(m, plateProfile, outerWidth).translate(-outerWidth / 2, 0, 0),
  ];
  if (ribDrop > 0) {
    for (const centre of shelfRibCentresMm(params.gridX)) {
      parts.push(
        prismFromProfile(m, ribProfile, RIB_THICKNESS).translate(centre - RIB_THICKNESS / 2, 0, 0),
      );
    }
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

