import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import type { Font } from 'opentype.js';
import type {
  BinParams,
  InsertContentParams,
  InsertParams,
  MeshData,
  PartMeshes,
  SlottedBinParams,
} from './types';
import {
  applySlotToBody,
  buildFusedLabel,
  buildFusedShelf,
  buildInsertSolids,
  insertPositionInBin,
} from '../label/slot';
import {
  validateWalls,
  wallEndsOnInteriorBoundary,
  wallLength,
  type BinFootprint,
  type DividerWall,
} from './dividerModel';
import type { LabelSpec } from '../label/placement';
import { findLabelIcon } from '../label/icons';
import {
  BASE_TOP_RADIUS,
  binInteriorSizeMm,
  binOuterSizeMm,
  BASE_WALL_THICKNESS,
  BASE_RIB_THICKNESS,
  BASE_TOP_SIZE,
  CORNER_SEGMENTS,
  DIVIDER_THICKNESS,
  FLOOR_PLATE_THICKNESS,
  FLOOR_TOP,
  FOOT_HEIGHT,
  FOOT_LOWER_CHAMFER,
  FOOT_UPPER_CHAMFER,
  FOOT_VERTICAL,
  HEIGHT_UNIT,
  LIP_CREST_HEIGHT,
  LIP_DEPTH,
  LIP_FILLET_RADIUS,
  LIP_GROOVE_INSET,
  LIP_GROOVE_VERTICAL,
  LIP_LOWER_TAPER,
  LIP_SEAT_VERTICAL,
  LIP_SUPPORT_HEIGHT,
  MAGNET_HOLE_DEPTH,
  MAGNET_HOLE_DIAMETER,
  MAGNET_HOLE_FROM_CELL_EDGE,
  PITCH,
  SCOOP_RADIUS,
  WALL_THICKNESS,
} from './constants';
import { hullBetween, insetPolygon, loftChain, roundedRectPolygon } from './shapes';

export { roundedRectPolygon } from './shapes';

/**
 * One stacking foot, centred on the origin, resting on z = 0.
 * Profile bottom to top: 0.8 mm 45-degree outward chamfer, 1.8 mm vertical,
 * 2.15 mm 45-degree outward chamfer, ending at the 41.5 mm base footprint.
 */
export function buildFoot(m: ManifoldToplevel): Manifold {
  const topSize = BASE_TOP_SIZE;
  const midSize = topSize - 2 * FOOT_UPPER_CHAMFER;
  const bottomSize = midSize - 2 * FOOT_LOWER_CHAMFER;
  const topR = BASE_TOP_RADIUS;
  const midR = topR - FOOT_UPPER_CHAMFER;
  const bottomR = midR - FOOT_LOWER_CHAMFER;

  const bottomPoly = roundedRectPolygon(bottomSize, bottomSize, bottomR);
  const midPoly = roundedRectPolygon(midSize, midSize, midR);
  const topPoly = roundedRectPolygon(topSize, topSize, topR);

  const lowerChamfer = hullBetween(m, bottomPoly, 0, midPoly, FOOT_LOWER_CHAMFER);
  const vertical = m.Manifold.extrude([midPoly], FOOT_VERTICAL).translate(
    0,
    0,
    FOOT_LOWER_CHAMFER,
  );
  const upperChamfer = hullBetween(
    m,
    midPoly,
    FOOT_LOWER_CHAMFER + FOOT_VERTICAL,
    topPoly,
    FOOT_HEIGHT,
  );
  return m.Manifold.union([lowerChamfer, vertical, upperChamfer]);
}

/**
 * Pocket cutter hollowing the base of one cell, in the style of the lite base
 * in kennetek/gridfinity-rebuilt-openscad (gridfinity-rebuilt-lite.scad): the
 * foot becomes a shell of BASE_WALL_THICKNESS following its own chamfered
 * profile, and the hollow continues up past the foot top to leave only a solid
 * floor plate of FLOOR_PLATE_THICKNESS (kennetek h_bot) under the interior
 * cavity. The 45-degree shell walls and the flat bridged plate print without
 * support. When magnetHoles is set, a solid boss column is kept around each
 * magnet hole (BASE_WALL_THICKNESS of plastic around the cutter) so magnets
 * seat in solid material; each boss deliberately overlaps the corner of the
 * foot shell, so it is welded to the shell walls as well as to the floor
 * plate above.
 * Centred on the origin; open downward past z = 0 for a clean cut.
 */
