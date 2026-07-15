/**
 * Shared placement math for putting a generated mesh onto the plate: the
 * axis-aligned bounds of a mesh set and the rigid transform that centres a
 * footprint at a plate position with its lowest point resting on z = 0.
 * Both the 3MF writer and the combined STL export use these, so the two
 * exports place every bin identically.
 */

import type { MeshData } from '../gridfinity/types';

/** Axis-aligned bounds of one or more meshes. */
export interface MeshBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Compute the joint axis-aligned bounds of the given meshes. */
export function meshBounds(meshes: MeshData[]): MeshBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const mesh of meshes) {
    const v = mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      minX = Math.min(minX, v[i]);
      maxX = Math.max(maxX, v[i]);
      minY = Math.min(minY, v[i + 1]);
      maxY = Math.max(maxY, v[i + 1]);
      minZ = Math.min(minZ, v[i + 2]);
      maxZ = Math.max(maxZ, v[i + 2]);
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Rigid transform (Z rotation plus translation) placing a mesh set so its
 * footprint centre lands at (xMm, yMm), rotated about that centre, with its
 * lowest vertex on z = 0. Convention is row vectors: v' = v R + t.
 */
export interface PlacementTransform {
  /** cos of the rotation angle. */
  cos: number;
  /** sin of the rotation angle. */
  sin: number;
  tx: number;
  ty: number;
  tz: number;
}

/** Compute the placement transform for the given bounds and target position. */
export function placementTransform(
  bounds: MeshBounds,
  xMm: number,
  yMm: number,
  rotationDeg: number,
): PlacementTransform {
  const a = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  return {
    cos: c,
    sin: s,
    tx: xMm - (centreX * c - centreY * s),
    ty: yMm - (centreX * s + centreY * c),
    tz: -bounds.minZ,
  };
}

/** Apply a placement transform to one vertex position. */
export function applyPlacement(
  t: PlacementTransform,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    x * t.cos - y * t.sin + t.tx,
    x * t.sin + y * t.cos + t.ty,
    z + t.tz,
  ];
}

/** One mesh with the plate position it should be placed at. */
export interface PlacedMesh {
  mesh: MeshData;
  /** Footprint centre X on the plate in millimetres. */
  xMm: number;
  /** Footprint centre Y on the plate in millimetres. */
  yMm: number;
  /** Rotation about Z in degrees, counter-clockwise. Default 0. */
  rotationDeg?: number;
}

/**
 * Merge the given meshes into one, each transformed to its plate position
 * (footprint centre at the given point, lowest vertex on z = 0). Used for
 * the combined STL download of a whole plate.
 */
export function mergePlacedMeshes(placed: PlacedMesh[]): MeshData {
  if (placed.length === 0) {
    throw new Error('At least one mesh is required to merge a plate.');
  }
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of placed) {
    vertexCount += p.mesh.vertices.length;
    indexCount += p.mesh.indices.length;
  }
  const vertices = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let vOffset = 0;
  let iOffset = 0;
  for (const p of placed) {
    const t = placementTransform(
      meshBounds([p.mesh]),
      p.xMm,
      p.yMm,
      p.rotationDeg ?? 0,
    );
    const baseVertex = vOffset / 3;
    const v = p.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const [x, y, z] = applyPlacement(t, v[i], v[i + 1], v[i + 2]);
      vertices[vOffset + i] = x;
      vertices[vOffset + i + 1] = y;
      vertices[vOffset + i + 2] = z;
    }
    const idx = p.mesh.indices;
    for (let i = 0; i < idx.length; i++) {
      indices[iOffset + i] = idx[i] + baseVertex;
    }
    vOffset += v.length;
    iOffset += idx.length;
  }
  return { vertices, indices };
}
