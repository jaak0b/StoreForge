/**
 * IndexedDB store for the original trace photos, keyed by a traced entry's
 * traceSourceId. Photos are multi-megabyte blobs, so they live here instead
 * of the localStorage plan; a missing photo is a normal condition (the plan
 * was imported from another device), not an error.
 *
 * This is a deliberately thin hand-rolled wrapper (a dependency like idb
 * would only save the promisify helpers below). Node has no IndexedDB, so
 * the wrapper itself stays untested; the garbage-collection logic around it
 * lives in engine/plan/traceSources.ts and is tested with a fake store.
 */

const DB_NAME = 'gridfinity-generator';
const DB_VERSION = 1;
const PHOTO_STORE = 'photos';

interface PhotoRecord {
  id: string;
  photo: Blob;
  createdAt: string;
}

function requestError(request: IDBRequest | IDBOpenDBRequest): string {
  return request.error?.message ?? 'unknown IndexedDB error';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not offer IndexedDB storage.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error(`Opening the photo storage failed (${requestError(request)}).`));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  failure: string,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(PHOTO_STORE, mode);
      const request = run(transaction.objectStore(PHOTO_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`${failure} (${requestError(request)}).`));
    });
  } finally {
    db.close();
  }
}

/** Stores (or replaces) the original photo of a trace under its source id. */
export async function putPhoto(id: string, photo: Blob): Promise<void> {
  const record: PhotoRecord = { id, photo, createdAt: new Date().toISOString() };
  await withStore('readwrite', (store) => store.put(record), 'Storing the trace photo failed');
}

/**
 * Loads a stored trace photo. Returns null when no photo is stored under the
 * id, which is the normal case for plans imported from another device.
 */
export async function getPhoto(id: string): Promise<Blob | null> {
  const record = await withStore<PhotoRecord | undefined>(
    'readonly',
    (store) => store.get(id) as IDBRequest<PhotoRecord | undefined>,
    'Reading the stored trace photo failed',
  );
  return record?.photo ?? null;
}

/** Deletes a stored trace photo. Deleting a missing id is a no-op. */
export async function deletePhoto(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id), 'Deleting the stored trace photo failed');
}

/** Lists the ids of all stored trace photos, for garbage collection. */
export async function listPhotoIds(): Promise<string[]> {
  const keys = await withStore<IDBValidKey[]>(
    'readonly',
    (store) => store.getAllKeys(),
    'Listing the stored trace photos failed',
  );
  return keys.map((key) => String(key));
}