function buildCellBasePocket(m: ManifoldToplevel, magnetHoles: boolean): Manifold | null {
  const eps = 0.01;
  const pocketTop = FLOOR_TOP - FLOOR_PLATE_THICKNESS;

  // Same three sections as buildFoot, inset by the base wall thickness. Both
  // chamfers keep their 45-degree slope because every section shifts equally.
  const topSize = BASE_TOP_SIZE;
  const midSize = topSize - 2 * FOOT_UPPER_CHAMFER;
  const bottomSize = midSize - 2 * FOOT_LOWER_CHAMFER;
  const topPoly = insetPolygon(
    m,
    roundedRectPolygon(topSize, topSize, BASE_TOP_RADIUS),
    BASE_WALL_THICKNESS,
  );
  const midPoly = insetPolygon(
    m,
    roundedRectPolygon(midSize, midSize, BASE_TOP_RADIUS - FOOT_UPPER_CHAMFER),
    BASE_WALL_THICKNESS,
  );
  const bottomPoly = insetPolygon(
    m,
    roundedRectPolygon(
      bottomSize,
      bottomSize,
      BASE_TOP_RADIUS - FOOT_UPPER_CHAMFER - FOOT_LOWER_CHAMFER,
    ),
    BASE_WALL_THICKNESS,
  );
  // If the inset consumed any foot section, the shell walls would meet in the
  // middle: the whole cell base simply stays solid instead of being pocketed.
  if (topPoly === null || midPoly === null || bottomPoly === null) return null;

  const below = m.Manifold.extrude([bottomPoly], eps).translate(0, 0, -eps);
  const lowerChamfer = hullBetween(m, bottomPoly, 0, midPoly, FOOT_LOWER_CHAMFER);
  const vertical = m.Manifold.extrude([midPoly], FOOT_VERTICAL).translate(
    0,
    0,
    FOOT_LOWER_CHAMFER,
  );
  const upperChamfer = hullBetween(
    m,
    midPoly,
    FOOT_LOWER_CHAMFER + FOOT_VERTICAL,
    topPoly,
    FOOT_HEIGHT,
  );
  const above = m.Manifold.extrude([topPoly], pocketTop - FOOT_HEIGHT).translate(
    0,
    0,
    FOOT_HEIGHT,
  );
  let pocket = m.Manifold.union([below, lowerChamfer, vertical, upperChamfer, above]);

  if (magnetHoles) {
    const offset = PITCH / 2 - MAGNET_HOLE_FROM_CELL_EDGE;
    const bossRadius = MAGNET_HOLE_DIAMETER / 2 + BASE_WALL_THICKNESS;
    const bosses: Manifold[] = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        bosses.push(
          m.Manifold.cylinder(
            pocketTop + 2 * eps,
            bossRadius,
            bossRadius,
            4 * CORNER_SEGMENTS,
          ).translate(sx * offset, sy * offset, -eps),
        );
      }
    }
    pocket = m.Manifold.difference(pocket, m.Manifold.union(bosses));
  }
  return pocket;
}

/**
 * The base pocket for the whole bin: one cell pocket per foot, minus solid
 * strips kept under every divider wall (dividers key into the floor at the
 * foot top, so the material below their roots must remain, all the way to the
 * bed so the strips print as free-standing walls inside the hollow feet), and
 * minus the per-cell rib lattice kept solid inside each foot's hollow.
 *
 * Rib lattice, ported (simplified) from the Pred reference bin measurement
 * (gridfinitybin_1x1x6_d1_l12_s10, first-layer plan slice): the reference
 * fills each foot with a diamond-void lattice of thin ribs, giving its first
 * layer about 499 mm squared of solid per cell (roughly 75 percent more than
 * our former sparse cross). We reproduce the load-bearing rib families at the
 * measured rib width (BASE_RIB_THICKNESS): a "+" of cross walls (one along X
 * at the cell's Y midline, one along Y at the cell's X midline) and the cell's
 * two diagonals. Simplification: the reference's diamond voids are replaced by
 * these straight ribs, which reproduces the measured first-layer solid area
 * within a couple of percent while keeping the geometry simple and watertight;
 * above the first layer our vertical ribs stay constant width where the
 * reference's thicken with the foot flare, so our foot is a little less dense
 * (less filament) higher up, which does not affect first-layer adhesion. Each
 * rib stands on the bed and rises to the underside of the floor plate, welded
 * into the surrounding foot shell. Returns null when the base cannot be
 * pocketed at all (foot too small for the shell inset), in which case the base
 * stays solid.
 */
