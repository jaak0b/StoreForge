import type { BatchItem, PrintBatch, Product, QueueEntry } from './types';

/**
 * Pure print-batch operations over the plan's entries and batches. A batch
 * item embeds a snapshot of the product, so a batch keeps working after the
 * queue entry it came from is edited or deleted; the sourceEntryId on each
 * item is only a hint for returning failed amounts to the same queue row.
 */

/** One selected queue row headed into a new batch, with the amount to take. */
export interface BatchSelection {
  /** Id of the queue entry to take copies from. */
  entryId: string;
  /** How many copies to move into the batch. Clamped to the entry's quantity. */
  count: number;
}

/** Deep JSON copy of a product, so a batch snapshot never aliases the queue row. */
export function snapshotProduct(product: Product): Product {
  return JSON.parse(JSON.stringify(product)) as Product;
}

/**
 * Stable key identifying a product design, for grouping identical products.
 * Products are plain JSON with a stable field order per kind, so the
 * serialized form is the key.
 */
export function productKey(product: Product): string {
  return JSON.stringify(product);
}

/**
 * Key identifying products that may merge into one queue row. Identical to
 * productKey except a linked baseplate's plateIds are blanked out: two rows for
 * the same drawer-plate spec differ only in which plate ids they carry, and
 * they are interchangeable, so they share a merge key and combine their plate
 * sets rather than sitting as two rows.
 */
export function mergeKey(product: Product): string {
  if (product.kind === 'baseplate' && product.group !== undefined) {
    return JSON.stringify({ ...product, group: { groupId: product.group.groupId, plateIds: [] } });
  }
  return productKey(product);
}

/** The linked-baseplate group link of a product, or null when it carries none. */
function groupLinkOf(product: Product): { groupId: string; plateIds: string[] } | null {
  return product.kind === 'baseplate' && product.group !== undefined ? product.group : null;
}

/** Result of taking an amount out of one queue entry. */
export interface TakenFromEntry {
  /** The new batch item carrying a snapshot of the taken amount. */
  item: BatchItem;
  /** The entry with the taken amount removed, or null when nothing is left. */
  remaining: QueueEntry | null;
}

/**
 * Takes an amount out of one queue entry as a new batch item: the single split
 * every path that moves queue copies into a batch goes through. The count is
 * floored to at least 1 and clamped to the entry's quantity. The item gets a
 * snapshot of the product; a linked baseplate's plate ids are split so the
 * item carries the first count ids and the remaining entry keeps the rest,
 * upholding quantity === plateIds.length on both sides. A linked clip carries
 * only its groupId, which both sides keep unchanged.
 */
export function takeFromEntry(entry: QueueEntry, count: number, itemId: string): TakenFromEntry {
  const taken = Math.min(Math.max(1, Math.floor(count)), entry.quantity);
  const product = snapshotProduct(entry.product);
  let remainingProduct = entry.product;
  if (product.kind === 'baseplate' && product.group !== undefined) {
    const link = product.group;
    product.group = { groupId: link.groupId, plateIds: link.plateIds.slice(0, taken) };
    remainingProduct = {
      ...product,
      group: { groupId: link.groupId, plateIds: link.plateIds.slice(taken) },
    };
  }
  const left = entry.quantity - taken;
  return {
    item: { id: itemId, product, count: taken, sourceEntryId: entry.id },
    remaining: left > 0 ? { ...entry, quantity: left, product: remainingProduct } : null,
  };
}

/** Result of creating a batch: the updated queue and the new batch. */
export interface CreateBatchResult {
  /** The queue with the taken amounts removed (rows emptied out are gone). */
  entries: QueueEntry[];
  /** The new batch, or null when no selection took anything. */
  batch: PrintBatch | null;
}

/**
 * Moves the selected amounts out of the queue into a new named batch. A
 * partial amount decrements the entry's quantity and leaves the remainder
 * queued; taking the full quantity removes the entry. Selections that name
 * a missing (or already emptied) entry are ignored.
 */
export function createBatch(
  entries: QueueEntry[],
  selections: BatchSelection[],
  name: string,
  ids: { batchId: string; itemId: () => string },
  createdAt: string = new Date().toISOString(),
): CreateBatchResult {
  const items: BatchItem[] = [];
  // The current state of every entry as selections take from it; an entry
  // emptied out maps to null.
  const current = new Map<string, QueueEntry | null>(entries.map((entry) => [entry.id, entry]));
  for (const selection of selections) {
    const entry = current.get(selection.entryId);
    if (entry === undefined || entry === null) continue;
    const result = takeFromEntry(entry, selection.count, ids.itemId());
    items.push(result.item);
    current.set(entry.id, result.remaining);
  }
  if (items.length === 0) return { entries, batch: null };
  const updatedEntries = entries
    .map((entry) => current.get(entry.id) ?? null)
    .filter((entry): entry is QueueEntry => entry !== null);
  return {
    entries: updatedEntries,
    batch: { id: ids.batchId, name, items, createdAt },
  };
}

