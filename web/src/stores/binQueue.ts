import { defineStore } from 'pinia';
import {
  assertNever,
  type BinEntry,
  type BinEntryUpdate,
  type BinPockets,
  type PrintBatch,
  type ScrewSpec,
} from '../engine/plan/types';
import type { LabeledBinParams } from '../engine/gridfinity/types';

/** Kind-specific data a new queue entry is created with, by its owning tab. */
export type NewEntryDetails =
  | { kind: 'manual' }
  | { kind: 'screw'; screw: ScrewSpec }
  | { kind: 'traced'; pockets: BinPockets };
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

const STORAGE_KEY = 'gridfinity-generator.plan';

function loadPlan(): { entries: BinEntry[]; batches: PrintBatch[] } {
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
    },
    /**
     * Adds a new queued entry from designer parameters, of the kind the
     * calling tab owns. Returns its id.
     */
    add(
      params: LabeledBinParams,
      quantity = 1,
      details: NewEntryDetails = { kind: 'manual' },
    ): string {
      // labelIconPath is a transient worker-call field, never persisted.
      const { labelIconPath, dividerCountX, dividerCountY, ...shared } = params;
      void labelIconPath;
      const base = {
        id: crypto.randomUUID(),
        ...shared,
        quantity,
        createdAt: new Date().toISOString(),
      };
      let entry: BinEntry;
      switch (details.kind) {
        case 'manual':
          entry = { ...base, kind: 'manual', dividerCountX, dividerCountY };
          break;
        case 'screw':
          entry = { ...base, kind: 'screw', dividerCountX, dividerCountY, screw: details.screw };
          break;
        case 'traced':
          // The pocket generator rejects divider walls: a traced entry has none.
          entry = { ...base, kind: 'traced', pockets: details.pockets };
          break;
        default:
          entry = assertNever(details);
      }
      this.entries.push(entry);
      this.persist();
      return entry.id;
    },
    /**
     * Applies partial changes to an existing entry. The kind never changes;
     * each tab only writes the kind-specific fields it owns.
     */
    update(id: string, changes: BinEntryUpdate) {
      const index = this.entries.findIndex((e) => e.id === id);
      if (index === -1) return;
      this.entries[index] = { ...this.entries[index], ...changes } as BinEntry;
      this.persist();
    },
    /** Duplicates an entry as a fresh copy. Returns the new id. */
    duplicate(id: string): string | null {
      const source = this.entryById(id);
      if (source === null) return null;
      const copy: BinEntry = {
        ...source,
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
