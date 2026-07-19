import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { meshBounds, meshToManifold } from '../../src/engine/cutout/cutoutMesh';
import { parseStl } from '../../src/engine/cutout/stlReader';
import { meshToBinaryStl } from '../../src/engine/gridfinity/stlExport';
import { manifoldToMeshData } from '../../src/engine/gridfinity/binGenerator';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

function asciiBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/**
 * A unit tetrahedron with corners at the origin and the three unit axis
 * points, in the ASCII STL grammar with outward windings. A tetrahedron on
 * three unit edges is a sixth of the unit cube, so its volume is 0.1666667.
 */
const asciiTetrahedron = `solid tetra
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 1 0
vertex 1 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 0 1
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 1
vertex 0 1 0
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 1 0 0
vertex 0 1 0
vertex 0 0 1
endloop
endfacet
endsolid tetra
`;

describe('meshToManifold round trip through the repo STL writer', () => {
  it('recovers a 20 mm cube written as binary STL', () => {
    const original = m.Manifold.cube([20, 20, 20], true);
    const stl = meshToBinaryStl(manifoldToMeshData(original));

    const solid = meshToManifold(m, parseStl(stl).mesh);

    expect(solid.status()).toBe('NoError');
    // 20 mm cube: 8000 mm3 by hand. Binary STL stores float32 coordinates, so
    // each 20 mm edge carries at most about 2e-6 mm of rounding and the volume
    // error stays far below 0.01 mm3.
    expect(solid.volume()).toBeCloseTo(8000, 2);
    original.delete();
    solid.delete();
  });

  it('recovers a curved solid, keeping its triangle count and genus', () => {
    const original = m.Manifold.sphere(10, 64);
    const originalVolume = original.volume();
    const stl = meshToBinaryStl(manifoldToMeshData(original));

    const parsed = parseStl(stl);
    const solid = meshToManifold(m, parsed.mesh);

    expect(solid.status()).toBe('NoError');
    // A sphere is a closed surface of genus 0; a mesh welded wrongly by the
    // merge step would show up here as a different genus.
    expect(solid.genus()).toBe(0);
    // Faceted sphere volume is not a round number, so the writer's own output
    // is the reference: the round trip must not change it beyond float32 noise.
    expect(solid.volume()).toBeCloseTo(originalVolume, 2);
    original.delete();
    solid.delete();
  });

  it('builds a solid from triangles that share no vertex indices', () => {
    // This is the regression test for the mandatory merge() call: an STL
    // always carries three unshared vertices per triangle, which manifold
    // rejects as not manifold until the coincident vertices are welded.
    const parsed = parseStl(asciiBuffer(asciiTetrahedron));
    expect(Array.from(parsed.mesh.indices)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);

    const solid = meshToManifold(m, parsed.mesh);

    expect(solid.status()).toBe('NoError');
    expect(solid.volume()).toBeCloseTo(0.1666667, 5);
    solid.delete();
  });
});

describe('meshToManifold error reporting', () => {
  it('reports a mesh with an open hole as not a closed solid', () => {
    const cube = m.Manifold.cube([10, 10, 10], true);
    const mesh = manifoldToMeshData(cube);
    // Drop one triangle to leave the cube with a hole in its surface.
    const holed = {
      vertices: mesh.vertices,
      indices: mesh.indices.slice(0, mesh.indices.length - 3),
    };

    expect(() => meshToManifold(m, holed)).toThrow(
      'This model is not a closed solid, so it cannot be used as a cutout. Repair it in your ' +
        'modelling software or a mesh repair tool and import it again.',
    );
    cube.delete();
  });
});

describe('meshBounds', () => {
  it('returns the axis-aligned extent of the parsed vertices', () => {
    const parsed = parseStl(asciiBuffer(asciiTetrahedron));

    const bounds = meshBounds(parsed.mesh);

    expect(bounds.minX).toBe(0);
    expect(bounds.minY).toBe(0);
    expect(bounds.minZ).toBe(0);
    expect(bounds.maxX).toBe(1);
    expect(bounds.maxY).toBe(1);
    expect(bounds.maxZ).toBe(1);
    expect(bounds.sizeX).toBe(1);
    expect(bounds.sizeY).toBe(1);
    expect(bounds.sizeZ).toBe(1);
  });

  it('handles a box that does not touch the origin', () => {
    const box = m.Manifold.cube([4, 6, 8], false).translate(-10, 2, 5);
    const parsed = parseStl(meshToBinaryStl(manifoldToMeshData(box)));

    const bounds = meshBounds(parsed.mesh);

    expect(bounds.minX).toBeCloseTo(-10, 5);
    expect(bounds.maxX).toBeCloseTo(-6, 5);
    expect(bounds.minY).toBeCloseTo(2, 5);
    expect(bounds.maxY).toBeCloseTo(8, 5);
    expect(bounds.minZ).toBeCloseTo(5, 5);
    expect(bounds.maxZ).toBeCloseTo(13, 5);
    box.delete();
  });
});
