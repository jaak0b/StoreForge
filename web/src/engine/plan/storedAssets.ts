import { assertNever, binOf, type PrintBatch, type Product, type QueueEntry } from './types';

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
  for (const entry of entries) addProduct(entry.product);
  for (const batch of batches) {
    for (const item of batch.items) addProduct(item.product);
  }
  return { tracePhotos, cutoutModels };
}

async function sweepStore(
  store: AssetStoreLike,
  referenced: Set<string>,
  protectedIds: ReadonlySet<string>,
): Promise<string[]> {
  const stored = await store.listIds();
  const orphans = stored.filter((id) => !referenced.has(id) && !protectedIds.has(id));
  for (const id of orphans) {
    await store.deleteAsset(id);
  }
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
 */
export async function sweepOrphanAssets(
  stores: { photos: AssetStoreLike; models: AssetStoreLike },
  entries: QueueEntry[],
  batches: PrintBatch[],
  protectedIds: ReadonlySet<string> = new Set(),
): Promise<SweptAssetIds> {
  const referenced = referencedAssetIds(entries, batches);
  return {
    tracePhotos: await sweepStore(stores.photos, referenced.tracePhotos, protectedIds),
    cutoutModels: await sweepStore(stores.models, referenced.cutoutModels, protectedIds),
  };
}
