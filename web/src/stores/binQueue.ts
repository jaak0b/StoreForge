import { defineStore } from 'pinia';
import type { BinEntry } from '../engine/plan/types';
import type { LabeledBinParams } from '../engine/gridfinity/types';
import {
  markEntriesPrinted,
  mergeEntries,
  parsePlanFile,
  requeueEntries,
  serializePlanFile,
} from '../engine/plan/planFile';

const STORAGE_KEY = 'gridfinity-generator.plan';

function loadEntries(): BinEntry[] {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error('Reading the stored plan failed.', error);
    return [];
  }
  if (text === null) return [];
  const result = parsePlanFile(text);
  if (!result.ok) {
    console.error(`The stored plan could not be read: ${result.error}`);
    return [];
  }
  return result.plan.entries;
}

/** The print plan: every bin entry, persisted to localStorage on mutation. */
export const useBinQueue = defineStore('binQueue', {
  state: () => ({
    entries: loadEntries(),
  }),
  getters: {
    queuedCount: (state) => state.entries.filter((e) => e.status === 'queued').length,
    printedCount: (state) => state.entries.filter((e) => e.status === 'printed').length,
    entryById: (state) => (id: string) => state.entries.find((e) => e.id === id) ?? null,
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, serializePlanFile(this.entries));
      } catch (error) {
        console.error('Saving the plan failed.', error);
      }
    },
    /** Adds a new queued entry from designer parameters. Returns its id. */
    add(params: LabeledBinParams, quantity = 1): string {
      const entry: BinEntry = {
        id: crypto.randomUUID(),
        ...params,
        quantity,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      this.entries.push(entry);
      this.persist();
      return entry.id;
    },
    /** Applies partial changes to an existing entry. */
    update(id: string, changes: Partial<Omit<BinEntry, 'id'>>) {
      const index = this.entries.findIndex((e) => e.id === id);
      if (index === -1) return;
      this.entries[index] = { ...this.entries[index], ...changes };
      this.persist();
    },
    /** Duplicates an entry as a fresh queued copy. Returns the new id. */
    duplicate(id: string): string | null {
      const source = this.entryById(id);
      if (source === null) return null;
      const copy: BinEntry = {
        ...source,
        id: crypto.randomUUID(),
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      delete copy.printedAt;
      this.entries.push(copy);
      this.persist();
      return copy.id;
    },
    remove(id: string) {
      this.entries = this.entries.filter((e) => e.id !== id);
      this.persist();
    },
    /** Marks the given entries printed, stamping printedAt. */
    markPrinted(ids: Iterable<string>) {
      this.entries = markEntriesPrinted(this.entries, ids);
      this.persist();
    },
    /** Puts printed entries back in the queue (a failed print, for example). */
    requeue(ids: Iterable<string>) {
      this.entries = requeueEntries(this.entries, ids);
      this.persist();
    },
    /** Serializes the whole plan for the JSON export. */
    exportJson(): string {
      return serializePlanFile(this.entries);
    },
    /**
     * Imports a plan from JSON text. Merge keeps existing entries and lets
     * imported ones with the same id win; replace discards the current plan.
     * Returns null on success or a user-worded error message.
     */
    importJson(text: string, mode: 'merge' | 'replace'): string | null {
      const result = parsePlanFile(text);
      if (!result.ok) return result.error;
      this.entries =
        mode === 'replace'
          ? result.plan.entries
          : mergeEntries(this.entries, result.plan.entries);
      this.persist();
      return null;
    },
  },
});
