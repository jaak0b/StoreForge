import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import type { Font } from 'opentype.js';
import {
  binOuterSizeMm,
  HEIGHT_UNIT,
  LIP_DEPTH,
  OUTER_CORNER_RADIUS,
} from '../gridfinity/constants';
import { buildOuterEnvelope, prismFromProfile, roundedRectPolygon } from '../gridfinity/binGenerator';
import type { BinParams } from '../gridfinity/types';
import { extrudeLabel } from './extrude';
import {
  boldenText,
  buildShelfStructure,
  LABEL_MARGIN,
  layoutLabelFace,
  SHELF_DEPTH_MARGIN,
  SHELF_THICKNESS,
  specHasLabel,
} from './placement';
import type { LabelSpec } from './placement';

/**
 * Swappable label inserts and the bin slot that holds them. The geometry is
 * dimensioned to interchange with the Printables model "Gridfinity bin with
 * printable label by Pred" (printables.com/model/592545): all figures below
 * were measured from that model's published meshes (label 3MF/STEP files and
 * the 1x1x6 bin), so an insert printed from here fits a Pred bin and a Pred
 * insert fits a bin from here. The insert is a thin plate with a short tab
 * at each end; the bin's channel has a matching enclosed pocket at each end
 * whose ceiling holds the tabs down. The insert flexes in (the plate is 0.8
 * mm thin) and is pushed out again through the tab's through-hole. Two
 * clearance-increasing simplifications against the reference model are
 * deliberate and do not affect the fit: the 0.2 mm edge round-over on the
 * insert faces is omitted, and the channel's 1.15 mm plan corner fillets are
 * left square (both only remove material from mating clearances).
 */

/** Thickness of the label insert plate. */
export const INSERT_THICKNESS = 0.8;

/** Depth (front to back) of the label insert plate. */
export const INSERT_DEPTH = 11.5;

/** Plan corner radius of the label insert plate. Measured 0.9. */
export const INSERT_CORNER_RADIUS = 0.9;

/**
 * How much shorter the insert (including its tabs) is than the bin's outer
 * width (1.85 mm per side): a one-cell insert is 37.8 mm long overall on the
 * 41.5 mm bin.
 */
export const INSERT_END_INSET = 3.7;

/**
 * The retention tab at each end of the insert: a full-thickness rectangular
 * ear protruding INSERT_TAB_LENGTH beyond the plate, INSERT_TAB_WIDTH wide,
 * centred on the plate's centreline, with square plan corners. Measured
 * 1.0 x 5.7 on the reference insert (37.8 total = 35.8 plate + 1.0 per end).
 */
export const INSERT_TAB_LENGTH = 1.0;
export const INSERT_TAB_WIDTH = 5.7;

/**
 * The push-out through-hole in each tab: 1.5 mm diameter, its centre 1.5 mm
 * from the tab tip on the centreline. It lies under the open span of the
 * channel, so a pin pushed through it lifts the insert out.
 */
export const INSERT_HOLE_DIAMETER = 1.5;
export const INSERT_HOLE_FROM_TIP = 1.5;

/** Depth (front to back) of the insert channel; 0.5 mm clearance over the insert. */
export const SLOT_DEPTH = 12.0;

/** Height of the insert channel; 0.2 mm clearance over the insert thickness. */
export const SLOT_HEIGHT = 1.0;

/** Total side clearance of the channel cavity over the insert length. */
export const SLOT_SIDE_CLEARANCE = 0.5;

/**
 * The end stop along the channel's back edge: a ridge rising from the
 * channel floor to the nominal bin top that keeps the insert from sliding
 * into the bin interior.
 */
export const RETAINER_BASE_DEPTH = 0.9;

/**
 * The enclosed tab pocket at each end of the channel: as deep as the tab is
 * long (the cavity keeps 0.25 mm end clearance overall), TAB_POCKET_WIDTH
 * wide (0.5 mm clearance per side over the tab), full channel height.
 * Measured 1.0 deep x 6.7 wide x 1.0 high on the reference bin (pocket void
 * x 1.85..2.85, y 29.8..36.5, z 36.25..37.25 on the 1x1x6 mesh). The pockets
 * sit entirely inside the side walls' thick lip support band (the pocket's
 * inner face is flush with the band's inner face), so the band material above
 * the nominal top forms the retaining ceiling by itself: a lifted insert hits
 * it with its tabs. No extra material is added, exactly as in the reference
 * bin, whose measured 0.65 mm of ceiling at the pocket midline is the lip
 * seat's 45 degree taper overhead.
 */
export const TAB_POCKET_WIDTH = 6.7;

