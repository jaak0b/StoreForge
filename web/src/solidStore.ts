/**
 * IndexedDB store for the persisted cutout solid records, keyed by the same
 * cache key string the worker's in-memory caches use (cutoutModelKey for a
 * prepared clearance-offset solid, cutoutSweptKey for a swept cutter). The
 * record shape, its version fences and the reconstruction logic live in
 * engine/cutout/persistedSolids.ts; this module only moves records in and out
 * of the shared database.
 *
 * Deliberately free of any DOM dependency, because the geometry worker is the
 * main consumer: workers have IndexedDB access of their own, so the worker
 * reads and writes records directly and the main thread only deletes them in
 * the orphan sweep.
 *
 * The database connection belongs to src/idb.ts, which every store shares.
 * Node has no IndexedDB, so this wrapper stays untested; the decisions around
 * it (record trust, version fences, orphan retention) live in the engine and
 * carry the tests.
 */

import type { PersistedSolidRecord } from './engine/cutout/persistedSolids';
import { makeBlobStore, SOLID_STORE } from './idb';

// The record arrives keyed by a field of its own (key), so it is persisted as
// is: the mapping is the identity both ways, and the store key is record.key.
const solids = makeBlobStore<PersistedSolidRecord, PersistedSolidRecord>({
  binding: { name: SOLID_STORE, openFailure: 'Opening the solid cache storage failed' },
  putFailure: 'Storing the cached cutout solid failed',
  getFailure: 'Reading the cached cutout solid failed',
  deleteFailure: 'Deleting the cached cutout solid failed',
  listFailure: 'Listing the cached cutout solids failed',
  toRecord: (_id, record) => record,
  fromRecord: (record) => record,
});

/** Stores (or replaces) a persisted solid record under its cache key. */
export function putSolidRecord(record: PersistedSolidRecord): Promise<void> {
  return solids.put(record.key, record);
}

/**
 * Loads a persisted solid record. Returns null when nothing is stored under
 * the key, which is the normal cold-cache case, not an error.
 */
export function getSolidRecord(key: string): Promise<PersistedSolidRecord | null> {
  return solids.get(key);
}

/** Deletes a persisted solid record. Deleting a missing key is a no-op. */
export function deleteSolidRecord(key: string): Promise<void> {
  return solids.delete(key);
}

/** Lists the keys of all persisted solid records, for garbage collection. */
export function listSolidRecordKeys(): Promise<string[]> {
  return solids.listIds();
}
