/**
 * IndexedDB store for the uploaded cutout model files, keyed by a cutout
 * model's modelSourceId. STL files are multi-megabyte blobs, so they live here
 * instead of the localStorage plan; a missing model is a normal condition (the
 * plan was imported from another device), not an error, and the app offers to
 * locate the file again rather than discarding the bin.
 *
 * What is stored is the uploaded file exactly as it arrived, never the
 * simplified solid and never the dilated cutter. Simplification tolerance is
 * derived from the clearance, so storing a processed solid would simplify an
 * already simplified mesh on every clearance change and the errors would add
 * up; re-parsing the original costs milliseconds against a clearance offset
 * measured in seconds. The original bytes are also what a re-import has to
 * reproduce.
 *
 * The database connection belongs to src/idb.ts, which every blob store
 * shares. Node has no IndexedDB, so this wrapper stays untested; the
 * garbage-collection logic around it lives in engine/plan/storedAssets.ts and
 * is tested with a fake store.
 */

import { makeBlobStore, MODEL_STORE } from './idb';

interface ModelRecord {
  id: string;
  model: Blob;
  createdAt: string;
}

const models = makeBlobStore<Blob, ModelRecord>({
  binding: { name: MODEL_STORE, openFailure: 'Opening the model storage failed' },
  putFailure: 'Storing the cutout model failed',
  getFailure: 'Reading the stored cutout model failed',
  deleteFailure: 'Deleting the stored cutout model failed',
  listFailure: 'Listing the stored cutout models failed',
  toRecord: (id, model) => ({ id, model, createdAt: new Date().toISOString() }),
  fromRecord: (record) => record.model,
});

/** Stores (or replaces) the uploaded model file under its model source id. */
export function putModel(id: string, model: Blob): Promise<void> {
  return models.put(id, model);
}

/**
 * Loads a stored model file. Returns null when no model is stored under the
 * id, which is the normal case for plans imported from another device.
 */
export function getModel(id: string): Promise<Blob | null> {
  return models.get(id);
}

/** Deletes a stored model file. Deleting a missing id is a no-op. */
export function deleteModel(id: string): Promise<void> {
  return models.delete(id);
}

/** Lists the ids of all stored model files, for garbage collection. */
export function listModelIds(): Promise<string[]> {
  return models.listIds();
}