function buildBasePocket(m: ManifoldToplevel, params: BinParams): Manifold | null {
  const { gridX, gridY, magnetHoles } = params;
  const eps = 0.01;
  const pocketTop = FLOOR_TOP - FLOOR_PLATE_THICKNESS;

  const cellPocket = buildCellBasePocket(m, magnetHoles);
  if (cellPocket === null) return null;
  const pockets: Manifold[] = [];
  for (let ix = 0; ix < gridX; ix++) {
    for (let iy = 0; iy < gridY; iy++) {
      const cx = (ix - (gridX - 1) / 2) * PITCH;
      const cy = (iy - (gridY - 1) / 2) * PITCH;
      pockets.push(cellPocket.translate(cx, cy, 0));
    }
  }
  let pocket = m.Manifold.union(pockets);

  const ribs: Manifold[] = [];
  const ribHeight = pocketTop + 2 * eps;
  // Per-cell rib lattice, kept out of the pocket so the ribs intersect the
  // hollow exactly and weld into the foot shell walls at their ends. Plain
  // overlap with magnet bosses is intentional. The "+" cross runs along both
  // cell midlines; the two diagonals run corner to corner (a long rib rotated
  // 45 degrees, clipped to the pocket automatically because it is subtracted
  // from the pocket). All at the measured rib width.
  const diagLength = PITCH * Math.SQRT2;
  for (let ix = 0; ix < gridX; ix++) {
    for (let iy = 0; iy < gridY; iy++) {
      const cx = (ix - (gridX - 1) / 2) * PITCH;
      const cy = (iy - (gridY - 1) / 2) * PITCH;
      ribs.push(
        m.Manifold.cube([PITCH, BASE_RIB_THICKNESS, ribHeight], true).translate(
          cx,
          cy,
          ribHeight / 2 - eps,
        ),
        m.Manifold.cube([BASE_RIB_THICKNESS, PITCH, ribHeight], true).translate(
          cx,
          cy,
          ribHeight / 2 - eps,
        ),
      );
      for (const angle of [45, -45]) {
        ribs.push(
          m.Manifold.cube([diagLength, BASE_RIB_THICKNESS, ribHeight], true)
            .rotate(0, 0, angle)
            .translate(cx, cy, ribHeight / 2 - eps),
        );
      }
    }
  }
  if (ribs.length > 0) {
    pocket = m.Manifold.difference(pocket, m.Manifold.union(ribs));
  }
  return pocket;
}

/** Magnet hole cutters for one foot centred on the origin, from z = 0 upward. */
function footMagnetCutters(m: ManifoldToplevel): Manifold {
  const offset = PITCH / 2 - MAGNET_HOLE_FROM_CELL_EDGE;
  const cutters: Manifold[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      cutters.push(
        m.Manifold.cylinder(
          MAGNET_HOLE_DEPTH,
          MAGNET_HOLE_DIAMETER / 2,
          MAGNET_HOLE_DIAMETER / 2,
          4 * CORNER_SEGMENTS,
        ).translate(sx * offset, sy * offset, 0),
      );
    }
  }
  return m.Manifold.union(cutters);
}

/** Number of straight segments approximating the lip crest fillet arc. */
const LIP_FILLET_SEGMENTS = 4;

/**
 * Inset of the lip crest fillet arc from the outer face at arc parameter
 * `angle` (0 at the tangent with the vertical outer face, PI/2 at the apex,
 * 3*PI/4 at the tangent with the seat's upper taper), with the matching
 * height above the nominal bin top.
 */
function crestArcPoint(angle: number): { inset: number; rise: number } {
  return {
    inset: LIP_FILLET_RADIUS * (1 - Math.cos(angle)),
    rise: LIP_CREST_HEIGHT - LIP_FILLET_RADIUS + LIP_FILLET_RADIUS * Math.sin(angle),
  };
}

/**
 * Height of the top of the interior vertical wall face: the z where the
 * wall-thickness interior stops rising and the lip's
 * 45-degree support taper begins narrowing the opening toward the lip tip.
 * Measured down from the nominal bin top by the vertical support band
 * (LIP_SUPPORT_HEIGHT) and the run of the taper (LIP_DEPTH - WALL_THICKNESS).
 */
function interiorWallTopZ(bodyTop: number): number {
  return bodyTop - LIP_SUPPORT_HEIGHT - (LIP_DEPTH - WALL_THICKNESS);
}

/** Extrude a (y, z) profile along X over the given width, starting at x = 0. */
export function prismFromProfile(
  m: ManifoldToplevel,
  profile: SimplePolygon,
  width: number,
): Manifold {
  const section = new m.CrossSection([profile], 'NonZero');
  try {
    return section.extrude(width).rotate(90, 0, 90);
  } finally {
    section.delete();
  }
}

/**
 * The bin's outer wall envelope from the top of the feet up. The outer face
 * carries the measured rim groove below the nominal top (LIP_GROOVE_INSET /
 * LIP_GROOVE_VERTICAL, measured from the Pred reference bin), runs straight
 * through the lip band, and closes in the crest fillet (LIP_FILLET_RADIUS,
 * sampled as LIP_FILLET_SEGMENTS chords) ending at the apex LIP_CREST_HEIGHT
 * above the nominal top. Also the shape the slot shelf and dividers are
 * clipped to, so nothing pokes through the groove or past the crest.
 */
