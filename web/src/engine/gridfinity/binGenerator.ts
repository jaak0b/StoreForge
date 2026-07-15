import type { Manifold, ManifoldToplevel, SimplePolygon, Vec3 } from 'manifold-3d';
import type { Font } from 'opentype.js';
import type { BinParams, LabeledBinMeshes, LabeledBinParams, MeshData } from './types';
import { buildLabelManifold } from '../label/placement';
import { iconByName } from '../label/icons';
import {
  BASE_TOP_RADIUS,
  BASE_TOP_SIZE,
  CORNER_SEGMENTS,
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
 * Build the full bin solid. The bin is centred on the origin in X and Y and
 * rests on z = 0.
 */
export function buildBinManifold(m: ManifoldToplevel, params: BinParams): Manifold {
  validateParams(params);
  const { gridX, gridY, heightUnits, stackingLip, magnetHoles } = params;

  const outerWidth = gridX * PITCH - 0.5;
  const outerDepth = gridY * PITCH - 0.5;
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

  const result = m.Manifold.difference(solid, m.Manifold.union(cutters));
  if (result.status() !== 'NoError') {
    throw new Error(`Bin generation produced an invalid solid: ${result.status()}`);
  }
  return result;
}

/** Validate and reject out-of-range parameters with a clear message. */
export function validateParams(params: BinParams): void {
  const { gridX, gridY, heightUnits } = params;
  for (const [name, value, min] of [
    ['gridX', gridX, 1],
    ['gridY', gridY, 1],
    ['heightUnits', heightUnits, 2],
  ] as const) {
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name} must be an integer of at least ${min}, got ${value}`);
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

/**
 * Build the label solid for the given parameters and verify it is welded to
 * the bin body (they must overlap so a union prints as one part). Returns
 * null for an empty label spec.
 */
function buildWeldedLabel(
  m: ManifoldToplevel,
  font: Font,
  params: LabeledBinParams,
  body: Manifold,
): Manifold | null {
  const label = buildLabelManifold(m, font, params, {
    text: params.labelText,
    icon: params.labelIcon === null ? null : iconByName(params.labelIcon),
  });
  if (label) {
    const overlap = label.intersect(body);
    const welded = !overlap.isEmpty();
    overlap.delete();
    if (!welded) {
      label.delete();
      throw new Error('The label does not touch the bin wall, so it cannot be printed.');
    }
  }
  return label;
}

/**
 * Generate a bin plus its front-wall label as separate meshes, so the label
 * can be rendered (and, later, exported) in its own color. The label solid
 * reaches into the wall, so unioning the two meshes yields one printable
 * solid; with no text and no icon the label is null.
 */
export function generateLabeledBin(
  m: ManifoldToplevel,
  font: Font,
  params: LabeledBinParams,
): LabeledBinMeshes {
  const body = buildBinManifold(m, params);
  let label: Manifold | null = null;
  try {
    label = buildWeldedLabel(m, font, params, body);
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
 * Generate a labeled bin as one unioned solid, for the current single-color
 * STL download.
 */
export function generateLabeledBinUnion(
  m: ManifoldToplevel,
  font: Font,
  params: LabeledBinParams,
): MeshData {
  const body = buildBinManifold(m, params);
  let label: Manifold | null = null;
  let union: Manifold | null = null;
  try {
    label = buildWeldedLabel(m, font, params, body);
    if (!label) return manifoldToMeshData(body);
    union = m.Manifold.union([body, label]);
    if (union.status() !== 'NoError') {
      throw new Error(`Labeled bin union produced an invalid solid: ${union.status()}`);
    }
    return manifoldToMeshData(union);
  } finally {
    body.delete();
    label?.delete();
    union?.delete();
  }
}
