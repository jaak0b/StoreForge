import type { BinEntry, PrintBatch } from './types';

/**
 * Garbage collection of stored trace photos. The photos themselves live in an
 * IndexedDB store on the main thread (src/photoStore.ts); this module holds
 * the pure logic deciding which photos are still needed, so it can be unit
 * tested with a fake store (IndexedDB itself has no node implementation, so
 * the thin browser wrapper stays untested and this logic carries the tests).
 */

/** The subset of the photo store the sweep needs, injectable for tests. */
export interface PhotoStoreLike {
  /** Lists the ids of all stored photos. */
  listIds(): Promise<string[]>;
  /** Deletes one stored photo; deleting a missing id is a no-op. */
  deletePhoto(id: string): Promise<void>;
}

/**
 * Collects every trace photo id still referenced by a queue entry or a batch
 * item. A photo not in this set belongs to no plan row and can be deleted.
 */
export function referencedTraceSourceIds(
  entries: BinEntry[],
  batches: PrintBatch[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'traced' && entry.traceSourceId !== undefined) {
      ids.add(entry.traceSourceId);
    }
  }
  for (const batch of batches) {
    for (const item of batch.items) {
      if (item.traceSourceId !== undefined) ids.add(item.traceSourceId);
    }
  }
  return ids;
}

/**
 * Deletes every stored photo whose id no plan row references anymore, and
 * returns the ids that were deleted. Runs after plan mutations and once on
 * app start (to catch photos orphaned by an interrupted session).
 */
export async function sweepOrphanTracePhotos(
  store: PhotoStoreLike,
  entries: BinEntry[],
  batches: PrintBatch[],
): Promise<string[]> {
  const referenced = referencedTraceSourceIds(entries, batches);
  const stored = await store.listIds();
  const orphans = stored.filter((id) => !referenced.has(id));
  for (const id of orphans) {
    await store.deletePhoto(id);
  }
  return orphans;
}
