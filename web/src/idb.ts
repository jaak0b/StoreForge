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
 * Version 1 held only the trace photos. Version 2 adds the cutout models.
 * Version 3 adds the persisted cutout solids. The upgrade handler creates
 * every missing store, so any upgrade path ends with all stores present.
 * This number is a minimum, not an exact target: parallel branches of the
 * app share the origin database, so the on-disk version can already be
 * newer while still missing stores. openDatabase therefore opens without
 * naming a version, accepts whatever exists on disk (a fresh install gets
 * an empty version 1 database), and when any store is missing it reopens
 * at the larger of the on-disk version plus one and this minimum so the
 * upgrade handler can create the missing stores.
 */
const DB_VERSION = 3;

/** Object store holding the original trace photos, keyed by trace source id. */
export const PHOTO_STORE = 'photos';

/** Object store holding the uploaded cutout model files, keyed by model source id. */
export const MODEL_STORE = 'models';

/**
 * Object store holding the persisted cutout solid records (clearance-offset
 * prepared models and swept cutters), keyed by their in-memory cache key.
 */
export const SOLID_STORE = 'solids';

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
 * The one live connection per JS context, opened lazily and reused across
 * requests. A cached promise means concurrent callers share a single open
 * instead of racing their own. It is invalidated (set back to null) when the
 * connection closes, when another realm starts a version upgrade, or when a
 * request against it fails, so the next call reopens a fresh connection.
 */
let connection: Promise<IDBDatabase> | null = null;

/**
 * Opens the shared database, creating every store the current version needs.
 * The failure wording comes from the calling store's binding.
 */
async function openDatabase(binding: StoreBinding): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('This browser does not offer IndexedDB storage.');
  }
  // Open without naming a version: this accepts whatever version is on disk
  // (parallel branches sharing the origin may have raised it past ours), and
  // on a fresh install it creates an empty version 1 database whose missing
  // stores the second step then creates.
  let db = await openAtVersion(binding);
  if (hasAllStores(db)) {
    return db;
  }
  // Some stores are missing, so force an upgrade above the on-disk version
  // (and at least to our own); the per-store guards create only what is missing.
  const forcedVersion = Math.max(db.version + 1, DB_VERSION);
  db.close();
  db = await openAtVersion(binding, forcedVersion);
  if (hasAllStores(db)) {
    return db;
  }
  db.close();
  throw new Error(
    `${binding.openFailure} (the database is missing an object store even after a forced upgrade).`,
  );
}

/**
 * Returns the shared connection, opening it on first use and reusing it after.
 * Every connection handed out closes itself when another realm starts an
 * upgrade, and the cache is dropped on that event, on an unexpected close, and
 * on a failed open, so a later call always reopens a healthy connection.
 */
function connect(binding: StoreBinding): Promise<IDBDatabase> {
  if (connection === null) {
    const opening = openDatabase(binding).then((db) => {
      db.onversionchange = () => {
        // Another realm is upgrading; step aside so its upgrade is not blocked,
        // and drop the cache so the next request reopens at the new version.
        db.close();
        if (connection === opening) connection = null;
      };
      db.onclose = () => {
        if (connection === opening) connection = null;
      };
      return db;
    });
    // A failed open must not poison the cache; clear it so the next call retries.
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
    connection = opening;
  }
  return connection;
}

function hasAllStores(db: IDBDatabase): boolean {
  return [PHOTO_STORE, MODEL_STORE, SOLID_STORE].every((name) =>
    db.objectStoreNames.contains(name),
  );
}

/**
 * Opens the database, wiring the shared upgrade handler. With a version it
 * requests that exact version; without one it accepts whatever exists on disk.
 * Every opened connection self-closes on a version change from another realm,
 * and a blocked upgrade rejects rather than hanging forever.
 */
