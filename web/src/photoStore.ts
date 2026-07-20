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

import { makeBlobStore, PHOTO_STORE } from './idb';

interface PhotoRecord {
  id: string;
  photo: Blob;
  createdAt: string;
}

const photos = makeBlobStore<Blob, PhotoRecord>({
  binding: { name: PHOTO_STORE, openFailure: 'Opening the photo storage failed' },
  putFailure: 'Storing the trace photo failed',
  getFailure: 'Reading the stored trace photo failed',
  deleteFailure: 'Deleting the stored trace photo failed',
  listFailure: 'Listing the stored trace photos failed',
  toRecord: (id, photo) => ({ id, photo, createdAt: new Date().toISOString() }),
  fromRecord: (record) => record.photo,
});

/** Stores (or replaces) the original photo of a trace under its source id. */
export function putPhoto(id: string, photo: Blob): Promise<void> {
  return photos.put(id, photo);
}

/**
 * Loads a stored trace photo. Returns null when no photo is stored under the
 * id, which is the normal case for plans imported from another device.
 */
export function getPhoto(id: string): Promise<Blob | null> {
  return photos.get(id);
}

/** Deletes a stored trace photo. Deleting a missing id is a no-op. */
export function deletePhoto(id: string): Promise<void> {
  return photos.delete(id);
}

/** Lists the ids of all stored trace photos, for garbage collection. */
export function listPhotoIds(): Promise<string[]> {
  return photos.listIds();
}
