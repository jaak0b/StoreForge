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
 * a missing entry are ignored.
 */
export function createBatch(
  entries: QueueEntry[],
  selections: BatchSelection[],
  name: string,
  ids: { batchId: string; itemId: () => string },
  createdAt: string = new Date().toISOString(),
): CreateBatchResult {
  const items: BatchItem[] = [];
  const remaining = new Map(entries.map((entry) => [entry.id, entry.quantity]));
  for (const selection of selections) {
    const entry = entries.find((e) => e.id === selection.entryId);
    if (entry === undefined) continue;
    const count = Math.min(Math.max(1, Math.floor(selection.count)), entry.quantity);
    items.push({
      id: ids.itemId(),
      product: snapshotProduct(entry.product),
      count,
      sourceEntryId: entry.id,
    });
    remaining.set(entry.id, entry.quantity - count);
  }
  if (items.length === 0) return { entries, batch: null };
  const updatedEntries = entries
    .map((entry) => {
      const left = remaining.get(entry.id) ?? entry.quantity;
      return left === entry.quantity ? entry : { ...entry, quantity: left };
    })
    .filter((entry) => entry.quantity > 0);
  return {
    entries: updatedEntries,
    batch: { id: ids.batchId, name, items, createdAt },
  };
}

/**
 * Confirms an amount of a batch item as printed. The confirmed amount leaves
 * the plan permanently; a remainder below the item's count stays in the
 * batch. Returns the updated batch, or null when the batch emptied out.
 */
export function confirmBatchItem(
  batch: PrintBatch,
  itemId: string,
  amount: number,
): PrintBatch | null {
  const items = batch.items
    .map((item) => {
      if (item.id !== itemId) return item;
      const confirmed = Math.min(Math.max(1, Math.floor(amount)), item.count);
      return { ...item, count: item.count - confirmed };
    })
    .filter((item) => item.count > 0);
  if (items.length === 0) return null;
  return { ...batch, items };
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
  const itemKey = productKey(item.product);
  const target =
    entries.find((entry) => entry.id === item.sourceEntryId) ??
    entries.find((entry) => productKey(entry.product) === itemKey);
  let updatedEntries: QueueEntry[];
  if (target !== undefined) {
    updatedEntries = entries.map((entry) =>
      entry.id === target.id ? { ...entry, quantity: entry.quantity + item.count } : entry,
    );
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