export function buildOuterEnvelope(m: ManifoldToplevel, params: BinParams): Manifold {
  const outerWidth = binOuterSizeMm(params.gridX);
  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const sections: Array<{ inset: number; z: number }> = [
    { inset: 0, z: FOOT_HEIGHT },
    // Measured rim groove: 45-degree step in, vertical band ending at the
    // nominal top, 45-degree step back out.
    { inset: 0, z: bodyTop - LIP_GROOVE_VERTICAL - LIP_GROOVE_INSET },
    { inset: LIP_GROOVE_INSET, z: bodyTop - LIP_GROOVE_VERTICAL },
    { inset: LIP_GROOVE_INSET, z: bodyTop },
    { inset: 0, z: bodyTop + LIP_GROOVE_INSET },
    // Straight outer face up to where the crest fillet starts.
    { inset: 0, z: bodyTop + LIP_CREST_HEIGHT - LIP_FILLET_RADIUS },
  ];
  // Outer branch of the crest fillet, up to the apex.
  for (let i = 1; i <= LIP_FILLET_SEGMENTS; i++) {
    const { inset, rise } = crestArcPoint((i / LIP_FILLET_SEGMENTS) * (Math.PI / 2));
    sections.push({ inset, z: bodyTop + rise });
  }
  return loftChain(m, outerWidth, outerDepth, sections);
}

/**
 * Interior cavity cutter for a stacking-lip bin, ending in the lip's inner
 * seat: the negative of the stacking foot (kennetek STACKING_LIP_LINE with
 * its support), the mirror of buildOuterEnvelope's section table on the
 * interior side. The wall-thickness interior rises to where the 45-degree
 * support taper narrows the opening to the lip tip at LIP_DEPTH, holds
 * vertical for LIP_SUPPORT_HEIGHT up to the nominal top, then opens back out
 * through the seat profile (45-degree taper, vertical band, 45-degree taper).
 * The seat's upper taper is cut past the crest, whose fillet the envelope
 * already carries; the cutter follows the fillet's inner arc branch so the
 * crest closes in the round crest instead of a knife edge.
 */
function buildInteriorCutter(m: ManifoldToplevel, params: BinParams): Manifold {
  const outerWidth = binOuterSizeMm(params.gridX);
  const outerDepth = binOuterSizeMm(params.gridY);
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const eps = 0.01;
  const tangent = crestArcPoint((3 / 4) * Math.PI);
  const sections: Array<{ inset: number; z: number }> = [
    { inset: WALL_THICKNESS, z: FLOOR_TOP },
    { inset: WALL_THICKNESS, z: interiorWallTopZ(bodyTop) },
    { inset: LIP_DEPTH, z: bodyTop - LIP_SUPPORT_HEIGHT },
    { inset: LIP_DEPTH, z: bodyTop },
    { inset: LIP_DEPTH - LIP_LOWER_TAPER, z: bodyTop + LIP_LOWER_TAPER },
    {
      inset: LIP_DEPTH - LIP_LOWER_TAPER,
      z: bodyTop + LIP_LOWER_TAPER + LIP_SEAT_VERTICAL,
    },
    // Upper taper up to its tangent with the crest fillet, then the
    // fillet's inner arc branch to the apex.
    { inset: tangent.inset, z: bodyTop + tangent.rise },
  ];
  const innerFilletSegments = Math.ceil(LIP_FILLET_SEGMENTS / 2);
  for (let i = 1; i <= innerFilletSegments; i++) {
    const angle = (3 / 4) * Math.PI - (i / innerFilletSegments) * (Math.PI / 4);
    const { inset, rise } = crestArcPoint(angle);
    sections.push({ inset, z: bodyTop + rise });
  }
  // Past the apex the cutter continues straight up to clear the top face.
  sections.push({
    inset: LIP_FILLET_RADIUS,
    z: bodyTop + LIP_CREST_HEIGHT + eps,
  });
  return loftChain(m, outerWidth, outerDepth, sections);
}

/**
 * Interior divider walls. Each wall is a free segment (see DividerWall): it
 * runs from (x1,y1) to (x2,y2) at any angle, is DIVIDER_THICKNESS thick, and
 * rises from inside the floor slab (top of the feet) to the nominal bin top
 * (below the stacking lip seat). Every wall is extended slightly at both ends
 * along its own direction so a wall reaching the perimeter overlaps into the
 * side wall for a solid weld; the whole set is then trimmed to the outer wall
 * envelope so nothing pokes outside the bin or through the rim groove. Axis
 * aligned full-interior-span walls (from evenDividerWalls) reproduce the old
 * evenly spaced dividers exactly: the end extension equals WALL_THICKNESS, so
 * an interior-span segment reaches the outer face and trims back to it, the
 * same solid the count-based generator produced.
 */
