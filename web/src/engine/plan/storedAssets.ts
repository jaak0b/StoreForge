import { assertNever, binOf, type PrintBatch, type Product, type QueueEntry } from './types';
import { cutoutModelKey, type CutoutModelKeySpec } from '../cutout/cutoutBin';
import { persistedSolidKeyIsFor } from '../cutout/persistedSolids';

/**
 * Garbage collection of the blobs a plan references but does not contain. Two
 * kinds live in IndexedDB stores on the main thread (src/photoStore.ts and
 * src/modelStore.ts); this module holds the pure logic deciding which of them
 * are still needed, so it can be unit tested with fake stores (IndexedDB
 * itself has no node implementation, so the thin browser wrappers stay
 * untested and this logic carries the tests).
 *
 * One traversal of the plan collects both kinds. Collecting them separately
 * would walk the same entries and batch items twice for no gain.
 */

/** The subset of one blob store the sweep needs, injectable for tests. */
export interface AssetStoreLike {
  /** Lists the ids of all stored assets. */
  listIds(): Promise<string[]>;
  /** Deletes one stored asset; deleting a missing id is a no-op. */
  deleteAsset(id: string): Promise<void>;
}

/** Every stored blob id a plan row still references, by asset kind. */
export interface ReferencedAssetIds {
  /** Trace photo ids, from bins whose interior was traced from a photo. */
  tracePhotos: Set<string>;
  /** Cutout model ids, from bins whose interior is carved by imported models. */
  cutoutModels: Set<string>;
}

/** The ids the sweep deleted, per store. */
export interface SweptAssetIds {
  tracePhotos: string[];
  cutoutModels: string[];
  /** Persisted solid record keys whose model key nothing references anymore. */
  cutoutSolids: string[];
}

/** Visits every product a plan row orders: each queue entry's and each batch item's. */
function forEachProduct(
  entries: QueueEntry[],
  batches: PrintBatch[],
  visit: (product: Product) => void,
): void {
  for (const entry of entries) visit(entry.product);
  for (const batch of batches) {
    for (const item of batch.items) visit(item.product);
  }
}

/**
 * Collects every stored asset id still referenced by a queue entry or a batch
 * item, in one traversal of the plan. An id not in the matching set belongs to
 * no plan row and can be deleted.
 *
 * Note that two bins can legitimately reference the same asset id, because
 * duplicating a queue row deep clones the product with its ids included. So
 * membership of these sets is the only correct test, and a reference count
 * would delete an asset that is still in use.
 */
export function referencedAssetIds(
  entries: QueueEntry[],
  batches: PrintBatch[],
): ReferencedAssetIds {
  const tracePhotos = new Set<string>();
  const cutoutModels = new Set<string>();
  const addProduct = (product: Product): void => {
    const bin = binOf(product);
    if (bin === null) return;
    // Switched over every origin rather than tested for the two that carry
    // assets: an origin added later that stores a blob of its own has to be
    // named here, or its blobs would be swept away as orphans.
    switch (bin.origin) {
      case 'traced':
        if (bin.traceSourceId !== undefined) tracePhotos.add(bin.traceSourceId);
        return;
      case 'cutout':
        for (const model of bin.models) cutoutModels.add(model.modelSourceId);
        return;
      case 'manual':
      case 'screw':
        return;
      default:
        return assertNever(bin);
    }
  };
  forEachProduct(entries, batches, addProduct);
  return { tracePhotos, cutoutModels };
}

/**
 * Every prepared-solid key spec the page currently references: the models the
 * open cutout editor holds plus the models of every cutout bin in a queue
 * entry or a batch item, deduplicated by their cache key.
 *
 * This is the keep-list the geometry worker's model cache retains: a cached
 * solid must stay alive while ANY reference to its model exists on the page,
 * and it goes only when the last reference does. The same membership argument
 * as the asset sweep above applies: duplicated rows share ids, so only the
 * union over every reference is a correct keep-list, never one caller's own
 * models. The swept-solid cache retains by these same keys as a prefix, so
 * nothing beyond the three key fields is needed here.
 */
