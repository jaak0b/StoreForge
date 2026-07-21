import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import {
  BASE_TOP_SIZE,
  BASEPLATE_HEIGHT,
  BASEPLATE_LOWER_CHAMFER,
  BASEPLATE_SOCKET_CLEARANCE,
  BASEPLATE_UPPER_CHAMFER,
  BASEPLATE_VERTICAL,
  CORNER_SEGMENTS,
  MAGNET_HOLE_DEPTH,
  MAGNET_HOLE_DIAMETER,
  MAGNET_HOLE_FROM_CELL_EDGE,
  OUTER_CORNER_RADIUS,
  PITCH,
} from '../gridfinity/constants';
import { loftChain, roundedRectPolygon } from '../gridfinity/shapes';
import { prismFromProfile } from '../gridfinity/binGenerator';
import {
  BASEPLATE_BOSS_WALL,
  BASEPLATE_MAGNET_FLOOR,
  BASEPLATE_SCREW_DIAMETER,
  CONNECTOR_CREST_RADIUS,
  CONNECTOR_FLANK_HEIGHT,
  CONNECTOR_GROOVE_DEPTH,
  CONNECTOR_GROOVE_HALF,
  CONNECTOR_GROOVE_MOUTH_HALF,
  CONNECTOR_GROOVE_MOUTH_HEIGHT,
  CONNECTOR_LENGTH,
  CONNECTOR_RAMP_SLOPE,
  CONNECTOR_RIB_HEAD_SKIN,
  CONNECTOR_RIB_ROOT_SKIN,
  CONNECTOR_RIB_RAMP_BOTTOM,
  CONNECTOR_RIB_RAMP_TOP,
  CONNECTOR_RIB_TOP,
  CONNECTOR_SLOT_FLOOR,
  CONNECTOR_SLOT_LENGTH,
} from './constants';
import type {
  BaseplateMagnets,
  BaseplateParams,
  ConnectionClipParams,
} from './constants';

/**
 * Overshoot past every boolean boundary, so cuts land cleanly through a face
 * instead of exactly on it (the socket rims taper to knife edges at the plate
 * top, where a boolean landing on the boundary is numerically fragile). The
 * overshoot only ever exists outside the retained volume, so it never alters
 * a measured dimension.
 */
const EPS = 0.01;

/**
 * Outer span of a baseplate along one axis, in mm: the cell count times the
 * pitch. The single source of the plate's outer size; the generator, the
 * plate arranger's footprint and the designer's size readout all derive it
 * here, never locally.
 */
export function baseplateSpanMm(units: number, pitchMm: number = PITCH): number {
  return units * pitchMm;
}

/**
 * Height of the vertical riser under the socket, in mm: zero on a plain
 * plate, otherwise the magnet pocket depth plus the solid floor beneath it.
 * A screws-only plate uses the default magnet depth, so magnets can be added
 * to it later.
 */
export function baseplateRiserMm(
  magnets: BaseplateMagnets | null,
  screwHoles: boolean,
): number {
  if (magnets === null && !screwHoles) return 0;
  return (magnets?.heightMm ?? MAGNET_HOLE_DEPTH) + BASEPLATE_MAGNET_FLOOR;
}

/** Half width of the clip body at tolerance zero: the pocket is the wall's vertical-band thickness. */
const CLIP_HALF_WIDTH = BASEPLATE_UPPER_CHAMFER;

/**
 * Theoretical crest height of the clip above its bottom face at the given
 * tolerance: the 45 degree roof runs from the flank top toward an apex half
 * the body width up, and the crest fillet stops CONNECTOR_CREST_RADIUS *
 * (sqrt(2) - 1) short of it. The generated arc's chords sit just inside this.
 */
function clipCrestMm(toleranceMm: number): number {
  const apex = CONNECTOR_FLANK_HEIGHT + (CLIP_HALF_WIDTH - toleranceMm);
  return apex - CONNECTOR_CREST_RADIUS * (Math.SQRT2 - 1);
}

