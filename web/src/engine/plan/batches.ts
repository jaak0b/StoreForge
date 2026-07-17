import type { LabeledBinParams } from '../gridfinity/types';
import type { BatchItem, BinEntry, BinPockets, PrintBatch } from './types';

/**
 * Pure print-batch operations over the plan's entries and batches. A batch
 * item embeds a snapshot of the bin design parameters, so a batch keeps
 * working after the queue entry it came from is edited or deleted; the
 * sourceEntryId on each item is only a hint for returning failed amounts to
 * the same queue row.
 */

/** One selected queue row headed into a new batch, with the amount to take. */
export interface BatchSelection {
  /** Id of the queue entry to take bins from. */
  entryId: string;
  /** How many bins to move into the batch. Clamped to the entry's quantity. */
  count: number;
}

/** Copies only the design parameter fields of an entry, as a snapshot. */
export function snapshotParams(entry: BinEntry): LabeledBinParams {
  return {
    gridX: entry.gridX,
    gridY: entry.gridY,
    heightUnits: entry.heightUnits,
    stackingLip: entry.stackingLip,
    magnetHoles: entry.magnetHoles,
    dividerCountX: entry.dividerCountX,
    dividerCountY: entry.dividerCountY,
    labelText: entry.labelText,
    labelText2: entry.labelText2,
    labelIcon: entry.labelIcon,
  };
}

/** Deep JSON copy of an entry's pockets, so a batch snapshot never aliases the queue row. */
export function snapshotPockets(entry: BinEntry): BinPockets | undefined {
  return entry.pockets === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(entry.pockets)) as BinPockets);
}

/** Stable key identifying a bin design, for grouping identical bins. */
export function binParamsKey(params: LabeledBinParams, pockets?: BinPockets): string {
  return JSON.stringify([
    params.gridX,
    params.gridY,
    params.heightUnits,
    params.stackingLip,
    params.magnetHoles,
    params.dividerCountX,
    params.dividerCountY,
    params.labelText,
    params.labelText2,
    params.labelIcon,
    pockets ?? null,
  ]);
}

/** Result of creating a batch: the updated queue and the new batch. */
export interface CreateBatchResult {
  /** The queue with the taken amounts removed (rows emptied out are gone). */
  entries: BinEntry[];
  /** The new batch, or null when no selection took any bins. */
  batch: PrintBatch | null;
}

/**
 * Moves the selected amounts out of the queue into a new named batch. A
 * partial amount decrements the entry's quantity and leaves the remainder
 * queued; taking the full quantity removes the entry. Selections that name
 * a missing entry are ignored.
 */
export function createBatch(
  entries: BinEntry[],
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
    const item: BatchItem = {
      id: ids.itemId(),
      params: snapshotParams(entry),
      count,
      sourceEntryId: entry.id,
    };
    const pockets = snapshotPockets(entry);
    if (pockets !== undefined) item.pockets = pockets;
    items.push(item);
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
  entries: BinEntry[];
  /** The updated batch, or null when the batch emptied out. */
  batch: PrintBatch | null;
}

/**
 * Marks a batch item as failed: its whole count returns to the main queue.
 * The amount is re-added to the source entry when it still exists, otherwise
 * to any entry with identical design parameters, otherwise a new entry is
 * recreated from the item's snapshot.
 */
export function failBatchItem(
  entries: BinEntry[],
  batch: PrintBatch,
  itemId: string,
  newEntryId: () => string,
  createdAt: string = new Date().toISOString(),
): FailBatchItemResult {
  const item = batch.items.find((i) => i.id === itemId);
  if (item === undefined) return { entries, batch };
  const itemKey = binParamsKey(item.params, item.pockets);
  const target =
    entries.find((entry) => entry.id === item.sourceEntryId) ??
    entries.find((entry) => binParamsKey(snapshotParams(entry), entry.pockets) === itemKey);
  let updatedEntries: BinEntry[];
  if (target !== undefined) {
    updatedEntries = entries.map((entry) =>
      entry.id === target.id ? { ...entry, quantity: entry.quantity + item.count } : entry,
    );
  } else {
    const recreated: BinEntry = {
      id: newEntryId(),
      ...item.params,
      quantity: item.count,
      createdAt,
    };
    if (item.pockets !== undefined) {
      recreated.pockets = JSON.parse(JSON.stringify(item.pockets)) as BinPockets;
    }
    updatedEntries = [...entries, recreated];
  }
  const items = batch.items.filter((i) => i.id !== itemId);
  return { entries: updatedEntries, batch: items.length === 0 ? null : { ...batch, items } };
}