export function referencedCutoutModelKeySpecs(
  entries: QueueEntry[],
  batches: PrintBatch[],
  editorModels: readonly CutoutModelKeySpec[],
): CutoutModelKeySpec[] {
  const byKey = new Map<string, CutoutModelKeySpec>();
  const add = (model: CutoutModelKeySpec): void => {
    byKey.set(cutoutModelKey(model.modelSourceId, model.unitScale, model.clearanceMm), {
      modelSourceId: model.modelSourceId,
      unitScale: model.unitScale,
      clearanceMm: model.clearanceMm,
    });
  };
  for (const model of editorModels) add(model);
  forEachProduct(entries, batches, (product) => {
    const bin = binOf(product);
    if (bin === null) return;
    // Switched over every origin, exactly as the sweep above is: an origin
    // added later that carves cached models has to be named here, or its
    // solids would be evicted while its bins still sit in the queue.
    switch (bin.origin) {
      case 'cutout':
        for (const model of bin.models) add(model);
        return;
      case 'manual':
      case 'screw':
      case 'traced':
        return;
      default:
        return assertNever(bin);
    }
  });
  return [...byKey.values()];
}

async function sweepStore(
  store: AssetStoreLike,
  referenced: Set<string>,
  protectedIds: ReadonlySet<string>,
): Promise<string[]> {
  const stored = await store.listIds();
  const orphans = stored.filter((id) => !referenced.has(id) && !protectedIds.has(id));
  // The per-record deletes are independent, so run them together rather than
  // one round trip after another.
  await Promise.all(orphans.map((id) => store.deleteAsset(id)));
  return orphans;
}

/**
 * Deletes every persisted solid record whose model key nothing references
 * anymore. The keep-list is the same referencedCutoutModelKeySpecs union the
 * worker's in-memory cache retains by, so the persisted tier and the memory
 * tier live and die by one rule. A swept record's key is its model key plus a
 * suffix, so retention matches by the model key as a prefix, exactly as the
 * worker's retainForModelKeys does for the in-memory swept solids.
 */
async function sweepSolidStore(
  store: AssetStoreLike,
  keepModelKeys: string[],
): Promise<string[]> {
  const stored = await store.listIds();
  const orphans = stored.filter((key) => !persistedSolidKeyIsFor(key, keepModelKeys));
  // The per-record deletes are independent, so run them together rather than
  // one round trip after another.
  await Promise.all(orphans.map((key) => store.deleteAsset(key)));
  return orphans;
}

/**
 * Deletes every stored asset whose id no plan row references anymore, and
 * returns the ids that were deleted, per store. Runs after plan mutations and
 * once on app start (to catch assets orphaned by an interrupted session).
 *
 * `protectedIds` names assets that are held live by an editor and are
 * deliberately not referenced by any plan row yet. This is what makes an
 * upload in progress safe: a cutout model has to be stored before the bin that
 * references it is queued, because the carve preview needs the bytes long
 * before the bin is saved, and a plan mutation in between would otherwise
 * sweep the blob away microseconds after it was written. Asset ids are unique
 * across both kinds, so one set covers both stores.
 *
 * `editorModels` are the key specs the open cutout editor holds, for the
 * persisted solid sweep: a solid computed for a model being edited must
 * survive the sweep before the bin referencing it is queued, which is the
 * same reasoning protectedIds encodes for the model blobs.
 */
export async function sweepOrphanAssets(
  stores: { photos: AssetStoreLike; models: AssetStoreLike; solids: AssetStoreLike },
  entries: QueueEntry[],
  batches: PrintBatch[],
  protectedIds: ReadonlySet<string> = new Set(),
  editorModels: readonly CutoutModelKeySpec[] = [],
): Promise<SweptAssetIds> {
  const referenced = referencedAssetIds(entries, batches);
  const keepModelKeys = referencedCutoutModelKeySpecs(entries, batches, editorModels).map(
    (spec) => cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm),
  );
  // The three store sweeps are independent, so run them together. Every sweep
  // still runs to completion even when another fails, and every store's error
  // is collected and surfaced as one thrown error, so no failure is swallowed
  // and the caller (binQueue) logs the lot in its single catch.
  const results = await Promise.allSettled([
    sweepStore(stores.photos, referenced.tracePhotos, protectedIds),
    sweepStore(stores.models, referenced.cutoutModels, protectedIds),
    sweepSolidStore(stores.solids, keepModelKeys),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) =>
      result.reason instanceof Error ? result.reason.message : String(result.reason),
    );
  if (failures.length > 0) {
    throw new Error(failures.join(' '));
  }
  const [tracePhotos, cutoutModels, cutoutSolids] = results.map(
    (result) => (result as PromiseFulfilledResult<string[]>).value,
  );
  return { tracePhotos, cutoutModels, cutoutSolids };
}
