import { describe, expect, it } from 'vitest';
import { MAX_TRIANGLES, parseStl } from '../../src/engine/cutout/stlReader';

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/** Write a binary STL by hand, with a caller-chosen 80 byte header text. */
function binaryStl(headerText: string, triangles: number[][]): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangles.length * TRIANGLE_BYTES);
  const view = new DataView(buffer);
  for (let i = 0; i < Math.min(headerText.length, HEADER_BYTES); i += 1) {
    view.setUint8(i, headerText.charCodeAt(i));
  }
  view.setUint32(HEADER_BYTES, triangles.length, true);
  let offset = HEADER_BYTES + 4;
  for (const triangle of triangles) {
    for (let i = 0; i < 3; i += 1) {
      view.setFloat32(offset, 0, true);
      offset += 4;
    }
    for (const value of triangle) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}

function asciiBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/**
 * A unit tetrahedron with corners at the origin and the three unit axis
 * points, written in the ASCII STL grammar with outward-facing windings.
 * Its volume is 1/6 of the unit cube, so 0.166666... mm3 by hand.
 */
const asciiTetrahedron = `solid unit tetra facet endsolid
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
  facet normal 0.577 0.577 0.577
    outer loop
      vertex 1 0 0
      vertex 0 1 0
      vertex 0 0 1
    endloop
  endfacet
endsolid unit tetra
`;

describe('parseStl format detection', () => {
  it('reads a binary file whose header text begins with the word solid as binary', () => {
    // The naive "starts with solid" test would send this down the ASCII path.
    const buffer = binaryStl('solid exported by some binary writer', [
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
    ]);

    const result = parseStl(buffer);

    expect(result.format).toBe('binary');
    expect(result.triangleCount).toBe(1);
  });

  it('reads an ASCII file as ASCII', () => {
    const result = parseStl(asciiBuffer(asciiTetrahedron));

    expect(result.format).toBe('ascii');
    expect(result.triangleCount).toBe(4);
  });
});

describe('parseStl geometry', () => {
  it('emits three unshared vertices per triangle in file order', () => {
    const buffer = binaryStl('binary', [
      [0, 0, 0, 2, 0, 0, 0, 3, 0],
      [0, 0, 0, 0, 3, 0, 0, 0, 4],
    ]);

    const { mesh, triangleCount } = parseStl(buffer);

    expect(triangleCount).toBe(2);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(mesh.vertices)).toEqual([
      0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 4,
    ]);
  });

  it('reads ASCII vertex coordinates including exponent and signed forms', () => {
    const text =
      'solid mixed\n' +
      'facet normal 0 0 1\nouter loop\n' +
      'vertex -1.5 0 0\nvertex 2.5e1 0 0\nvertex 0 1.25E-1 0\n' +
      'endloop\nendfacet\nendsolid mixed\n';

    const { mesh } = parseStl(asciiBuffer(text));

    expect(Array.from(mesh.vertices)).toEqual([-1.5, 0, 0, 25, 0, 0, 0, 0.125, 0]);
  });

  it('accepts carriage return line endings and irregular spacing', () => {
    const crlf = asciiTetrahedron.replace(/\n/g, '\r\n');

    expect(parseStl(asciiBuffer(crlf)).triangleCount).toBe(4);
  });
});

describe('parseStl error reporting', () => {
  it('rejects a truncated binary file as unreadable', () => {
    const full = binaryStl('binary model', [[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
    const truncated = full.slice(0, full.byteLength - 10);

    expect(() => parseStl(truncated)).toThrow(
      'This file could not be read as an STL. Check that it is really an STL file and not ' +
        'another format that was renamed.',
    );
  });

  it('rejects a binary file whose triangle count disagrees with its length', () => {
    const buffer = binaryStl('binary model', [[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
    new DataView(buffer).setUint32(HEADER_BYTES, 7, true);

    expect(() => parseStl(buffer)).toThrow(/could not be read as an STL/);
  });

  it('rejects an ASCII facet that is missing its outer loop', () => {
    const text =
      'solid broken\nfacet normal 0 0 1\nvertex 0 0 0\nendfacet\nendsolid broken\n';

    expect(() => parseStl(asciiBuffer(text))).toThrow(/could not be read as an STL/);
  });

  it('reports a binary file with no triangles', () => {
    expect(() => parseStl(binaryStl('binary model', []))).toThrow(
      'This STL file contains no triangles, so there is no shape to cut out.',
    );
  });

  it('reports an ASCII file with no triangles', () => {
    expect(() => parseStl(asciiBuffer('solid empty\nendsolid empty\n'))).toThrow(
      'This STL file contains no triangles, so there is no shape to cut out.',
    );
  });

  it('reports a binary NaN coordinate as an invalid value', () => {
    const buffer = binaryStl('binary model', [[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
    new DataView(buffer).setFloat32(HEADER_BYTES + 4 + 12, NaN, true);

    expect(() => parseStl(buffer)).toThrow(
      'This STL file contains an invalid coordinate value and may be corrupt.',
    );
  });

  it('reports an ASCII non-finite coordinate as an invalid value', () => {
    const text =
      'solid nan\nfacet normal 0 0 1\nouter loop\n' +
      'vertex nan 0 0\nvertex 1 0 0\nvertex 0 1 0\n' +
      'endloop\nendfacet\nendsolid nan\n';

    expect(() => parseStl(asciiBuffer(text))).toThrow(
      'This STL file contains an invalid coordinate value and may be corrupt.',
    );
  });

  it('reports the actual count and the limit when a binary file is over the ceiling', () => {
    // The length test needs the file to match its declared triangle count, so
    // the ceiling check is exercised rather than the format detection.
    const declared = new ArrayBuffer(HEADER_BYTES + 4 + 250001 * TRIANGLE_BYTES);
    new DataView(declared).setUint32(HEADER_BYTES, 250001, true);

    expect(() => parseStl(declared)).toThrow(
      'This STL file has 250001 triangles, which is more than the limit of 250000. ' +
        'Reduce the model in your modelling software and import it again.',
    );
  });

  it('states the ceiling as the documented limit', () => {
    expect(MAX_TRIANGLES).toBe(250000);
  });
});