/**
 * A box following a divider wall's centreline: `width` across the wall,
 * `height` tall with its base at `zBottom`, and running from endpoint to
 * endpoint, extended past an endpoint by `extension` only when that endpoint
 * lies on the interior boundary.
 *
 * The extension exists so an endpoint placed against a perimeter wall reaches
 * into that wall's material and welds into it (the caller trims the result
 * back to the outer envelope), which is what the evenly spaced dividers need
 * and how they have always been built. Any other endpoint is left exactly
 * where the user drew it: extending a wall that ends against another wall
 * pushes a fin out through the far face of the wall it meets, and extending a
 * wall that ends in open interior builds it longer than it was drawn. Where
 * two walls meet, the union already welds them because the segments touch, so
 * a junction needs no extension of its own.
 *
 * Every non-boundary endpoint also gets a round end cap (see buildDividers): a
 * vertical cylinder of radius DIVIDER_THICKNESS / 2 centred on the endpoint,
 * turning each free wall into a capsule. Two walls meeting at a shared interior
 * endpoint at any angle overlap through the disc of that cap, so the outer side
 * of the joint welds solid instead of leaving the miter notch that two square
 * box ends leave between them. Boundary endpoints are excluded: their extension
 * already drives them past the outer face into the perimeter wall, where the
 * envelope intersection trims everything (a cap included) back flush, so a cap
 * there would add nothing and even-grid boundary-to-boundary walls stay the
 * exact solid the count-based generator produced.
 */
function wallFollowingBox(
  m: ManifoldToplevel,
  wall: DividerWall,
  footprint: BinFootprint,
  width: number,
  height: number,
  zBottom: number,
  extension: number,
): Manifold {
  const [onBoundary1, onBoundary2] = wallEndsOnInteriorBoundary(wall, footprint);
  const start = onBoundary1 ? extension : 0;
  const end = onBoundary2 ? extension : 0;
  const centreline = wallLength(wall);
  const length = centreline + start + end;
  const angleRad = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
  // The box is centred on its own length, so an asymmetric pair of extensions
  // shifts its centre along the wall by half their difference.
  const shift = (end - start) / 2;
  const mx = (wall.x1 + wall.x2) / 2 + Math.cos(angleRad) * shift;
  const my = (wall.y1 + wall.y2) / 2 + Math.sin(angleRad) * shift;
  return m.Manifold.cube([length, width, height], true)
    .translate(0, 0, zBottom + height / 2)
    .rotate(0, 0, (angleRad * 180) / Math.PI)
    .translate(mx, my, 0);
}

function buildDividers(
  m: ManifoldToplevel,
  dividerWalls: DividerWall[],
  footprint: BinFootprint,
  envelope: Manifold,
  bodyTop: number,
): Manifold {
  // A divider stands on the interior floor and belongs entirely to the
  // container above it: nothing of it may reach into the base. The interior
  // cutter opens the cavity from FLOOR_TOP upward, so the floor plate's top
  // face is one plane at that height across the whole interior, and a wall
  // based on it shares that plane exactly. No embedding is needed, because
  // manifold's union is exact on coincident faces.
  const zBottom = FLOOR_TOP;
  const height = bodyTop - zBottom;
  const solids: Manifold[] = [];
  const capRadius = DIVIDER_THICKNESS / 2;
  for (const wall of dividerWalls) {
    // A boundary end is extended by the perimeter wall's own thickness, so it
    // reaches the outer face and the envelope intersection trims it flush.
    solids.push(
      wallFollowingBox(m, wall, footprint, DIVIDER_THICKNESS, height, zBottom, WALL_THICKNESS),
    );
    // Round end caps weld angled junctions on their outer side. Only free
    // (non-boundary) ends get one; a boundary end is handled by its extension.
    const [onBoundary1, onBoundary2] = wallEndsOnInteriorBoundary(wall, footprint);
    if (!onBoundary1) {
      solids.push(
        m.Manifold.cylinder(height, capRadius, capRadius, 4 * CORNER_SEGMENTS).translate(
          wall.x1,
          wall.y1,
          zBottom,
        ),
      );
    }
    if (!onBoundary2) {
      solids.push(
        m.Manifold.cylinder(height, capRadius, capRadius, 4 * CORNER_SEGMENTS).translate(
          wall.x2,
          wall.y2,
          zBottom,
        ),
      );
    }
  }
  return m.Manifold.intersection(m.Manifold.union(solids), envelope);
}

/**
 * The scoop: a circular fillet (SCOOP_RADIUS, measured from the Pred
 * reference bin) added where the interior floor meets the back wall, the
 * wall opposite the label slot, so small parts can be swept up the curve
 * with a finger. The fillet arc is tangent to the interior floor and to the
 * vertical interior wall face, and the solid runs the full interior width
 * wall to wall, straight across at every height, exactly as measured. The
 * prism's ends are square while the bin's corners are round, so the caller
 * clips it to the outer wall envelope (as it does the dividers); the
 * reference bin's scoop is likewise bounded by the wall faces at its ends.
 * It only adds material at the wall/floor junction: it sits entirely above
 * the floor plate (so the hollowed base pocket is untouched), and any
 * divider wall crossing it simply welds into the added material. On low bins
 * the measured radius may exceed the vertical interior wall height (the wall
 * face ends where the lip's 45-degree support taper begins), so the radius is
 * clamped to the available wall height to keep the arc tangent to a real wall
 * face.
 * Returns null when no wall height is available at all.
 */
