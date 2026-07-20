/**
 * The one owner of this app's IndexedDB connection. Two blob kinds live in the
 * same database (trace photos and cutout models), and a database has a single
 * version number, so two modules each holding their own version would drift
 * apart and corrupt each other's upgrades. Every store goes through here.
 *
 * Node has no IndexedDB, so this wrapper stays untested; the logic that decides
 * which blobs are still needed lives in engine/plan/storedAssets.ts behind an
 * injectable interface and carries the tests.
 */

const DB_NAME = 'storeforge';

/**
 * Version 1 held only the trace photos. Version 2 adds the cutout models. The
 * upgrade handler creates every missing store, so a user upgrading from
 * version 1 gains the models store and a fresh user gets both.
 */
const DB_VERSION = 2;

/** Object store holding the original trace photos, keyed by trace source id. */
export const PHOTO_STORE = 'photos';

/** Object store holding the uploaded cutout model files, keyed by model source id. */
export const MODEL_STORE = 'models';

/**
 * One store's identity plus the wording it uses when the shared database
 * cannot be opened, so each store's failures read in its own terms.
 */
export interface StoreBinding {
  /** Object store name inside the shared database. */
  name: string;
  /** Sentence stem for a failed open, without the detail or the full stop. */
  openFailure: string;
}

function requestError(request: IDBRequest | IDBOpenDBRequest): string {
  return request.error?.message ?? 'unknown IndexedDB error';
}

/**
 * Opens the shared database, creating every store the current version needs.
 * The failure wording comes from the calling store's binding.
 */
export function openDatabase(binding: StoreBinding): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not offer IndexedDB storage.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Guarded per store rather than per version, so any upgrade path
      // (fresh install, version 1 to 2) ends with both stores present.
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(MODEL_STORE)) {
        db.createObjectStore(MODEL_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error(`${binding.openFailure} (${requestError(request)}).`));
  });
}

/** Runs one request against one object store and resolves with its result. */
export async function withStore<T>(
  binding: StoreBinding,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  failure: string,
): Promise<T> {
  const db = await openDatabase(binding);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(binding.name, mode);
      const request = run(transaction.objectStore(binding.name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`${failure} (${requestError(request)}).`));
    });
  } finally {
    db.close();
  }
}
