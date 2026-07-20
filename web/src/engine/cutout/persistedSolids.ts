/**
 * Persistence format for the expensive cutout solids, so they survive a page
 * reload. Two kinds of record share one shape: the clearance-offset prepared
 * solid (the 18 second import product, keyed by cutoutModelKey) and the swept
 * rotated cutter (keyed by cutoutSweptKey). The records live in IndexedDB via
 * src/solidStore.ts; this module owns what a record contains, when it is
 * trusted, and how a solid is reconstructed from it.
 *
 * The accepted tradeoff is staleness: a persisted solid encodes whatever the
 * geometry code produced when it was written, so a change to that code would
 * silently serve yesterday's geometry. Two fences guard it. The schema version
 * below is bumped by hand whenever the geometry that feeds these records
 * changes, and the manifold-3d dependency version is folded into every record
 * so a library upgrade invalidates automatically. A record failing either
 * check, or one whose mesh does not reconstruct to a NoError manifold, is a
 * cache miss and gets recomputed; a corrupt record must never feed a printed
 * part.
 *
 * Typed arrays are stored directly (IndexedDB structured-clones them), never
 * JSON or base64: the mesh goes into the record exactly as manifold hands it
 * out and comes back bit-identical.
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import packageJson from '../../../package.json';
import type { PreparedCutoutModel, SweptSolid } from './cutoutBin';

/**
 * Version fence for the persisted solid records. MUST be bumped whenever
 * prepareCutoutModel, the sweep geometry (sweptCutterFor and what it calls),
 * or anything else that shapes a prepared or swept solid changes, so records
 * written by the old code are treated as misses instead of being served as
 * current geometry. The manifold-3d version check below covers dependency
 * upgrades; this constant covers our own code.
 */
export const CUTOUT_SOLID_SCHEMA_VERSION = 1;

/**
 * The manifold-3d version every record is stamped with, read at build time
 * from this package's declared dependency. It is the declared semver range
 * rather than the installed version, because manifold-3d does not export its
 * package.json (its exports map has no "./package.json" entry), so the
 * installed version is not importable. A lockfile-only bump inside the range
 * therefore does not invalidate on its own; upgrading the declared dependency
 * does, and the schema version above is the manual fence for everything else.
 */
export const MANIFOLD_DEPENDENCY_VERSION: string = packageJson.dependencies['manifold-3d'];

/**
 * The mesh of one solid, exactly the fields Manifold.ofMesh needs to rebuild
 * a watertight manifold: the merge vectors carry the topology that the flat
 * vertex list alone loses.
 */
export interface PersistedMesh {
  numProp: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  mergeFromVert: Uint32Array;
  mergeToVert: Uint32Array;
}

/** What every persisted solid record carries regardless of kind. */
interface PersistedSolidRecordBase {
  /** The in-memory cache key, verbatim: cutoutModelKey or cutoutSweptKey. */
  key: string;
  schemaVersion: number;
  manifoldVersion: string;
  mesh: PersistedMesh;
}

/** A prepared model solid with the metadata PreparedCutoutModel needs back. */
export interface PersistedOffsetRecord extends PersistedSolidRecordBase {
  kind: 'offset';
  sizeMm: PreparedCutoutModel['sizeMm'];
  triangleCount: number;
  timings: PreparedCutoutModel['timings'];
}

/** A swept cutter solid with the sweep length it was built at. */
export interface PersistedSweptRecord extends PersistedSolidRecordBase {
  kind: 'swept';
  lengthMm: number;
}

export type PersistedSolidRecord = PersistedOffsetRecord | PersistedSweptRecord;

function meshOf(solid: Manifold): PersistedMesh {
  const mesh = solid.getMesh();
  return {
    numProp: mesh.numProp,
    vertProperties: mesh.vertProperties,
    triVerts: mesh.triVerts,
    mergeFromVert: mesh.mergeFromVert,
    mergeToVert: mesh.mergeToVert,
  };
}

