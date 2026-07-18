import type { Manifold, ManifoldToplevel, SimplePolygon, Vec3 } from 'manifold-3d';
import type { Font } from 'opentype.js';
import type {
  BinParams,
  InsertContentParams,
  InsertParams,
  MeshData,
  PartMeshes,
  SlottedBinParams,
} from './types';
import { applySlotToBody, buildInsertSolids, insertPositionInBin } from '../label/slot';
import type { LabelSpec } from '../label/placement';
import { iconByName } from '../label/icons';
import {
  BASE_TOP_RADIUS,
  binInteriorSizeMm,
  binOuterSizeMm,
  BASE_WALL_THICKNESS,
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
  LIP_HEIGHT,
  LIP_TOP_THICKNESS,
  LIP_VERTICAL,
  MAGNET_HOLE_DEPTH,
  MAGNET_HOLE_DIAMETER,
  MAGNET_HOLE_FROM_CELL_EDGE,
  OUTER_CORNER_RADIUS,
  PITCH,
  WALL_THICKNESS,
} from './constants';

/**
 * Counter-clockwise polygon approximating a rectangle of the given outer size,
 * centred on the origin, with quarter-circle corner arcs of radius r.
 */
export function roundedRectPolygon(
  width: number,
  depth: number,
  r: number,
  segments: number = CORNER_SEGMENTS,
): SimplePolygon {
  const hx = width / 2;
  const hy = depth / 2;
  const radius = Math.min(r, hx, hy);
  const points: SimplePolygon = [];
  // Corner arc centres, in CCW order starting from the +X/+Y corner.
  const corners: Array<[number, number, number]> = [
    [hx - radius, hy - radius, 0],
    [-(hx - radius), hy - radius, Math.PI / 2],
    [-(hx - radius), -(hy - radius), Math.PI],
    [hx - radius, -(hy - radius), (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = start + (i / segments) * (Math.PI / 2);
      points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
  }
  return points;
}

function polygonAtZ(poly: SimplePolygon, z: number): Vec3[] {
  return poly.map(([x, y]) => [x, y, z]);
}

/**
 * Convex loft between two rounded-rectangle sections at different heights,
 * built as the convex hull of both point rings. Both sections are convex, so
 * the hull is the exact linear loft; with 45-degree offsets this produces the
 * chamfered segments of the stacking foot profile.
 */
function hullBetween(
  m: ManifoldToplevel,
  bottom: SimplePolygon,
  zBottom: number,
  top: SimplePolygon,
  zTop: number,
): Manifold {
  return m.Manifold.hull([...polygonAtZ(bottom, zBottom), ...polygonAtZ(top, zTop)]);
}

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
 * Inset a convex polygon by the given distance (rounded corners shrink
 * naturally, collapsing to sharp corners when the inset exceeds their radius).
 * Returns null when the inset consumes the whole polygon (the section closes
 * completely), so callers can keep that part of the shape solid.
 */
function insetPolygon(
  m: ManifoldToplevel,
  poly: SimplePolygon,
  inset: number,
): SimplePolygon | null {
  const section = new m.CrossSection([poly], 'NonZero');
  try {
    const shrunk = section.offset(-inset, 'Round');
    try {
      const polygons = shrunk.toPolygons();
      if (polygons.length === 0) return null;
      if (polygons.length !== 1) {
        throw new Error(`Insetting a polygon by ${inset} mm did not leave one contour.`);
      }
      return polygons[0];
    } finally {
      shrunk.delete();
    }
  } finally {
    section.delete();
  }
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
 * minus a "+" of cross walls per grid cell. The cross walls are our own
 * printability design (not from a reference implementation): one wall along X
 * at the cell's Y midline and one along Y at the cell's X midline, standing
 * on the bed and rising to the underside of the floor plate, welded into the
 * surrounding foot shell so each cell becomes four closed chambers. They keep
 * the unsupported bridge span of the floor plate near 21 mm at any bin size.
 * Returns null when the base cannot be pocketed at all (foot too small for
 * the shell inset), in which case the base stays solid.
 */
function buildBasePocket(m: ManifoldToplevel, params: BinParams): Manifold | null {
  const { gridX, gridY, magnetHoles, dividerCountX, dividerCountY } = params;
  const eps = 0.01;
  const pocketTop = FLOOR_TOP - FLOOR_PLATE_THICKNESS;
  const outerWidth = binOuterSizeMm(gridX);
  const outerDepth = binOuterSizeMm(gridY);

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

  const strips: Manifold[] = [];
  const stripWidth = DIVIDER_THICKNESS + 2 * BASE_WALL_THICKNESS;
  const stripHeight = pocketTop + 2 * eps;
  const innerWidth = binInteriorSizeMm(gridX);
  const innerDepth = binInteriorSizeMm(gridY);
  for (let i = 1; i <= dividerCountX; i++) {
    const x = -innerWidth / 2 + (i * innerWidth) / (dividerCountX + 1);
    strips.push(
      m.Manifold.cube([stripWidth, outerDepth, stripHeight], true).translate(
        x,
        0,
        stripHeight / 2 - eps,
      ),
    );
  }
  for (let i = 1; i <= dividerCountY; i++) {
    const y = -innerDepth / 2 + (i * innerDepth) / (dividerCountY + 1);
    strips.push(
      m.Manifold.cube([outerWidth, stripWidth, stripHeight], true).translate(
        0,
        y,
        stripHeight / 2 - eps,
      ),
    );
  }
  // Per-cell "+" cross walls: kept out of the pocket, so they intersect the
  // hollow exactly and weld into the foot shell walls at their ends. Plain
  // overlap with magnet bosses or divider root strips is intentional.
  for (let ix = 0; ix < gridX; ix++) {
    for (let iy = 0; iy < gridY; iy++) {
      const cx = (ix - (gridX - 1) / 2) * PITCH;
      const cy = (iy - (gridY - 1) / 2) * PITCH;
      strips.push(
        m.Manifold.cube([PITCH, BASE_WALL_THICKNESS, stripHeight], true).translate(
          cx,
          cy,
          stripHeight / 2 - eps,
        ),
        m.Manifold.cube([BASE_WALL_THICKNESS, PITCH, stripHeight], true).translate(
          cx,
          cy,
          stripHeight / 2 - eps,
        ),
      );
    }
  }
  if (strips.length > 0) {
    pocket = m.Manifold.difference(pocket, m.Manifold.union(strips));
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

/**
 * Interior divider walls. dividerCountX walls stand perpendicular to the X
 * axis (splitting the width into dividerCountX + 1 equal compartments), and
 * likewise for Y. Each wall is DIVIDER_THICKNESS thick, rises from inside the
 * floor slab (top of the feet) to the nominal bin top (below the stacking lip
 * seat), and is trimmed to the outer wall outline so it welds into the walls
 * and floor without poking outside the bin.
 */
function buildDividers(
  m: ManifoldToplevel,
  params: BinParams,
  outerPoly: SimplePolygon,
  outerWidth: number,
  outerDepth: number,
  bodyTop: number,
): Manifold {
  const { dividerCountX, dividerCountY } = params;
  const innerWidth = binInteriorSizeMm(params.gridX);
  const innerDepth = binInteriorSizeMm(params.gridY);
  // Embedded into the floor slab (feet top to floor top) for a solid weld.
  const zBottom = FOOT_HEIGHT;
  const height = bodyTop - zBottom;
  const walls: Manifold[] = [];
  for (let i = 1; i <= dividerCountX; i++) {
    const x = -innerWidth / 2 + (i * innerWidth) / (dividerCountX + 1);
    walls.push(
      m.Manifold.cube([DIVIDER_THICKNESS, outerDepth, height], true).translate(
        x,
        0,
        zBottom + height / 2,
      ),
    );
  }
  for (let i = 1; i <= dividerCountY; i++) {
    const y = -innerDepth / 2 + (i * innerDepth) / (dividerCountY + 1);
    walls.push(
      m.Manifold.cube([outerWidth, DIVIDER_THICKNESS, height], true).translate(
        0,
        y,
        zBottom + height / 2,
      ),
    );
  }
  const outline = m.Manifold.extrude([outerPoly], height).translate(0, 0, zBottom);
  return m.Manifold.intersection(m.Manifold.union(walls), outline);
}

/**
 * Build the full bin solid. The bin is centred on the origin in X and Y and
 * rests on z = 0.
 */
export function buildBinManifold(m: ManifoldToplevel, params: BinParams): Manifold {
  validateParams(params);
  const {
    gridX,
    gridY,
    heightUnits,
    stackingLip,
    magnetHoles,
    dividerCountX,
    dividerCountY,
  } = params;

  const outerWidth = binOuterSizeMm(gridX);
  const outerDepth = binOuterSizeMm(gridY);
  const bodyTop = heightUnits * HEIGHT_UNIT;
  const solidTop = stackingLip ? bodyTop + LIP_HEIGHT : bodyTop;

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

  // Body: rounded-rectangle prism from the top of the feet to the top of the
  // walls (including the lip band when the stacking lip is enabled).
  const outerPoly = roundedRectPolygon(outerWidth, outerDepth, OUTER_CORNER_RADIUS);
  const body = m.Manifold.extrude([outerPoly], solidTop - FOOT_HEIGHT).translate(
    0,
    0,
    FOOT_HEIGHT,
  );

  const solid = m.Manifold.union([...feet, body]);

  // Interior cavity: the outer shape inset by the wall thickness, cut from the
  // top of the floor upward. The inset corner radius is the internal fillet.
  const innerPoly = roundedRectPolygon(
    outerWidth - 2 * WALL_THICKNESS,
    outerDepth - 2 * WALL_THICKNESS,
    OUTER_CORNER_RADIUS - WALL_THICKNESS,
  );
  const eps = 0.01;
  const cutters: Manifold[] = [];
  if (stackingLip) {
    // Cavity up to the start of the lip's opening chamfer.
    cutters.push(
      m.Manifold.extrude([innerPoly], bodyTop + LIP_VERTICAL - FLOOR_TOP).translate(
        0,
        0,
        FLOOR_TOP,
      ),
    );
    // Simplified stacking lip: over the top 0.5 mm the inner rim chamfers
    // outward at 45 degrees, widening the opening from a wall-thickness inset
    // to a 0.7 mm rim at the very top so a stacked bin's foot self-centres.
    const rimPoly = roundedRectPolygon(
      outerWidth - 2 * LIP_TOP_THICKNESS,
      outerDepth - 2 * LIP_TOP_THICKNESS,
      OUTER_CORNER_RADIUS - LIP_TOP_THICKNESS,
    );
    const chamferBottomZ = bodyTop + LIP_VERTICAL;
    const chamfer = hullBetween(m, innerPoly, chamferBottomZ, rimPoly, solidTop);
    const above = m.Manifold.extrude([rimPoly], eps).translate(0, 0, solidTop);
    cutters.push(m.Manifold.union([chamfer, above]));
  } else {
    cutters.push(
      m.Manifold.extrude([innerPoly], bodyTop - FLOOR_TOP + eps).translate(
        0,
        0,
        FLOOR_TOP,
      ),
    );
  }

  // Hollow the base (lite-style pocket) after the interior cavity is cut.
  const basePocket = buildBasePocket(m, params);
  if (basePocket !== null) {
    cutters.push(basePocket);
  }

  let result = m.Manifold.difference(solid, m.Manifold.union(cutters));

  if (dividerCountX > 0 || dividerCountY > 0) {
    const dividers = buildDividers(m, params, outerPoly, outerWidth, outerDepth, bodyTop);
    result = m.Manifold.union([result, dividers]);
  }

  if (result.status() !== 'NoError') {
    throw new Error(`Bin generation produced an invalid solid: ${result.status()}`);
  }
  return result;
}

/** Validate and reject out-of-range parameters with a clear message. */
export function validateParams(params: BinParams): void {
  const { gridX, gridY, heightUnits, dividerCountX, dividerCountY } = params;
  for (const [name, value, min] of [
    ['gridX', gridX, 1],
    ['gridY', gridY, 1],
    ['heightUnits', heightUnits, 2],
    ['dividerCountX', dividerCountX, 0],
    ['dividerCountY', dividerCountY, 0],
  ] as const) {
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name} must be an integer of at least ${min}, got ${value}`);
    }
  }
  // Each compartment must keep a positive clear width between divider walls.
  for (const [name, count, inner] of [
    ['dividerCountX', dividerCountX, binInteriorSizeMm(gridX)],
    ['dividerCountY', dividerCountY, binInteriorSizeMm(gridY)],
  ] as const) {
    const clear = (inner - count * DIVIDER_THICKNESS) / (count + 1);
    if (count > 0 && clear <= 0) {
      throw new Error(
        `${name} is too large: ${count} dividers leave no room between compartment walls`,
      );
    }
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
    icon =
      content.iconPath !== undefined
        ? {
            name: content.icon,
            path: content.iconPath,
            viewBox: [0, 0, 100, 100] as [number, number, number, number],
            category: 'custom' as const,
          }
        : iconByName(content.icon);
  }
  return {
    text: content.text,
    text2: content.text2,
    icon,
  };
}

/**
 * Build the bin body, with its label insert slot unless labelSlot is false
 * (a plain bin with no label feature). The paired insert, when the entry has
 * one, is a separate solid (see buildInsertPlacedInSlot for the preview and
 * the insert generators for the printable part).
 */
export function buildSlottedBinBody(
  m: ManifoldToplevel,
  params: BinParams & { labelSlot?: boolean },
): Manifold {
  const body = buildBinManifold(m, params);
  if (params.labelSlot === false) return body;
  return applySlotToBody(m, params, body);
}

/**
 * Generate a bin as its body mesh plus, when the parameters carry the paired
 * insert's content, the insert resting in the slot. The insert's plate joins
 * the body mesh (it prints in the body filament) and only its raised label
 * face goes on the label mesh, so the preview colors match the printed
 * part. Exports generate the bin and the insert as separately placed parts
 * instead.
 */
export function generateSlottedBin(
  m: ManifoldToplevel,
  font: Font,
  params: SlottedBinParams,
): PartMeshes {
  let body = buildSlottedBinBody(m, params);
  let label: Manifold | null = null;
  try {
    if (params.insert !== null) {
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
 * Generate a bin as one unioned solid for the STL download. The paired
 * insert never rides along: it is its own printable part.
 */
export function generateSlottedBinUnion(
  m: ManifoldToplevel,
  params: BinParams & { labelSlot?: boolean },
): MeshData {
  const body = buildSlottedBinBody(m, params);
  try {
    return manifoldToMeshData(body);
  } finally {
    body.delete();
  }
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
