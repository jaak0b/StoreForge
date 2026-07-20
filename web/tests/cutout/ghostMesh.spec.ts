import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { centredModelMesh, meshBounds, meshToManifold } from '../../src/engine/cutout/cutoutMesh';
import { parseStl } from '../../src/engine/cutout/stlReader';
import { prepareCutoutModel } from '../../src/engine/cutout/cutoutBin';
import { meshToBinaryStl } from '../../src/engine/gridfinity/stlExport';
import { manifoldToMeshData } from '../../src/engine/gridfinity/binGenerator';
import type { RawMesh } from '../../src/engine/cutout/stlReader';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

/**
 * The editor draws a model as a ghost on the main thread while the worker
 * carves the pocket from the same model in the WASM heap. The two derivations
 * are necessarily separate, and if their frames ever drift apart the ghost
 * stops standing where the pocket is cut, which is a defect nothing else in the
 * suite would catch: both halves would still be watertight and plausible.
 *
 * So these tests measure both and compare them.
 */

/** Bounds of a MeshData, the way the viewport measures a drawn ghost. */
function boundsOfVertices(vertices: Float32Array): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = vertices[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
}

/**
 * An off-centre, asymmetric solid written out as an STL, which is the only
 * shape that can catch a centring mistake: a solid already centred on the
 * origin is centred correctly by doing nothing at all.
 */
function offCentreModel(): RawMesh {
  const solid = m.Manifold.cube([10, 20, 30], false).translate([37, -11, 5]);
  const stl = meshToBinaryStl(manifoldToMeshData(solid));
  solid.delete();
  return parseStl(stl).mesh;
}

describe('centredModelMesh against the import stage it draws for', () => {
  it('puts the ghost in the same frame the prepared solid ends up in', () => {
    const raw = offCentreModel();

    const ghost = boundsOfVertices(centredModelMesh(raw, 1).vertices);
    // A zero clearance skips the simplify and the dilation, leaving exactly the
    // scale and the centring the ghost has to match.
    const prepared = prepareCutoutModel(m, meshToManifold(m, raw), {
      name: 'off-centre.stl',
      unitScale: 1,
      clearanceMm: 0,
    });
    const box = prepared.solid.boundingBox();

    for (let axis = 0; axis < 3; axis += 1) {
      expect(ghost.min[axis]).toBeCloseTo(box.min[axis], 3);
      expect(ghost.max[axis]).toBeCloseTo(box.max[axis], 3);
    }
    prepared.solid.delete();
  });

  it('applies the unit scale before centring, as the import stage does', () => {
    const raw = offCentreModel();

    const ghost = boundsOfVertices(centredModelMesh(raw, 25.4).vertices);
    const prepared = prepareCutoutModel(m, meshToManifold(m, raw), {
      name: 'inches.stl',
      unitScale: 25.4,
      clearanceMm: 0,
    });
    const box = prepared.solid.boundingBox();

    for (let axis = 0; axis < 3; axis += 1) {
      expect(ghost.min[axis]).toBeCloseTo(box.min[axis], 2);
      expect(ghost.max[axis]).toBeCloseTo(box.max[axis], 2);
    }
    // The rescaled model is the file's size times the scale, which is the
    // number the size readout shows after a unit question is answered.
    expect(prepared.sizeMm.x).toBeCloseTo(10 * 25.4, 2);
    prepared.solid.delete();
  });

  it('keeps every triangle, so the ghost is the model and not an approximation', () => {
    const raw = offCentreModel();
    const ghost = centredModelMesh(raw, 1);
    expect(ghost.indices.length).toBe(raw.indices.length);
    expect(ghost.vertices.length).toBe(raw.vertices.length);
  });

  it('does not write through to the parsed mesh it was given', () => {
    const raw = offCentreModel();
    const before = meshBounds(raw);
    centredModelMesh(raw, 1000);
    expect(meshBounds(raw)).toEqual(before);
  });
});
