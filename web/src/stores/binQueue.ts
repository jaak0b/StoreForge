import { defineStore } from 'pinia';
import type {
  PrintBatch,
  Product,
  QueueEntry,
  QueueEntryUpdate,
} from '../engine/plan/types';
import {
  mergeBatches,
  mergeEntries,
  parsePlanFile,
  serializePlanFile,
} from '../engine/plan/planFile';
import {
  confirmBatchItem,
  createBatch,
  failBatchItem,
  type BatchSelection,
} from '../engine/plan/batches';
import { sweepOrphanTracePhotos } from '../engine/plan/traceSources';
import { deletePhoto, listPhotoIds } from '../photoStore';

const STORAGE_KEY = 'storeforge.plan';

function loadPlan(): { entries: QueueEntry[]; batches: PrintBatch[] } {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error('Reading the stored plan failed.', error);
    return { entries: [], batches: [] };
  }
  if (text === null) return { entries: [], batches: [] };
  const result = parsePlanFile(text);
  if (!result.ok) {
    console.error(`The stored plan could not be read: ${result.error}`);
    return { entries: [], batches: [] };
  }
  for (const warning of result.warnings) console.warn(warning);
  return { entries: result.plan.entries, batches: result.plan.batches };
}

/** The print plan: queue entries and print batches, persisted to localStorage. */
export const useBinQueue = defineStore('binQueue', {
  state: () => loadPlan(),
  getters: {
    queuedCount: (state) => state.entries.length,
    entryById: (state) => (id: string) => state.entries.find((e) => e.id === id) ?? null,
    batchById: (state) => (id: string) => state.batches.find((b) => b.id === id) ?? null,
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, serializePlanFile(this.entries, this.batches));
      } catch (error) {
        console.error('Saving the plan failed.', error);
      }
      // Every plan mutation runs through here, so this is the single place
      // where stored trace photos that no plan row references anymore are
      // cleaned up (fire and forget; a failed sweep only leaves photos behind).
      void this.sweepStoredPhotos();
    },
    /**
     * Deletes stored trace photos no queue entry or batch item references
     * anymore. Runs after every plan mutation and once on app start (to catch
     * photos orphaned by an interrupted session).
     */
    async sweepStoredPhotos() {
      try {
        await sweepOrphanTracePhotos(
          { listIds: listPhotoIds, deletePhoto },
          this.entries,
          this.batches,
        );
      } catch (error) {
        console.error('Cleaning up stored trace photos failed.', error);
      }
    },
    /** Adds a new queued entry ordering the given product. Returns its id. */
    add(product: Product, quantity = 1, notes?: string): string {
      const entry: QueueEntry = {
        id: crypto.randomUUID(),
        quantity,
        createdAt: new Date().toISOString(),
        product,
      };
      if (notes !== undefined && notes !== '') entry.notes = notes;
      this.entries.push(entry);
      this.persist();
      return entry.id;
    },
    /**
     * Applies partial changes to an existing entry. The product is replaced
     * wholesale when given (the sync-safe way to edit a discriminated union);
     * id and createdAt never change.
     */
    update(id: string, changes: QueueEntryUpdate) {
      const index = this.entries.findIndex((e) => e.id === id);
      if (index === -1) return;
      this.entries[index] = { ...this.entries[index], ...changes };
      this.persist();
    },
    /** Duplicates an entry as a fresh copy. Returns the new id. */
    duplicate(id: string): string | null {
      const source = this.entryById(id);
      if (source === null) return null;
      const copy: QueueEntry = {
        ...source,
        product: JSON.parse(JSON.stringify(source.product)) as Product,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      this.entries.push(copy);
      this.persist();
      return copy.id;
    },
    remove(id: string) {
      this.entries = this.entries.filter((e) => e.id !== id);
      this.persist();
    },
    /**
     * Moves the selected amounts out of the queue into a new named batch.
     * Returns the new batch id, or null when nothing was selected.
     */
    createBatch(selections: BatchSelection[], name: string): string | null {
      const result = createBatch(this.entries, selections, name, {
        batchId: crypto.randomUUID(),
        itemId: () => crypto.randomUUID(),
      });
      if (result.batch === null) return null;
      this.entries = result.entries;
      this.batches.push(result.batch);
      this.persist();
      return result.batch.id;
    },
    /** Renames a batch. */
    renameBatch(batchId: string, name: string) {
      const batch = this.batchById(batchId);
      if (batch === null) return;
      batch.name = name;
      this.persist();
    },
    /**
     * Confirms an amount of a batch item as printed; the amount leaves the
     * plan permanently. An emptied batch disappears.
     */
    confirmBatchItem(batchId: string, itemId: string, amount: number) {
      const batch = this.batchById(batchId);
      if (batch === null) return;
      const updated = confirmBatchItem(batch, itemId, amount);
      this.batches = updated === null
        ? this.batches.filter((b) => b.id !== batchId)
        : this.batches.map((b) => (b.id === batchId ? updated : b));
      this.persist();
    },
    /** Confirms every item of a batch as fully printed; the batch disappears. */
    confirmAll(batchId: string) {
      this.batches = this.batches.filter((b) => b.id !== batchId);
      this.persist();
    },
    /**
     * Marks a batch item as failed: its amount returns to the main queue
     * (to the source entry when it still exists, otherwise recreated from
     * the item's snapshot). An emptied batch disappears.
     */
    failBatchItem(batchId: string, itemId: string) {
      const batch = this.batchById(batchId);
      if (batch === null) return;
      const result = failBatchItem(this.entries, batch, itemId, () => crypto.randomUUID());
      this.entries = result.entries;
      this.batches = result.batch === null
        ? this.batches.filter((b) => b.id !== batchId)
        : this.batches.map((b) => (b.id === batchId ? result.batch! : b));
      this.persist();
    },
    /** Serializes the whole plan for the JSON export. */
    exportJson(): string {
      return serializePlanFile(this.entries, this.batches);
    },
    /**
     * Imports a plan from JSON text. Merge keeps existing entries and batches
     * and lets imported ones with the same id win; replace discards the
     * current plan. Returns null on success or a user-worded error message.
     */
    importJson(text: string, mode: 'merge' | 'replace'): string | null {
      const result = parsePlanFile(text);
      if (!result.ok) return result.error;
      for (const warning of result.warnings) console.warn(warning);
      if (mode === 'replace') {
        this.entries = result.plan.entries;
        this.batches = result.plan.batches;
      } else {
        this.entries = mergeEntries(this.entries, result.plan.entries);
        this.batches = mergeBatches(this.batches, result.plan.batches);
      }
      this.persist();
      return null;
    },
  },
});
