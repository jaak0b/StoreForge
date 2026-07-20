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
import { SOLID_STORE, withStore, type StoreBinding } from './idb';

const SOLIDS: StoreBinding = {
  name: SOLID_STORE,
  openFailure: 'Opening the solid cache storage failed',
};

/** Stores (or replaces) a persisted solid record under its cache key. */
export async function putSolidRecord(record: PersistedSolidRecord): Promise<void> {
  await withStore(
    SOLIDS,
    'readwrite',
    (store) => store.put(record),
    'Storing the cached cutout solid failed',
  );
}

/**
 * Loads a persisted solid record. Returns null when nothing is stored under
 * the key, which is the normal cold-cache case, not an error.
 */
export async function getSolidRecord(key: string): Promise<PersistedSolidRecord | null> {
  const record = await withStore<PersistedSolidRecord | undefined>(
    SOLIDS,
    'readonly',
    (store) => store.get(key) as IDBRequest<PersistedSolidRecord | undefined>,
    'Reading the cached cutout solid failed',
  );
  return record ?? null;
}

/** Deletes a persisted solid record. Deleting a missing key is a no-op. */
export async function deleteSolidRecord(key: string): Promise<void> {
  await withStore(
    SOLIDS,
    'readwrite',
    (store) => store.delete(key),
    'Deleting the cached cutout solid failed',
  );
}

/** Lists the keys of all persisted solid records, for garbage collection. */
export async function listSolidRecordKeys(): Promise<string[]> {
  const keys = await withStore<IDBValidKey[]>(
    SOLIDS,
    'readonly',
    (store) => store.getAllKeys(),
    'Listing the cached cutout solids failed',
  );
  return keys.map((key) => String(key));
}
