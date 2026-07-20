/**
 * IndexedDB store for the original trace photos, keyed by a traced entry's
 * traceSourceId. Photos are multi-megabyte blobs, so they live here instead
 * of the localStorage plan; a missing photo is a normal condition (the plan
 * was imported from another device), not an error.
 *
 * The database connection itself belongs to src/idb.ts, which every blob store
 * shares. Node has no IndexedDB, so this wrapper stays untested; the
 * garbage-collection logic around it lives in engine/plan/storedAssets.ts and
 * is tested with a fake store.
 */

import { PHOTO_STORE, withStore, type StoreBinding } from './idb';

const PHOTOS: StoreBinding = {
  name: PHOTO_STORE,
  openFailure: 'Opening the photo storage failed',
};

interface PhotoRecord {
  id: string;
  photo: Blob;
  createdAt: string;
}

/** Stores (or replaces) the original photo of a trace under its source id. */
export async function putPhoto(id: string, photo: Blob): Promise<void> {
  const record: PhotoRecord = { id, photo, createdAt: new Date().toISOString() };
  await withStore(
    PHOTOS,
    'readwrite',
    (store) => store.put(record),
    'Storing the trace photo failed',
  );
}

/**
 * Loads a stored trace photo. Returns null when no photo is stored under the
 * id, which is the normal case for plans imported from another device.
 */
export async function getPhoto(id: string): Promise<Blob | null> {
  const record = await withStore<PhotoRecord | undefined>(
    PHOTOS,
    'readonly',
    (store) => store.get(id) as IDBRequest<PhotoRecord | undefined>,
    'Reading the stored trace photo failed',
  );
  return record?.photo ?? null;
}

/** Deletes a stored trace photo. Deleting a missing id is a no-op. */
export async function deletePhoto(id: string): Promise<void> {
  await withStore(
    PHOTOS,
    'readwrite',
    (store) => store.delete(id),
    'Deleting the stored trace photo failed',
  );
}

/** Lists the ids of all stored trace photos, for garbage collection. */
export async function listPhotoIds(): Promise<string[]> {
  const keys = await withStore<IDBValidKey[]>(
    PHOTOS,
    'readonly',
    (store) => store.getAllKeys(),
    'Listing the stored trace photos failed',
  );
  return keys.map((key) => String(key));
}
