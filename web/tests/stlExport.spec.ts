import { describe, expect, it } from 'vitest';
import {
  meshToBinaryStl,
  STL_HEADER_BYTES,
  STL_TRIANGLE_BYTES,
} from '../src/engine/gridfinity/stlExport';
import type { MeshData } from '../src/engine/gridfinity/types';

/** A unit right triangle in the XY plane, CCW seen from +Z. */
const singleTriangle: MeshData = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

describe('meshToBinaryStl', () => {
  it('emits the exact binary size for the triangle count', () => {
    const buffer = meshToBinaryStl(singleTriangle);
    expect(buffer.byteLength).toBe(STL_HEADER_BYTES + 4 + 1 * STL_TRIANGLE_BYTES);
  });

  it('writes the triangle count after the 80-byte header', () => {
    const two: MeshData = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    };
    const view = new DataView(meshToBinaryStl(two));
    expect(view.getUint32(STL_HEADER_BYTES, true)).toBe(2);
  });

  it('writes vertices and an outward normal for a CCW triangle', () => {
    const view = new DataView(meshToBinaryStl(singleTriangle));
    let offset = STL_HEADER_BYTES + 4;
    // Normal of a CCW triangle in the XY plane points along +Z.
    expect(view.getFloat32(offset, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(offset + 4, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(offset + 8, true)).toBeCloseTo(1, 6);
    offset += 12;
    const expected = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    for (let i = 0; i < expected.length; i++) {
      expect(view.getFloat32(offset + i * 4, true)).toBeCloseTo(expected[i], 6);
    }
    // Attribute byte count is zero.
    expect(view.getUint16(offset + expected.length * 4, true)).toBe(0);
  });

  it('rejects an index array that is not a whole number of triangles', () => {
    const broken: MeshData = {
      vertices: singleTriangle.vertices,
      indices: new Uint32Array([0, 1]),
    };
    expect(() => meshToBinaryStl(broken)).toThrow(/multiple of 3/);
  });
});