/**
 * How far the channel's front edge sits behind the bin's outer front face:
 * the lip's protrusion LIP_DEPTH (2.6). The reference bin's channel front
 * edge, measured at y 39.15 on its 41.75 mm face (x = 21 cross-section of the
 * 1x1x6 mesh), is exactly flush with the lip's inner support face, so the
 * full self-supporting lip profile runs unmodified across the front and
 * nothing overhangs the channel. The single home for this figure.
 */
export const SLOT_FRONT_INSET = LIP_DEPTH;

/**
 * The insert's label relief: the plate keeps its full constant thickness
 * (so every insert sits identically in the slot), and the label face stands
 * proud of the plate top by exactly the channel's vertical clearance,
 * SLOT_HEIGHT minus INSERT_THICKNESS (0.2 mm). The text is physical relief,
 * so it stays readable on a single-color print, and a filament swap paused
 * at the plate top height colors exactly the raised text in the second
 * color. The raised top ends flush with the nominal bin top, the plane a
 * stacked bin's foot rests on, so the text cannot rise any higher; unlike
 * the reference insert (which recesses the field instead) the text touches
 * that plane with zero clearance. The plate itself is unchanged, so
 * interchange with the reference bins is unaffected.
 */
export const INSERT_TEXT_RAISE = SLOT_HEIGHT - INSERT_THICKNESS;

/** How far the label face reaches below the plate top so the two solids are welded. */
export const INSERT_TEXT_WELD = 0.05;

/** Overall length of the label insert (tabs included) for a bin spanning `cells` grid cells. */
export function insertLengthMm(cells: number): number {
  return binOuterSizeMm(cells) - INSERT_END_INSET;
}

/** Full width of the channel cavity (tab pockets included) for a bin spanning `cells` grid cells. */
export function slotChannelWidthMm(cells: number): number {
  return insertLengthMm(cells) + SLOT_SIDE_CLEARANCE;
}

/** Width of the open channel span between the two tab pockets. */
export function slotOpenSpanMm(cells: number): number {
  return slotChannelWidthMm(cells) - 2 * INSERT_TAB_LENGTH;
}

/**
 * How far the whole slot structure reaches into the bin from the outer front
 * face, in plan: past the channel lies the deeper of the end stop's base
 * (RETAINER_BASE_DEPTH) and the shelf plate's 45-degree back chamfer, which
 * ends one plate thickness behind the channel's back edge (measured chamfer
 * top at y 26.15 against the stop base's back at 26.25 on the reference
 * 1x1x6 mesh). Below the plate the support ribs only recede back toward the
 * front wall (their 45-degree hypotenuses run down and forward), so this
 * top-of-shelf figure is the structure's widest plan reach at every depth.
 * The single home for the figure; pocket validation keeps tool pockets clear
 * of this whole strip.
 */
export const SLOT_REACH_DEPTH =
  SLOT_FRONT_INSET + SLOT_DEPTH + Math.max(RETAINER_BASE_DEPTH, SHELF_THICKNESS);

/**
 * Where an insert generated by buildInsertSolids (resting on z = 0, centred
 * on the origin) sits inside the bin's slot: centred in the channel, resting
 * on the channel floor.
 */
export function insertPositionInBin(params: BinParams): {
  x: number;
  y: number;
  z: number;
} {
  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  return {
    x: 0,
    y: -outerDepth / 2 + SLOT_FRONT_INSET + SLOT_DEPTH / 2,
    z: bodyTop - SLOT_HEIGHT,
  };
}

/** The two tab-pocket void boxes of the channel, at the given channel frame. */
function tabPocketVoids(
  m: ManifoldToplevel,
  params: BinParams,
  floorTop: number,
  topZ: number,
): Manifold[] {
  const outerDepth = binOuterSizeMm(params.gridY);
  const yFront = -outerDepth / 2 + SLOT_FRONT_INSET;
  const channelCentreY = yFront + SLOT_DEPTH / 2;
  const openHalf = slotOpenSpanMm(params.gridX) / 2;
  const cavityHalf = slotChannelWidthMm(params.gridX) / 2;
  const voids: Manifold[] = [];
  for (const side of [-1, 1]) {
    voids.push(
      m.Manifold.cube([cavityHalf - openHalf, TAB_POCKET_WIDTH, topZ - floorTop]).translate(
        side === -1 ? -cavityHalf : openHalf,
        channelCentreY - TAB_POCKET_WIDTH / 2,
        floorTop,
      ),
    );
  }
  return voids;
}

/**
 * The slot shelf: the shared plate-and-ribs shelf structure with its top face
 * one channel height below the nominal bin top (forming the channel floor,
 * extended under the end stop), plus the end stop along the channel's back
 * edge. That is all the shelf adds: the channel sits flush behind the lip's
 * inner support face (SLOT_FRONT_INSET), so the side walls' lip band already
 * surrounds the tab pockets and forms their ceilings, exactly as in the
 * reference bin. Unioned with the bin body; the channel itself is the open
 * space above the plate.
 */
