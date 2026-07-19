// Reading an imported STL model into plain triangle data. Framework-agnostic
// and free of WASM: the parser only turns file bytes into vertices and
// indices, and cutoutMesh.ts owns turning that into a manifold solid.
// Problems a user can fix (wrong file, corrupt file, model too heavy) are
// reported as user-worded errors.

/** Triangle soup in mm: three consecutive floats per vertex, three indices per triangle. */
export interface RawMesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

/** A parsed STL file plus what the parser learned about it. */
export interface StlParseResult {
  mesh: RawMesh;
  triangleCount: number;
  format: 'binary' | 'ascii';
}

/** Size in bytes of the binary STL header, before the triangle count. */
const HEADER_BYTES = 80;

/** Bytes per binary STL triangle record: normal + 3 vertices + attribute count. */
const TRIANGLE_BYTES = 12 * 4 + 2;

/**
 * Largest model accepted as a cutout. The clearance step that follows in the
 * cutout pipeline is a Minkowski sum against a sphere, whose cost was measured
 * at roughly 1.2 ms per input triangle, so 250000 triangles is about five
 * minutes of work in the worker: the point past which importing the model is
 * no longer a usable interaction and the user is better served by decimating
 * the model first. Cutout shapes are pockets, not display models, so this is
 * far above what an honest pocket needs.
 */
export const MAX_TRIANGLES = 250000;

const NOT_AN_STL =
  'This file could not be read as an STL. Check that it is really an STL file and not ' +
  'another format that was renamed.';

const NO_TRIANGLES = 'This STL file contains no triangles, so there is no shape to cut out.';

const INVALID_COORDINATE =
  'This STL file contains an invalid coordinate value and may be corrupt.';

function tooManyTriangles(count: number): string {
  return (
    `This STL file has ${count} triangles, which is more than the limit of ${MAX_TRIANGLES}. ` +
    'Reduce the model in your modelling software and import it again.'
  );
}

/**
 * True when the buffer is a binary STL, decided by the standard length test:
 * a binary STL is exactly 80 header bytes, a 4 byte triangle count, and 50
 * bytes per triangle. Testing whether the file starts with the word "solid"
 * is the common but wrong test, because many binary STL writers put their
 * program name, which often contains "solid", into the 80 byte header.
 */
function isBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < HEADER_BYTES + 4) return false;
  const triangleCount = new DataView(buffer).getUint32(HEADER_BYTES, true);
  return HEADER_BYTES + 4 + triangleCount * TRIANGLE_BYTES === buffer.byteLength;
}

function parseBinaryStl(buffer: ArrayBuffer): StlParseResult {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(HEADER_BYTES, true);
  if (triangleCount === 0) throw new Error(NO_TRIANGLES);
  if (triangleCount > MAX_TRIANGLES) throw new Error(tooManyTriangles(triangleCount));

  const vertices = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t += 1) {
    // Skip the stored facet normal: normals are recomputed from the winding
    // wherever they are needed, and STL normals are routinely wrong.
    let offset = HEADER_BYTES + 4 + t * TRIANGLE_BYTES + 12;
    for (let i = 0; i < 9; i += 1) {
      const value = view.getFloat32(offset, true);
      if (!Number.isFinite(value)) throw new Error(INVALID_COORDINATE);
      vertices[t * 9 + i] = value;
      offset += 4;
    }
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  return { mesh: { vertices, indices }, triangleCount, format: 'binary' };
}

/**
 * Parse the ASCII STL grammar: solid <name>, then a run of
 * facet normal / outer loop / three vertex records / endloop / endfacet,
 * closed by endsolid. Any whitespace and any line ending separates tokens.
 * The solid name is skipped as a whole line so a name containing a keyword
 * cannot be read as structure.
 */
function parseAsciiStl(buffer: ArrayBuffer): StlParseResult {
  const text = new TextDecoder().decode(buffer);
  if (!/^\s*solid\b/.test(text)) throw new Error(NOT_AN_STL);
  const firstBreak = text.search(/[\r\n]/);
  const body = firstBreak === -1 ? '' : text.slice(firstBreak);
  const tokens = body.split(/\s+/).filter((token) => token.length > 0);

  const coordinates: number[] = [];
  let cursor = 0;
  const expect = (word: string): void => {
    if (tokens[cursor] !== word) throw new Error(NOT_AN_STL);
    cursor += 1;
  };
  const readNumber = (): number => {
    const token = tokens[cursor];
    if (token === undefined) throw new Error(NOT_AN_STL);
    cursor += 1;
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(INVALID_COORDINATE);
    return value;
  };

  while (cursor < tokens.length && tokens[cursor] !== 'endsolid') {
    expect('facet');
    expect('normal');
    readNumber();
    readNumber();
    readNumber();
    expect('outer');
    expect('loop');
    for (let v = 0; v < 3; v += 1) {
      expect('vertex');
      coordinates.push(readNumber(), readNumber(), readNumber());
    }
    expect('endloop');
    expect('endfacet');
    if (coordinates.length > MAX_TRIANGLES * 9) {
      throw new Error(tooManyTriangles(coordinates.length / 9));
    }
  }

  const triangleCount = coordinates.length / 9;
  if (triangleCount === 0) throw new Error(NO_TRIANGLES);

  const vertices = new Float32Array(coordinates);
  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  return { mesh: { vertices, indices }, triangleCount, format: 'ascii' };
}

/**
 * Parse a binary or ASCII STL file into triangle soup. Every triangle owns
 * its own three vertices, exactly as the file stores them; welding those
 * duplicates is manifold's job, not the parser's. Throws user-worded errors
 * only, so a caller can show the message as it is.
 */
export function parseStl(buffer: ArrayBuffer): StlParseResult {
  return isBinaryStl(buffer) ? parseBinaryStl(buffer) : parseAsciiStl(buffer);
}