/**
 * Footprint of a standing connection clip, in mm. Derived from the parameters
 * because the tolerance shrinks the clip; the plate arranger must use this,
 * never a recomputed size.
 */
export function clipFootprintMm(params: ConnectionClipParams): {
  widthMm: number;
  depthMm: number;
} {
  return {
    widthMm: 2 * (CLIP_HALF_WIDTH - params.toleranceMm),
    depthMm: clipCrestMm(params.toleranceMm),
  };
}

/**
 * The socket profile as loftChain sections: the rim inset from the section
 * outline at each height, riser included, overshot by EPS below the plate
 * bottom and past the top knife edge. Shared by the plate-wide clipper and
 * the per-cell cavity solids, which differ only in outline size and corner
 * treatment.
 */
function socketSections(riserMm: number): Array<{ inset: number; z: number }> {
  const rimBottom = BASEPLATE_UPPER_CHAMFER + BASEPLATE_LOWER_CHAMFER;
  const chamferTop = riserMm + BASEPLATE_LOWER_CHAMFER;
  return [
    { inset: rimBottom, z: -EPS },
    { inset: rimBottom, z: riserMm },
    { inset: BASEPLATE_UPPER_CHAMFER, z: chamferTop },
    { inset: BASEPLATE_UPPER_CHAMFER, z: chamferTop + BASEPLATE_VERTICAL },
    { inset: 0, z: riserMm + BASEPLATE_HEIGHT },
    { inset: -EPS, z: riserMm + BASEPLATE_HEIGHT + EPS },
  ];
}

/** Centre coordinate of cell i on the full-pitch lattice laid from the low edge. */
function cellCentre(i: number, spanMm: number, pitchMm: number): number {
  return -spanMm / 2 + pitchMm * i + pitchMm / 2;
}

/** Axis-aligned box from opposite corners, spanning z 0 to height. */
function boxBetween(
  m: ManifoldToplevel,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  height: number,
): Manifold {
  const lx = Math.min(x0, x1);
  const ly = Math.min(y0, y1);
  return m.Manifold.cube([Math.abs(x1 - x0), Math.abs(y1 - y0), height]).translate(
    lx,
    ly,
    0,
  );
}

/** One emitted magnet position with the cell it belongs to. */
interface MagnetSite {
  /** Magnet centre. */
  x: number;
  y: number;
  /** The cell corner its boss grows toward. */
  cornerX: number;
  cornerY: number;
}

/**
 * Every magnet position on the plate, four per cell. The positions sit on the
 * bin's own lattice, PITCH / 2 - MAGNET_HOLE_FROM_CELL_EDGE from each cell
 * centre, and are deliberately not keyed to the plate's pitch parameter: the
 * bin's magnet does not move when a plate's pitch changes.
 */
function magnetSites(
  params: BaseplateParams,
  widthMm: number,
  depthMm: number,
  pitchMm: number,
): MagnetSite[] {
  const offset = PITCH / 2 - MAGNET_HOLE_FROM_CELL_EDGE;
  const sites: MagnetSite[] = [];
  for (let ix = 0; ix < params.unitsX; ix++) {
    for (let iy = 0; iy < params.unitsY; iy++) {
      const cx = cellCentre(ix, widthMm, pitchMm);
      const cy = cellCentre(iy, depthMm, pitchMm);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          sites.push({
            x: cx + sx * offset,
            y: cy + sy * offset,
            cornerX: cx + (sx * pitchMm) / 2,
            cornerY: cy + (sy * pitchMm) / 2,
          });
        }
      }
    }
  }
  return sites;
}

/**
 * One magnet boss: the Minkowski sum of a disk of bossRadius at the magnet
 * centre with the outward quadrant toward the cell corner, which is exactly
 * the cylinder unioned with the two axis strips it tangents. The reflex
 * corner facing the cell centre comes out as the measured fillet of radius
 * bossRadius centred on the magnet. Spans z 0 to riser; clipping to the plate
 * outline happens on the union of all bosses.
 */