/** Result of appending an entry's amount to an existing batch. */
export interface AddEntryToBatchResult {
  /** The batch with the new item appended. */
  batch: PrintBatch;
  /** The entry with the taken amount removed, or null when nothing is left. */
  remaining: QueueEntry | null;
}

/**
 * Appends one queue entry's amount to an existing batch as a new item, taken
 * exactly the way createBatch takes it (see takeFromEntry). Returns the
 * updated batch and the remaining entry; the caller replaces (or removes) the
 * entry in its queue.
 */
export function addEntryToBatch(
  batch: PrintBatch,
  entry: QueueEntry,
  count: number,
  id: string,
): AddEntryToBatchResult {
  const result = takeFromEntry(entry, count, id);
  return {
    batch: { ...batch, items: [...batch.items, result.item] },
    remaining: result.remaining,
  };
}

/** Result of confirming an amount of a batch item. */
export interface ConfirmBatchItemResult {
  /** The updated batch, or null when it emptied out. */
  batch: PrintBatch | null;
  /**
   * The group link of the plates just confirmed, when the item was a linked
   * baseplate, so the caller can mark exactly those plates done; null for any
   * other product. plateIds holds only the confirmed subset, in the item's
   * order.
   */
  done: { groupId: string; plateIds: string[] } | null;
}

/**
 * Confirms an amount of a batch item as printed. The confirmed amount leaves
 * the plan permanently; a remainder below the item's count stays in the batch.
 * For a linked baseplate item the confirmed amount's plate ids are sliced off
 * the front of the item's plate set (kept in step with its count) and returned
 * as the done link, so the group's done list records exactly those plates.
 */
export function confirmBatchItem(
  batch: PrintBatch,
  itemId: string,
  amount: number,
): ConfirmBatchItemResult {
  let done: { groupId: string; plateIds: string[] } | null = null;
  const items = batch.items
    .map((item) => {
      if (item.id !== itemId) return item;
      const confirmed = Math.min(Math.max(1, Math.floor(amount)), item.count);
      const link = groupLinkOf(item.product);
      if (link !== null) {
        done = { groupId: link.groupId, plateIds: link.plateIds.slice(0, confirmed) };
        return {
          ...item,
          count: item.count - confirmed,
          product: {
            ...item.product,
            group: { groupId: link.groupId, plateIds: link.plateIds.slice(confirmed) },
          } as Product,
        };
      }
      return { ...item, count: item.count - confirmed };
    })
    .filter((item) => item.count > 0);
  return { batch: items.length === 0 ? null : { ...batch, items }, done };
}

/** Result of failing a batch item: the updated queue and batch. */
export interface FailBatchItemResult {
  /** The queue with the failed amount returned to it. */
  entries: QueueEntry[];
  /** The updated batch, or null when the batch emptied out. */
  batch: PrintBatch | null;
}

/**
 * Marks a batch item as failed: its whole count returns to the main queue.
 * The amount is re-added to the source entry when it still exists, otherwise
 * to any entry with an identical product, otherwise a new entry is recreated
 * from the item's snapshot.
 */
export function failBatchItem(
  entries: QueueEntry[],
  batch: PrintBatch,
  itemId: string,
  newEntryId: () => string,
  createdAt: string = new Date().toISOString(),
): FailBatchItemResult {
  const item = batch.items.find((i) => i.id === itemId);
  if (item === undefined) return { entries, batch };
  const itemKey = mergeKey(item.product);
  const target =
    entries.find((entry) => entry.id === item.sourceEntryId) ??
    entries.find((entry) => mergeKey(entry.product) === itemKey);
  const itemLink = groupLinkOf(item.product);
  let updatedEntries: QueueEntry[];
  if (target !== undefined) {
    updatedEntries = entries.map((entry) => {
      if (entry.id !== target.id) return entry;
      const targetLink = groupLinkOf(entry.product);
      // Two linked rows for the same spec combine their plate sets; the plate
      // set size is the quantity, upholding the linked-entry invariant.
      if (itemLink !== null && targetLink !== null) {
        const plateIds = [...targetLink.plateIds, ...itemLink.plateIds];
        return {
          ...entry,
          quantity: plateIds.length,
          product: { ...entry.product, group: { groupId: targetLink.groupId, plateIds } } as Product,
        };
      }
      return { ...entry, quantity: entry.quantity + item.count };
    });
  } else {
    updatedEntries = [
      ...entries,
      {
        id: newEntryId(),
        quantity: item.count,
        createdAt,
        product: snapshotProduct(item.product),
      },
    ];
  }
  const items = batch.items.filter((i) => i.id !== itemId);
  return { entries: updatedEntries, batch: items.length === 0 ? null : { ...batch, items } };
}