function buildScoop(m: ManifoldToplevel, params: BinParams, bodyTop: number): Manifold | null {
  const innerWidth = binInteriorSizeMm(params.gridX);
  const innerDepth = binInteriorSizeMm(params.gridY);
  // Top of the vertical interior wall face: where the lip's support taper
  // starts narrowing the interior.
  const wallTop = interiorWallTopZ(bodyTop);
  const radius = Math.min(SCOOP_RADIUS, wallTop - FLOOR_TOP);
  if (radius <= 0) return null;
  // Profile in (y, z): the interior face of the back wall, the floor, and
  // the concave fillet arc tangent to both, sampled like the corner arcs.
  const wallY = innerDepth / 2;
  const centreY = wallY - radius;
  const centreZ = FLOOR_TOP + radius;
  const profile: SimplePolygon = [
    [centreY, FLOOR_TOP],
    [wallY, FLOOR_TOP],
  ];
  // The arc's final point (a = PI/2) coincides with the profile's first
  // point, so the loop stops one sample short and the polygon closes itself.
  for (let i = 0; i < CORNER_SEGMENTS; i++) {
    const a = (i / CORNER_SEGMENTS) * (Math.PI / 2);
    profile.push([centreY + radius * Math.cos(a), centreZ - radius * Math.sin(a)]);
  }
  return prismFromProfile(m, profile, innerWidth).translate(-innerWidth / 2, 0, 0);
}

/**
 * Build the full bin solid. The bin is centred on the origin in X and Y and
 * rests on z = 0.
 */
export function buildBinManifold(m: ManifoldToplevel, params: BinParams): Manifold {
  validateParams(params);
  const { gridX, gridY, heightUnits, magnetHoles, walls: dividerWalls } = params;

  const bodyTop = heightUnits * HEIGHT_UNIT;

  // Feet: one stacking foot per grid cell, plus optional magnet holes.
  let foot = buildFoot(m);
  if (magnetHoles) {
    foot = m.Manifold.difference(foot, footMagnetCutters(m));
  }
  const feet: Manifold[] = [];
  for (let ix = 0; ix < gridX; ix++) {
    for (let iy = 0; iy < gridY; iy++) {
      const cx = (ix - (gridX - 1) / 2) * PITCH;
      const cy = (iy - (gridY - 1) / 2) * PITCH;
      feet.push(foot.translate(cx, cy, 0));
    }
  }

  // Body: the outer wall envelope from the top of the feet to the top of the
  // walls, rim groove and crest fillet included.
  const envelope = buildOuterEnvelope(m, params);
  const solid = m.Manifold.union([...feet, envelope]);

  const cutters: Manifold[] = [buildInteriorCutter(m, params)];

  // Hollow the base (lite-style pocket) after the interior cavity is cut.
  const basePocket = buildBasePocket(m, params);
  if (basePocket !== null) {
    cutters.push(basePocket);
  }

  let result = m.Manifold.difference(solid, m.Manifold.union(cutters));

  // The scoop is added after the cavity and base pocket cuts, so its fillet
  // material survives on top of the floor plate. Standard bins always carry
  // it (matching the reference bin); pocket bins opt out via params.scoop.
  if (params.scoop !== false) {
    const scoop = buildScoop(m, params, bodyTop);
    if (scoop !== null) {
      // The scoop prism ends square while the bin corners are round: trimmed
      // to the outer wall envelope, like the dividers, so its ends cannot
      // poke past the outer corner arcs (the reference bin's scoop is
      // bounded by its wall faces there).
      const trimmed = m.Manifold.intersection(scoop, envelope);
      scoop.delete();
      result = m.Manifold.union([result, trimmed]);
    }
  }

  if (dividerWalls.length > 0) {
    const dividers = buildDividers(m, dividerWalls, params, envelope, bodyTop);
    result = m.Manifold.union([result, dividers]);
  }

  if (result.status() !== 'NoError') {
    throw new Error(`Bin generation produced an invalid solid: ${result.status()}`);
  }
  return result;
}