function bossParts(
  m: ManifoldToplevel,
  site: MagnetSite,
  bossRadius: number,
  riserMm: number,
): Manifold[] {
  return [
    m.Manifold.cylinder(riserMm, bossRadius, bossRadius, 4 * CORNER_SEGMENTS).translate(
      site.x,
      site.y,
      0,
    ),
    boxBetween(m, site.x, site.cornerX, site.y - bossRadius, site.y + bossRadius, riserMm),
    boxBetween(m, site.x - bossRadius, site.x + bossRadius, site.y, site.cornerY, riserMm),
    boxBetween(m, site.x, site.cornerX, site.y, site.cornerY, riserMm),
  ];
}

/**
 * The connector slot cutter for the +Y edge, centred on x = 0 with the
 * plate's outer face at y = 0: the measured (depth, z) removal profile swept
 * CONNECTOR_SLOT_LENGTH along the edge. Below CONNECTOR_RIB_TOP the retained
 * outer skin (root, ramp, head) stays; above it the wall is removed through
 * its full measured thickness, up past the plate top. The cut depth is the
 * measured full wall thickness of the plain plate (BASEPLATE_UPPER_CHAMFER);
 * on a riser plate the thicker riser band keeps its extra material behind
 * the slot, and the slot itself stays at the measured absolute heights so
 * any two connectable plates share one clip fit at the bottom.
 */
function slotCutter(m: ManifoldToplevel, plateHeightMm: number): Manifold {
  const inner = BASEPLATE_UPPER_CHAMFER + EPS;
  const top = plateHeightMm + EPS;
  // (inward depth u, z) boundary of the removed region, mapped to y = -u so
  // the outer face lies at y = 0; listed so the mapped polygon winds CCW.
  const removal: Array<[number, number]> = [
    [CONNECTOR_RIB_ROOT_SKIN, CONNECTOR_SLOT_FLOOR],
    [CONNECTOR_RIB_ROOT_SKIN, CONNECTOR_RIB_RAMP_BOTTOM],
    [CONNECTOR_RIB_HEAD_SKIN, CONNECTOR_RIB_RAMP_TOP],
    [CONNECTOR_RIB_HEAD_SKIN, CONNECTOR_RIB_TOP],
    [-EPS, CONNECTOR_RIB_TOP],
    [-EPS, top],
    [inner, top],
    [inner, CONNECTOR_SLOT_FLOOR],
  ];
  const profile: SimplePolygon = removal.map(([u, z]) => [-u, z]);
  return prismFromProfile(m, profile, CONNECTOR_SLOT_LENGTH).translate(
    -CONNECTOR_SLOT_LENGTH / 2,
    0,
    0,
  );
}

/**
 * Generate a Gridfinity baseplate: the low-filament full profile plate, the
 * socket walls and nothing else, with optional magnet pockets, screw holes
 * and connector slots. Reimplemented from the MIT reference profile with
 * every dimension traced to a measured or existing constant; see the design
 * document for the provenance of each number.
 */