export function buildSlotShelf(m: ManifoldToplevel, params: BinParams): Manifold {
  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const floorTop = bodyTop - SLOT_HEIGHT;
  const cavityWidth = slotChannelWidthMm(params.gridX);

  const yOuter = -outerDepth / 2;
  const yFront = yOuter + SLOT_FRONT_INSET;
  const yBack = yFront + SLOT_DEPTH;
  const yStopBack = yBack + RETAINER_BASE_DEPTH;

  const parts: Manifold[] = [
    // The shelf's support ramp starts at the channel's back edge; the plate
    // itself reaches one plate thickness further through its measured back
    // chamfer, passing under (and 0.1 mm beyond) the end stop, exactly as in
    // the reference bin.
    buildShelfStructure(m, params, floorTop, yBack),
  ];

  // End stop along the channel's back edge, spanning the cavity width.
  const stopProfile: SimplePolygon = [
    [yBack, floorTop],
    [yStopBack, floorTop],
    [yStopBack, bodyTop],
    [yBack, bodyTop],
  ];
  parts.push(prismFromProfile(m, stopProfile, cavityWidth).translate(-cavityWidth / 2, 0, 0));

  const prism = m.Manifold.union(parts);
  for (const part of parts) part.delete();

  // Clip to the bin's outer wall envelope, so nothing pokes outside (the
  // shelf plate's front edge gets trimmed to the rim groove, which the
  // reference bin runs continuously through the slot corners).
  const outline = buildOuterEnvelope(m, params);
  const shelf = m.Manifold.intersection(prism, outline);
  prism.delete();
  outline.delete();
  if (shelf.status() !== 'NoError') {
    const status = shelf.status();
    shelf.delete();
    throw new Error(`Slot shelf construction produced an invalid solid: ${status}`);
  }
  return shelf;
}

/**
 * Cutter clearing the insert channel's cavity (the open span plus the two
 * tab pockets), for the bin body before the slot shelf is unioned in and for
 * builders that fill the bin interior solid (the pocket bin): subtracting
 * this and then unioning buildSlotShelf produces the channel. The open span
 * is slightly oversized in height so no film is left over the channel; the
 * pocket voids stop exactly at the nominal bin top, where wall or ceiling
 * material above them stays.
 */
export function slotClearanceCutter(m: ManifoldToplevel, params: BinParams): Manifold {
  const outerWidth = binOuterSizeMm(params.gridX);
  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const floorTop = bodyTop - SLOT_HEIGHT;
  const openSpan = slotOpenSpanMm(params.gridX);
  const yFront = -outerDepth / 2 + SLOT_FRONT_INSET;
  const eps = 0.01;
  const box = m.Manifold.cube([openSpan, SLOT_DEPTH, SLOT_HEIGHT + eps]).translate(
    -openSpan / 2,
    yFront,
    floorTop,
  );
  // The open span's edges are flush with the lip's inner support face, so at
  // the bin's front corners, where that face curves with the outer corner
  // radius, the box would carve into the lip band. Clip it to the band's
  // inner outline instead: the reference bin's channel is bounded by the
  // curved lip face there (measured channel floor edge at y 39.034 in the
  // x = 3.5 cross-section of the 1x1x6 mesh, on the lip face arc, versus
  // 39.15 at mid-span).
  const bandInner = m.Manifold.extrude(
    [
      roundedRectPolygon(
        outerWidth - 2 * LIP_DEPTH,
        outerDepth - 2 * LIP_DEPTH,
        OUTER_CORNER_RADIUS - LIP_DEPTH,
      ),
    ],
    SLOT_HEIGHT + 3 * eps,
  ).translate(0, 0, floorTop - eps);
  const main = m.Manifold.intersection(box, bandInner);
  box.delete();
  bandInner.delete();
  const voids = tabPocketVoids(m, params, floorTop, bodyTop);
  const cutter = m.Manifold.union([main, ...voids]);
  main.delete();
  for (const v of voids) v.delete();
  return cutter;
}

/**
 * Give a bin body its insert slot: the channel space is cut out of the body
 * first (the channel is wider than the interior is at its rounded front
 * corners, so like the reference model it recesses into the side walls), then
 * the slot shelf is unioned in. The single place the cut-then-shelf sequence
 * lives; both the plain bin builder and the pocket bin builder (which re-fills
 * the interior and must restore the channel) call it. Consumes the given body
 * and returns the slotted result.
 */
export function applySlotToBody(
  m: ManifoldToplevel,
  params: BinParams,
  body: Manifold,
): Manifold {
  const clearance = slotClearanceCutter(m, params);
  const cleared = m.Manifold.difference(body, clearance);
  body.delete();
  clearance.delete();
  const shelf = buildSlotShelf(m, params);
  const slotted = m.Manifold.union([cleared, shelf]);
  cleared.delete();
  shelf.delete();
  if (slotted.status() !== 'NoError') {
    const status = slotted.status();
    slotted.delete();
    throw new Error(`Slot construction produced an invalid solid: ${status}`);
  }
  return slotted;
}

