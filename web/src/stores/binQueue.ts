import { defineStore } from 'pinia';
import type {
  PrintBatch,
  Product,
  QueueEntry,
  QueueEntryUpdate,
} from '../engine/plan/types';
import {
  isPositiveInteger,
  mergeBatches,
  mergeEntries,
  parsePlanFile,
  serializePlanFile,
  validateProduct,
} from '../engine/plan/planFile';
import {
  confirmBatchItem,
  createBatch,
  failBatchItem,
  type BatchSelection,
} from '../engine/plan/batches';
import {
  referencedCutoutModelKeySpecs,
  sweepOrphanAssets,
} from '../engine/plan/storedAssets';
import { deletePhoto, listPhotoIds } from '../photoStore';
import { deleteModel, listModelIds } from '../modelStore';
import { deleteSolidRecord, listSolidRecordKeys } from '../solidStore';
import { releaseCutoutModels } from '../workerClient';
import { useCutout } from './cutout';

const STORAGE_KEY = 'storeforge.plan';

/**
 * Checks a product and quantity with the plan file's own validators before an
 * interactive queue mutation. Returns null when valid, otherwise the
 * user-worded message the mutation hands back to the form.
 */
function validateQueueMutation(product: Product, quantity: number): string | null {
  if (!isPositiveInteger(quantity, 1)) {
    return 'The quantity must be a whole number of at least 1.';
  }
  return validateProduct(product, 'This design');
}

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
  state: () => ({
    ...loadPlan(),
    /**
     * Ids of the cutout models this device holds, or null until the model
     * store has been read once. Null and empty mean different things: empty
     * says this device holds no models, so every cutout bin is missing its
     * files, while null says the question has not been answered yet, and no
     * row may claim a model is missing before it has been.
     */
    storedModelIds: null as string[] | null,
    /**
     * Cutout model ids an editor holds live, before any plan row references
     * them. A model file has to reach the store before the bin that uses it is
     * queued, because the carve preview needs the bytes long before the bin is
     * saved; without this list the sweep below would delete such a blob on the
     * very next plan mutation, silently and asynchronously.
     */
    protectedModelIds: [] as string[],
  }),
  getters: {
    queuedCount: (state) => state.entries.length,
    entryById: (state) => (id: string) => state.entries.find((e) => e.id === id) ?? null,
    batchById: (state) => (id: string) => state.batches.find((b) => b.id === id) ?? null,
    /**
     * The stored cutout model ids as a set for row descriptions, or undefined
     * while the model store has not been read.
     */
    storedModelIdSet: (state): ReadonlySet<string> | undefined =>
      state.storedModelIds === null ? undefined : new Set(state.storedModelIds),
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, serializePlanFile(this.entries, this.batches));
      } catch (error) {
        console.error('Saving the plan failed.', error);
      }
      // Every plan mutation runs through here, so this is the single place
      // where stored blobs that no plan row references anymore are cleaned up
      // (fire and forget; a failed sweep only leaves blobs behind).
      void this.sweepStoredAssets();
      // The worker's prepared cutout solids follow the same lifecycle as the
      // blobs: a mutation that removed the last reference to a model is what
      // releases its solid.
      this.retainCutoutWorkerCache();
    },
    /**
     * Keeps the geometry worker's cached cutout solids in step with what the
     * page still references. A prepared solid stays alive while the open
     * cutout editor holds its model OR any queue entry or batch item still
     * orders a bin carved by it; only losing the last reference releases it,
     * so re-opening a queued bin never repeats its import. Runs on every plan
     * mutation (through persist) and whenever the editor's held models change.
     */
    retainCutoutWorkerCache() {
      void releaseCutoutModels(
        referencedCutoutModelKeySpecs(this.entries, this.batches, useCutout().models),
      );
    },
    /**
     * Deletes stored trace photos and cutout models no queue entry or batch
     * item references anymore. Runs after every plan mutation and once on app
     * start (to catch blobs orphaned by an interrupted session). Models an
     * editor is still holding are protected, so an upload that has not been
     * queued yet survives.
     */
    async sweepStoredAssets() {
      try {
        await sweepOrphanAssets(
          {
            photos: { listIds: listPhotoIds, deleteAsset: deletePhoto },
            models: { listIds: listModelIds, deleteAsset: deleteModel },
            // The persisted cutout solids follow their model references, so
            // the sweep that deletes an orphaned model file also deletes the
            // solids computed from it.
            solids: { listIds: listSolidRecordKeys, deleteAsset: deleteSolidRecord },
          },
          this.entries,
          this.batches,
          new Set(this.protectedModelIds),
          useCutout().models,
        );
      } catch (error) {
        console.error('Cleaning up stored trace photos and cutout models failed.', error);
      }
      await this.refreshStoredModelIds();
    },
    /**
     * Reads which cutout models this device holds, so plan rows can say which
     * bins arrived without their model files.
     */
    async refreshStoredModelIds() {
      try {
        this.storedModelIds = await listModelIds();
      } catch (error) {
        console.error('Reading the stored cutout models failed.', error);
      }
    },
    /**
     * Marks a freshly stored cutout model as held by an editor, so the sweep
     * leaves it alone until a plan row references it. Call this before storing
     * the file, never after queueing the bin.
     */
    protectModel(id: string) {
      if (!this.protectedModelIds.includes(id)) this.protectedModelIds.push(id);
    },
    /** Drops an editor's hold on a stored cutout model, once the bin is saved or discarded. */
    releaseModel(id: string) {
      this.protectedModelIds = this.protectedModelIds.filter((held) => held !== id);
    },
    /**
     * Adds a new queued entry ordering the given product. Every interactive
     * add lands here, so this is the single place an invalid product or
     * quantity is refused before it can be persisted; the file importer's
     * validator is reused so the queue and the file format cannot disagree.
     * Returns null on success or the user-worded problem, in which case the
     * queue is not touched.
     */
    add(product: Product, quantity = 1, notes?: string): string | null {
      const problem = validateQueueMutation(product, quantity);
      if (problem !== null) return problem;
      const entry: QueueEntry = {
        id: crypto.randomUUID(),
        quantity,
        createdAt: new Date().toISOString(),
        product,
      };
      if (notes !== undefined && notes !== '') entry.notes = notes;
      this.entries.push(entry);
      this.persist();
      return null;
    },
    /**
     * Applies partial changes to an existing entry. The product is replaced
     * wholesale when given (the sync-safe way to edit a discriminated union);
     * id and createdAt never change. Validates like add and returns null on
     * success or the user-worded problem, leaving the entry unchanged.
     */
    update(id: string, changes: QueueEntryUpdate): string | null {
      const index = this.entries.findIndex((e) => e.id === id);
      if (index === -1) return null;
      const updated = { ...this.entries[index], ...changes };
      const problem = validateQueueMutation(updated.product, updated.quantity);
      if (problem !== null) return problem;
      this.entries[index] = updated;
      this.persist();
      return null;
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