export function generateBaseplate(m: ManifoldToplevel, params: BaseplateParams): Manifold {
  const pitch = params.pitchMm ?? PITCH;
  const width = baseplateSpanMm(params.unitsX, pitch);
  const depth = baseplateSpanMm(params.unitsY, pitch);
  const riser = baseplateRiserMm(params.magnets, params.screwHoles);
  const height = riser + BASEPLATE_HEIGHT;
  const sections = socketSections(riser);

  // Stage 1: the plate outline extruded to full height.
  const outline = m.Manifold.extrude(
    [roundedRectPolygon(width, depth, OUTER_CORNER_RADIUS)],
    height,
  );

  // Stage 2: the socket clipper, inset from the outline by the rim at every
  // height. The corner radii fall out as OUTER_CORNER_RADIUS - inset (1.15 /
  // 1.85 / 4.00), exactly the measured section table; insetPolygon is
  // deliberately not used because loftChain produces the offset sections
  // analytically, without tessellation error.
  const clipper = loftChain(m, width, depth, sections);

  // Stage 3: sharp-cornered cell cavities on the pitch lattice. The cell
  // section size is keyed to the bin's base footprint plus the socket
  // clearance, not to the pitch: at the standard pitch the socket top equals
  // the pitch and the rims vanish into knife edges at the top (the reference
  // geometry); at a larger pitch a real top rim remains, which is physically
  // correct because bins do not resize with a plate's pitch.
  const socketTop = BASE_TOP_SIZE + 2 * BASEPLATE_SOCKET_CLEARANCE;
  const cellSolid = loftChain(m, socketTop, socketTop, sections, 0, 0);
  const cells: Manifold[] = [];
  for (let ix = 0; ix < params.unitsX; ix++) {
    for (let iy = 0; iy < params.unitsY; iy++) {
      cells.push(
        cellSolid.translate(cellCentre(ix, width, pitch), cellCentre(iy, depth, pitch), 0),
      );
    }
  }
  cellSolid.delete();

  // Stage 4: one intersection produces rounded cavity corners at the plate
  // boundary and sharp ones internally.
  const cellUnion = m.Manifold.union(cells);
  const cavity = cellUnion.intersect(clipper);
  cellUnion.delete();
  clipper.delete();

  // Stage 5: the plate is the outline minus the cavity.
  let plate = outline.subtract(cavity);
  outline.delete();
  cavity.delete();

  // Stages 6 to 8: bosses, screw holes and magnet pockets, at every magnet
  // position.
  if (riser > 0) {
    const bossRadius =
      (params.magnets?.diameterMm ?? MAGNET_HOLE_DIAMETER) / 2 + BASEPLATE_BOSS_WALL;
    const sites = magnetSites(params, width, depth, pitch);
    const parts: Manifold[] = [];
    for (const site of sites) parts.push(...bossParts(m, site, bossRadius, riser));
    const bossUnion = m.Manifold.union(parts);
    // Clip to the outline so a boss at a rounded plate corner merges into the
    // wall instead of poking outside the plate.
    const outlineSolid = m.Manifold.extrude(
      [roundedRectPolygon(width, depth, OUTER_CORNER_RADIUS)],
      height,
    );
    const bosses = bossUnion.intersect(outlineSolid);
    bossUnion.delete();
    outlineSolid.delete();
    const withBosses = plate.add(bosses);
    plate.delete();
    bosses.delete();
    plate = withBosses;

    if (params.screwHoles) {
      const screws = sites.map((site) =>
        m.Manifold.cylinder(
          riser + 2 * EPS,
          BASEPLATE_SCREW_DIAMETER / 2,
          BASEPLATE_SCREW_DIAMETER / 2,
          4 * CORNER_SEGMENTS,
        ).translate(site.x, site.y, -EPS),
      );
      const screwUnion = m.Manifold.union(screws);
      const drilled = plate.subtract(screwUnion);
      plate.delete();
      screwUnion.delete();
      plate = drilled;
    }

    if (params.magnets !== null) {
      const { diameterMm, heightMm } = params.magnets;
      const pockets = sites.map((site) =>
        m.Manifold.cylinder(
          heightMm + EPS,
          diameterMm / 2,
          diameterMm / 2,
          4 * CORNER_SEGMENTS,
        ).translate(site.x, site.y, riser - heightMm),
      );
      const pocketUnion = m.Manifold.union(pockets);
      const pocketed = plate.subtract(pocketUnion);
      plate.delete();
      pocketUnion.delete();
      plate = pocketed;
    }
  }

  // Stage 9: connector slots, one per cell per outer edge, centred on the
  // cell centre. A slot is emitted only when its full length lies on the
  // straight part of the edge, clear of the corner arcs: the cutter's
  // retained-skin profile is defined against a flat outer face. A feature
  // that does not fully fit is omitted, never clipped.
  if (params.connectable) {
    const slotFits = (centre: number, spanMm: number): boolean =>
      Math.abs(centre) + CONNECTOR_SLOT_LENGTH / 2 <= spanMm / 2 - OUTER_CORNER_RADIUS;
    const canonical = slotCutter(m, height);
    const slots: Manifold[] = [];
    for (let ix = 0; ix < params.unitsX; ix++) {
      const cx = cellCentre(ix, width, pitch);
      if (!slotFits(cx, width)) continue;
      slots.push(canonical.translate(cx, depth / 2, 0));
      slots.push(canonical.rotate(0, 0, 180).translate(cx, -depth / 2, 0));
    }
    for (let iy = 0; iy < params.unitsY; iy++) {
      const cy = cellCentre(iy, depth, pitch);
      if (!slotFits(cy, depth)) continue;
      slots.push(canonical.rotate(0, 0, -90).translate(width / 2, cy, 0));
      slots.push(canonical.rotate(0, 0, 90).translate(-width / 2, cy, 0));
    }
    canonical.delete();
    if (slots.length > 0) {
      const slotUnion = m.Manifold.union(slots);
      const slotted = plate.subtract(slotUnion);
      plate.delete();
      slotUnion.delete();
      plate = slotted;
    }
  }

  return plate;
}