function openAtVersion(binding: StoreBinding, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Guarded per store rather than per version, so any upgrade path
      // (fresh install, version 1 to 2) ends with all stores present.
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(MODEL_STORE)) {
        db.createObjectStore(MODEL_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SOLID_STORE)) {
        db.createObjectStore(SOLID_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Every connection handed out steps aside when another realm upgrades, so
      // that realm's upgrade is never blocked by a stale connection this one left
      // open. connect replaces this handler on the connection it caches to also
      // invalidate the cache.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    // An upgrade is blocked while another realm still holds an older version
    // open. Surface it as an error the caller can report rather than leaving the
    // open request pending forever; the other realm's onversionchange should
    // normally have closed it already.
    request.onblocked = () =>
      reject(
        new Error(
          `${binding.openFailure} (another tab or window is holding an older version of the database open; close the app's other tabs and retry).`,
        ),
      );
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
  const db = await connect(binding);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(binding.name, mode);
      const request = run(transaction.objectStore(binding.name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`${failure} (${requestError(request)}).`));
    });
  } catch (error) {
    // Drop the shared connection so the next call reopens; the current
    // connection may be broken (a closed database or an aborted upgrade). The
    // connection is not force-closed here because concurrent callers may still
    // be using it; it closes when the last reference is released.
    if (connection !== null) connection = null;
    throw error;
  }
}

/**
 * One blob store's failure wording and the mapping between the value a caller
 * passes and the record persisted under it. Photos and models wrap their blob
 * in a timestamped record keyed by id; the solid store persists the record as
 * it arrives, keyed by a field of its own.
 */
export interface BlobStoreConfig<TValue, TRecord> {
  /** Identity and open-failure wording of the shared object store. */
  binding: StoreBinding;
  /** Failure wording for a failed put, without the detail or the full stop. */
  putFailure: string;
  /** Failure wording for a failed get. */
  getFailure: string;
  /** Failure wording for a failed delete. */
  deleteFailure: string;
  /** Failure wording for a failed key listing. */
  listFailure: string;
  /** Builds the persisted record from the key and the caller's value. */
  toRecord(id: string, value: TValue): TRecord;
  /** Recovers the caller's value from a persisted record. */
  fromRecord(record: TRecord): TValue;
}

/** The put/get/delete/listIds quartet every blob store exposes. */
export interface BlobStore<TValue> {
  /** Stores (or replaces) a value under its key. */
  put(id: string, value: TValue): Promise<void>;
  /** Loads a value, or null when nothing is stored under the key. */
  get(id: string): Promise<TValue | null>;
  /** Deletes a value; deleting a missing key is a no-op. */
  delete(id: string): Promise<void>;
  /** Lists the keys of every stored value, for garbage collection. */
  listIds(): Promise<string[]>;
}

/**
 * Builds one blob store's CRUD quartet over the shared connection, so the
 * three stores (photos, models, solids) declare only their record mapping and
 * their wording rather than repeat the same four transactions apiece.
 */
export function makeBlobStore<TValue, TRecord>(
  config: BlobStoreConfig<TValue, TRecord>,
): BlobStore<TValue> {
  const { binding } = config;
  return {
    async put(id, value) {
      await withStore(
        binding,
        'readwrite',
        (store) => store.put(config.toRecord(id, value)),
        config.putFailure,
      );
    },
    async get(id) {
      const record = await withStore<TRecord | undefined>(
        binding,
        'readonly',
        (store) => store.get(id) as IDBRequest<TRecord | undefined>,
        config.getFailure,
      );
      return record === undefined ? null : config.fromRecord(record);
    },
    async delete(id) {
      await withStore(
        binding,
        'readwrite',
        (store) => store.delete(id),
        config.deleteFailure,
      );
    },
    async listIds() {
      const keys = await withStore<IDBValidKey[]>(
        binding,
        'readonly',
        (store) => store.getAllKeys(),
        config.listFailure,
      );
      return keys.map((key) => String(key));
    },
  };
}