/** The two parts of a label insert, kept separate for per-part coloring. */
export interface InsertSolids {
  /** The insert plate, always at its full constant thickness. */
  body: Manifold;
  /** The label face raised above the plate top, or null for a blank insert. */
  label: Manifold | null;
}

/**
 * The insert's flat body: the plate with its end tabs, pierced by the two
 * push-out through-holes, resting on z = 0 and centred on the origin.
 */
function buildInsertPlate(m: ManifoldToplevel, cells: number): Manifold {
  const length = insertLengthMm(cells);
  const plateLength = length - 2 * INSERT_TAB_LENGTH;
  const eps = 0.01;
  const plate = m.Manifold.extrude(
    [roundedRectPolygon(plateLength, INSERT_DEPTH, INSERT_CORNER_RADIUS)],
    INSERT_THICKNESS,
  );
  // Full-thickness tabs with square plan corners, overlapping into the plate
  // by eps so the union is welded.
  const tabs: Manifold[] = [];
  for (const side of [-1, 1]) {
    tabs.push(
      m.Manifold.cube([INSERT_TAB_LENGTH + eps, INSERT_TAB_WIDTH, INSERT_THICKNESS]).translate(
        side === -1 ? -length / 2 : plateLength / 2 - eps,
        -INSERT_TAB_WIDTH / 2,
        0,
      ),
    );
  }
  const solid = m.Manifold.union([plate, ...tabs]);
  plate.delete();
  for (const tab of tabs) tab.delete();
  // The push-out holes, through the full thickness, centred on the
  // centreline INSERT_HOLE_FROM_TIP from each tab tip.
  const holes: Manifold[] = [];
  for (const side of [-1, 1]) {
    holes.push(
      m.Manifold.cylinder(
        INSERT_THICKNESS + 2 * eps,
        INSERT_HOLE_DIAMETER / 2,
        INSERT_HOLE_DIAMETER / 2,
        32,
      ).translate(side * (length / 2 - INSERT_HOLE_FROM_TIP), 0, -eps),
    );
  }
  const holeUnion = m.Manifold.union(holes);
  for (const hole of holes) hole.delete();
  const pierced = m.Manifold.difference(solid, holeUnion);
  solid.delete();
  holeUnion.delete();
  return pierced;
}

/**
 * Build a label insert: a flat plate with end tabs (resting on z = 0,
 * centred on the origin, ready to print) at its full constant thickness,
 * with the label face standing INSERT_TEXT_RAISE proud of the plate top as
 * a separate solid, so it can print in a second filament (by slot on a
 * toolchanger, or by a pause and filament swap at the plate top height on a
 * single-extruder printer). An empty spec yields the same plate with a null
 * label. The caller owns both manifolds.
 */
export function buildInsertSolids(
  m: ManifoldToplevel,
  font: Font,
  spec: LabelSpec,
  cells: number,
): InsertSolids {
  const length = insertLengthMm(cells);
  const body = buildInsertPlate(m, cells);
  if (!specHasLabel(spec)) {
    if (body.status() !== 'NoError') {
      throw new Error(`Insert generation produced an invalid solid: ${body.status()}`);
    }
    return { body, label: null };
  }

  // The label lays out on the plate between the tabs, so it never reaches
  // the tab region or the push-out holes.
  const parts = layoutLabelFace(
    font,
    spec,
    length - 2 * INSERT_TAB_LENGTH - 2 * LABEL_MARGIN,
    INSERT_DEPTH - 2 * SHELF_DEPTH_MARGIN,
  ).map((part) => boldenText(m, part));

  // The face stands on the plate top, reaching INSERT_TEXT_WELD below it so
  // the union with the plate is one welded solid.
  const faceSolids = parts.map((part) =>
    extrudeLabel(m, part.polygons, INSERT_TEXT_RAISE + INSERT_TEXT_WELD, part.fillRule),
  );
  const face = faceSolids.length === 1 ? faceSolids[0] : m.Manifold.union(faceSolids);
  if (faceSolids.length > 1) {
    for (const solid of faceSolids) solid.delete();
  }
  const label = face.translate(0, 0, INSERT_THICKNESS - INSERT_TEXT_WELD);
  face.delete();
  if (body.status() !== 'NoError' || label.status() !== 'NoError') {
    const status = body.status() !== 'NoError' ? body.status() : label.status();
    body.delete();
    label.delete();
    throw new Error(`Insert generation produced an invalid solid: ${status}`);
  }
  return { body, label };
}