/**
 * Straight chords approximating the clip's crest fillet arc. Seven chords
 * reproduce the reference connector's own tessellation (its 20-gon section
 * puts eight vertices on the 90 degree arc with none at the apex), so the
 * generated crest height matches the measured 3.6738 rather than the
 * theoretical arc apex 3.6757.
 */
const CLIP_CREST_SEGMENTS = 7;

/**
 * Generate a connection clip, standing on its 4.30 by 3.67 mm cross-section
 * with its length along Z, exactly as the reference exports it: that is the
 * orientation the measurements validate, and layer orientation matters for a
 * snap fit's flexure. The tolerance is applied per mating face to the clip
 * only, never to the plate's slot, so a clip printed at any tolerance still
 * fits a plate already printed.
 */
export function generateConnectionClip(
  m: ManifoldToplevel,
  params: ConnectionClipParams,
): Manifold {
  const t = params.toleranceMm;
  const body = CLIP_HALF_WIDTH - t;
  const mouth = CONNECTOR_GROOVE_MOUTH_HALF + t;
  const groove = CONNECTOR_GROOVE_HALF + t;
  const grooveDepth = CONNECTOR_GROOVE_DEPTH + t;
  // The groove ramp keeps the measured slope, so its top height is the mouth
  // height plus the fixed half-width gain over the slope (t cancels).
  const rampTop =
    CONNECTOR_GROOVE_MOUTH_HEIGHT +
    (CONNECTOR_GROOVE_HALF - CONNECTOR_GROOVE_MOUTH_HALF) / CONNECTOR_RAMP_SLOPE;
  const apex = CONNECTOR_FLANK_HEIGHT + body;
  const r = CONNECTOR_CREST_RADIUS;
  // Crest fillet: centred on the roof axis, tangent to both 45 degree roof
  // faces at r / sqrt(2) from the axis.
  const crestCentreV = apex - r * Math.SQRT2;

  const profile: SimplePolygon = [
    [mouth, 0],
    [body, 0],
    [body, CONNECTOR_FLANK_HEIGHT],
  ];
  // Arc from the right tangent (45 degrees) over the top to the left tangent
  // (135 degrees), CCW, tangent points included.
  for (let i = 0; i <= CLIP_CREST_SEGMENTS; i++) {
    const a = Math.PI / 4 + (i / CLIP_CREST_SEGMENTS) * (Math.PI / 2);
    profile.push([r * Math.cos(a), crestCentreV + r * Math.sin(a)]);
  }
  profile.push(
    [-body, CONNECTOR_FLANK_HEIGHT],
    [-body, 0],
    [-mouth, 0],
    [-mouth, CONNECTOR_GROOVE_MOUTH_HEIGHT],
    [-groove, rampTop],
    [-groove, grooveDepth],
    [groove, grooveDepth],
    [groove, rampTop],
    [mouth, CONNECTOR_GROOVE_MOUTH_HEIGHT],
  );

  const section = new m.CrossSection([profile], 'NonZero');
  try {
    return section.extrude(CONNECTOR_LENGTH - 2 * t);
  } finally {
    section.delete();
  }
}
