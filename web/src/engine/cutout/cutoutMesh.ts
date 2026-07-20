// Turning imported triangle soup into a manifold solid that later cutout
// stages can offset and subtract. The ManifoldToplevel is injected as
// everywhere else in the engine so the WASM stays out of the main bundle.
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { MeshData } from '../gridfinity/types';
import type { RawMesh } from './stlReader';

/** Axis-aligned bounds of an imported model in mm. */
export interface MeshBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

const NOT_A_CLOSED_SOLID =
  'This model is not a closed solid, so it cannot be used as a cutout. Repair it in your ' +
  'modelling software or a mesh repair tool and import it again.';

/**
 * Axis-aligned bounding box of the parsed vertices, in the model's own units.
 * Later stages need it to spot a model authored in the wrong unit and to lay
 * the cutout out inside the bin.
 */
export function meshBounds(raw: RawMesh): MeshBounds {
  if (raw.vertices.length === 0) {
    throw new Error('This model contains no vertices, so it has no size.');
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < raw.vertices.length; i += 3) {
    const x = raw.vertices[i];
    const y = raw.vertices[i + 1];
    const z = raw.vertices[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}

/**
 * The imported triangles in the frame the carve places them from: scaled to
 * millimetres by the unit scale, then moved so the bounding box centre sits on
 * the origin.
 *
 * This is the ghost the editor draws while a model is dragged, and it exists
 * because the ghost has to agree with the pocket. prepareCutoutModel performs
 * exactly these two steps, in this order, on the welded solid before it is
 * simplified and dilated, and placeCutter then rotates about the origin. Draw
 * the raw file coordinates instead and every rotation would swing the ghost
 * around a point the carve does not rotate about. The two derivations are
 * necessarily separate, because one runs in the WASM heap in the worker and the
 * other has to run on the main thread every frame, so they are kept in step by
 * a test that measures both.
 *
 * Simplification and the clearance dilation are deliberately not reproduced.
 * The ghost shows the model, not the pocket; the dilated size is what the carve
 * reports back as a footprint.
 */
export function centredModelMesh(raw: RawMesh, unitScale: number): MeshData {
  const bounds = meshBounds(raw);
  const centreX = ((bounds.minX + bounds.maxX) / 2) * unitScale;
  const centreY = ((bounds.minY + bounds.maxY) / 2) * unitScale;
  const centreZ = ((bounds.minZ + bounds.maxZ) / 2) * unitScale;
  const vertices = new Float32Array(raw.vertices.length);
  for (let i = 0; i < raw.vertices.length; i += 3) {
    vertices[i] = raw.vertices[i] * unitScale - centreX;
    vertices[i + 1] = raw.vertices[i + 1] * unitScale - centreY;
    vertices[i + 2] = raw.vertices[i + 2] * unitScale - centreZ;
  }
  return { vertices, indices: raw.indices.slice() };
}

/**
 * Build a manifold solid from imported triangle soup. A model that is not
 * watertight is a user-fixable problem and errors with a user-worded message;
 * it is never approximated by a hull or any other stand-in, because that would
 * cut a pocket in the shape of something the user did not import.
 */
export function meshToManifold(m: ManifoldToplevel, raw: RawMesh): Manifold {
  const mesh = new m.Mesh({
    numProp: 3,
    vertProperties: raw.vertices,
    triVerts: raw.indices,
  });
  // Mandatory: STL stores every triangle with its own three vertices, so
  // neighbouring triangles never share an index and the mesh looks open to
  // manifold. merge() welds coincident vertices; without it even a perfectly
  // watertight STL is rejected as not manifold.
  mesh.merge();
  let solid: Manifold;
  try {
    solid = new m.Manifold(mesh);
  } catch {
    // manifold throws a raw "Not manifold" Error rather than returning a bad
    // status, so the open-mesh case has to be caught and translated here.
    throw new Error(NOT_A_CLOSED_SOLID);
  }
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new Error(NOT_A_CLOSED_SOLID);
  }
  return solid;
}