/** Encode a prepared model solid for storage under its cutoutModelKey. */
export function encodePreparedCutoutModel(
  key: string,
  prepared: PreparedCutoutModel,
): PersistedOffsetRecord {
  return {
    key,
    kind: 'offset',
    schemaVersion: CUTOUT_SOLID_SCHEMA_VERSION,
    manifoldVersion: MANIFOLD_DEPENDENCY_VERSION,
    mesh: meshOf(prepared.solid),
    sizeMm: prepared.sizeMm,
    triangleCount: prepared.triangleCount,
    timings: prepared.timings,
  };
}

/** Encode a swept cutter solid for storage under its cutoutSweptKey. */
export function encodeSweptSolid(key: string, entry: SweptSolid): PersistedSweptRecord {
  return {
    key,
    kind: 'swept',
    schemaVersion: CUTOUT_SOLID_SCHEMA_VERSION,
    manifoldVersion: MANIFOLD_DEPENDENCY_VERSION,
    mesh: meshOf(entry.solid),
    lengthMm: entry.lengthMm,
  };
}

/**
 * Rebuild the solid a record holds, or null when the record cannot be
 * trusted: written under another schema or manifold version, or reconstructing
 * to anything but a NoError manifold. Null is a plain cache miss the caller
 * recomputes from; a stale or corrupt record must never feed a printed part,
 * and it is not an error the user can act on, so nothing throws here. The
 * catch exists because a truncated typed array can make the WASM constructor
 * itself throw, which is the same untrustworthy-record condition as a bad
 * status and gets the same answer.
 */
function decodeSolid(m: ManifoldToplevel, record: PersistedSolidRecord): Manifold | null {
  if (record.schemaVersion !== CUTOUT_SOLID_SCHEMA_VERSION) return null;
  if (record.manifoldVersion !== MANIFOLD_DEPENDENCY_VERSION) return null;
  try {
    const mesh = new m.Mesh({
      numProp: record.mesh.numProp,
      vertProperties: record.mesh.vertProperties,
      triVerts: record.mesh.triVerts,
      mergeFromVert: record.mesh.mergeFromVert,
      mergeToVert: record.mesh.mergeToVert,
    });
    const solid = m.Manifold.ofMesh(mesh);
    if (solid.status() !== 'NoError') {
      solid.delete();
      return null;
    }
    return solid;
  } catch {
    // Surfaced as the miss return value; the caller logs the recompute as a
    // plain cache miss and the record gets overwritten by a fresh one.
    return null;
  }
}

/** Decode an offset record back to the PreparedCutoutModel the cache holds. */
export function decodePreparedCutoutModel(
  m: ManifoldToplevel,
  record: PersistedOffsetRecord,
): PreparedCutoutModel | null {
  const solid = decodeSolid(m, record);
  if (solid === null) return null;
  return {
    solid,
    sizeMm: record.sizeMm,
    triangleCount: record.triangleCount,
    timings: record.timings,
  };
}

/** Decode a swept record back to the SweptSolid the cache holds. */
export function decodeSweptSolid(
  m: ManifoldToplevel,
  record: PersistedSweptRecord,
): SweptSolid | null {
  const solid = decodeSolid(m, record);
  if (solid === null) return null;
  return { solid, lengthMm: record.lengthMm };
}

/**
 * Whether a persisted record key belongs to one of these model keys: the
 * offset record's key IS the model key, and a swept record's key is the model
 * key plus its own colon-separated suffix. The same prefix relationship the
 * worker's CutoutSweptCache.retainForModelKeys retains by, applied here to
 * the persisted records so the orphan sweep and the in-memory eviction agree
 * on what belongs to a model.
 */
export function persistedSolidKeyIsFor(recordKey: string, modelKeys: string[]): boolean {
  return modelKeys.some(
    (modelKey) => recordKey === modelKey || recordKey.startsWith(`${modelKey}:`),
  );
}