/** Validate and reject out-of-range parameters with a clear message. */
export function validateParams(params: BinParams): void {
  const { gridX, gridY, heightUnits, walls } = params;
  for (const [name, value, min] of [
    ['gridX', gridX, 1],
    ['gridY', gridY, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name} must be an integer of at least ${min}, got ${value}`);
    }
  }
  // Height is continuous in the geometry: any fractional number of height units
  // is valid, so require only a finite value at or above the minimum.
  if (!Number.isFinite(heightUnits) || heightUnits < 2) {
    throw new Error(`heightUnits must be a finite number of at least 2, got ${heightUnits}`);
  }
  // Divider wall geometry (containment, minimum length, compartment gaps) is
  // owned by the divider model; surface its user-worded message as an error.
  const wallProblem = validateWalls(walls, gridX, gridY);
  if (wallProblem !== null) {
    throw new Error(wallProblem);
  }
}

/** Extract flat position/index arrays from a manifold for transfer and rendering. */
export function manifoldToMeshData(solid: Manifold): MeshData {
  const mesh = solid.getMesh();
  if (mesh.numProp === 3) {
    return { vertices: mesh.vertProperties, indices: mesh.triVerts };
  }
  // Strip any extra interleaved properties down to plain xyz positions.
  const numVert = mesh.vertProperties.length / mesh.numProp;
  const vertices = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) {
    vertices[i * 3] = mesh.vertProperties[i * mesh.numProp];
    vertices[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1];
    vertices[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2];
  }
  return { vertices, indices: mesh.triVerts };
}

/** Generate a bin and return its mesh as transferable typed arrays. */
export function generateBin(m: ManifoldToplevel, params: BinParams): MeshData {
  const solid = buildBinManifold(m, params);
  try {
    return manifoldToMeshData(solid);
  } finally {
    solid.delete();
  }
}

/** Resolve an insert's content into the label module's layout spec. */
export function labelSpecOf(content: InsertContentParams): LabelSpec {
  let icon = null;
  if (content.icon !== null) {
    // A custom icon's path is resolved on the UI side (the worker cannot
    // reach localStorage) and passed in iconPath; built-ins resolve here.
    // A name that resolves to neither (a custom icon the user deleted while
    // an entry still referenced it) leaves icon null, so the label renders
    // without the icon rather than throwing.
    icon =
      content.iconPath !== undefined
        ? {
            name: content.icon,
            path: content.iconPath,
            viewBox: [0, 0, 100, 100] as [number, number, number, number],
            category: 'custom' as const,
          }
        : findLabelIcon(content.icon);
  }
  return {
    text: content.text,
    text2: content.text2,
    icon,
  };
}

/**
 * Whether the bin carries the fused shelf in place of the insert channel. The
 * shelf belongs to the fused mode itself, not to the label content: an entry
 * whose spec is blank still gets the shelf, simply with nothing standing on it.
 * Whether a label solid comes out is a separate question, answered by
 * buildFusedLabel. The single source deciding the fused case for the body
 * builders and for pocket validation, which must protect the shelf's plan strip
 * wherever the shelf is built.
 */
export function hasFusedShelf(
  params: Pick<SlottedBinParams, 'fusedLabel'>,
): boolean {
  return params.fusedLabel != null;
}

/**
 * Build the bin body, with its label insert slot unless labelSlot is false
 * (a plain bin with no label feature). The paired insert, when the entry has
 * one, is a separate solid (see buildInsertPlacedInSlot for the preview and
 * the insert generators for the printable part). A fused label gets the same
 * shelf at its solid thickness instead of the channel, so its text has a
 * surface to stand on; the single place that union happens, so every builder
 * on top of this one (the pocket bin included) gets the shelf too.
 */
export function buildSlottedBinBody(
  m: ManifoldToplevel,
  params: BinParams & { labelSlot?: boolean } & Pick<SlottedBinParams, 'fusedLabel'>,
): Manifold {
  const body = buildBinManifold(m, params);
  if (hasFusedShelf(params)) {
    const shelf = buildFusedShelf(m, params);
    const fused = m.Manifold.union([body, shelf]);
    body.delete();
    shelf.delete();
    if (fused.status() !== 'NoError') {
      const status = fused.status();
      fused.delete();
      throw new Error(`Fused label shelf union produced an invalid solid: ${status}`);
    }
    return fused;
  }
  if (params.labelSlot === false) return body;
  return applySlotToBody(m, params, body);
}

/**
 * The label stage every bin generator's two-mesh form ends in, extracted so
 * the slotted, pocket and cutout generators share one implementation. When
 * the parameters carry a fused label, the body already carries the fused
 * shelf and the raised label becomes the second-filament mesh; when they
 * carry the paired insert's content, the insert's plate joins the body mesh
 * (it prints in the body filament) and only its raised label face keeps the
 * label color. Takes ownership of `body`.
 */
export function finishBinPartMeshes(
  m: ManifoldToplevel,
  font: Font,
  bodyIn: Manifold,
  params: SlottedBinParams,
): PartMeshes {
  let body = bodyIn;
  let label: Manifold | null = null;
  try {
    if (params.fusedLabel != null) {
      label = buildFusedLabel(m, font, labelSpecOf(params.fusedLabel), params);
    } else if (params.insert !== null) {
      const placed = buildInsertInSlotSolids(m, font, params.insert, params);
      const withPlate = m.Manifold.union([body, placed.plate]);
      body.delete();
      placed.plate.delete();
      body = withPlate;
      label = placed.label;
    }
    return {
      body: manifoldToMeshData(body),
      label: label ? manifoldToMeshData(label) : null,
    };
  } finally {
    body.delete();
    label?.delete();
  }
}

/**
 * The label stage every bin generator's single-mesh form ends in, extracted
 * so the slotted, pocket and cutout generators share one implementation. A
 * paired insert never rides along (it is its own printable part), but a fused
 * label is part of the bin, so it is unioned into the single mesh and the
 * union's manifold status is checked. `partName` names the part in the
 * failure message (for example "Fused pocket bin"). Takes ownership of
 * `body`.
 */
export function finishBinUnionMesh(
  m: ManifoldToplevel,
  font: Font,
  bodyIn: Manifold,
  params: SlottedBinParams,
  partName: string,
): MeshData {
  let body = bodyIn;
  try {
    if (params.fusedLabel != null) {
      const label = buildFusedLabel(m, font, labelSpecOf(params.fusedLabel), params);
      if (label !== null) {
        const union = m.Manifold.union([body, label]);
        body.delete();
        label.delete();
        if (union.status() !== 'NoError') {
          const status = union.status();
          union.delete();
          throw new Error(`${partName} union produced an invalid solid: ${status}`);
        }
        body = union;
      }
    }
    return manifoldToMeshData(body);
  } finally {
    body.delete();
  }
}

/**
 * Generate a bin as its body mesh plus, when the parameters carry the paired
 * insert's content, the insert resting in the slot; see finishBinPartMeshes
 * for how the two meshes split. Exports generate the bin and the insert as
 * separately placed parts instead.
 */
export function generateSlottedBin(
  m: ManifoldToplevel,
  font: Font,
  params: SlottedBinParams,
): PartMeshes {
  return finishBinPartMeshes(m, font, buildSlottedBinBody(m, params), params);
}

/**
 * Generate a bin as one unioned solid for the STL download; see
 * finishBinUnionMesh for how a fused label joins the mesh.
 */
export function generateSlottedBinUnion(
  m: ManifoldToplevel,
  font: Font,
  params: SlottedBinParams,
): MeshData {
  return finishBinUnionMesh(m, font, buildSlottedBinBody(m, params), params, 'Fused bin');
}

/**
 * The insert's plate and raised label face, each translated into its
 * resting place in the bin's slot, for the preview of a bin ordered
 * together with its insert. Kept separate so the plate joins the body mesh
 * and the label face keeps its own color. The caller owns both manifolds.
 */
export function buildInsertInSlotSolids(
  m: ManifoldToplevel,
  font: Font,
  content: InsertContentParams,
  bin: BinParams,
): { plate: Manifold; label: Manifold | null } {
  const { body, label } = buildInsertSolids(m, font, labelSpecOf(content), bin.gridX);
  const at = insertPositionInBin(bin);
  const plate = body.translate(at.x, at.y, at.z);
  body.delete();
  const placedLabel = label === null ? null : label.translate(at.x, at.y, at.z);
  label?.delete();
  if (plate.status() !== 'NoError' || (placedLabel !== null && placedLabel.status() !== 'NoError')) {
    const status = plate.status() !== 'NoError' ? plate.status() : placedLabel!.status();
    plate.delete();
    placedLabel?.delete();
    throw new Error(`Insert placement produced an invalid solid: ${status}`);
  }
  return { plate, label: placedLabel };
}

/**
 * Generate a standalone label insert as separate plate and inlay meshes, the
 * plate resting on z = 0 ready to print.
 */
export function generateInsert(m: ManifoldToplevel, font: Font, params: InsertParams): PartMeshes {
  const { body, label } = buildInsertSolids(m, font, labelSpecOf(params.content), params.cells);
  try {
    return {
      body: manifoldToMeshData(body),
      label: label ? manifoldToMeshData(label) : null,
    };
  } finally {
    body.delete();
    label?.delete();
  }
}

/** Generate a label insert as one unioned mesh for the STL download. */
export function generateInsertUnion(
  m: ManifoldToplevel,
  font: Font,
  params: InsertParams,
): MeshData {
  const { body, label } = buildInsertSolids(m, font, labelSpecOf(params.content), params.cells);
  let union: Manifold | null = null;
  try {
    if (!label) return manifoldToMeshData(body);
    union = m.Manifold.union([body, label]);
    if (union.status() !== 'NoError') {
      throw new Error(`Insert union produced an invalid solid: ${union.status()}`);
    }
    return manifoldToMeshData(union);
  } finally {
    body.delete();
    label?.delete();
    union?.delete();
  }
}
