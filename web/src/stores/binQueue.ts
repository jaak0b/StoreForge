import { defineStore } from 'pinia';
import type {
  BaseplateProduct,
  DrawerFillInput,
  DrawerPlate,
  DrawerPlateOptions,
  Group,
  PrintBatch,
  Product,
  QueueEntry,
  QueueEntryUpdate,
} from '../engine/plan/types';
import {
  isPositiveInteger,
  mergeBatches,
  mergeEntries,
  mergeGroups,
  parsePlanFile,
  repairGroupLinks,
  serializePlanFile,
  validateGroup,
  validateProduct,
} from '../engine/plan/planFile';
import {
  drawerFillClipCount,
  planDrawerFill,
  type DrawerFillPlate,
} from '../engine/baseplate/drawerFill';
import { CLIP_TOLERANCE_DEFAULT, type BaseplateBrim } from '../engine/baseplate/constants';
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

/** Whether two plate brims are equal on all four sides. */
function brimEqual(a: BaseplateBrim, b: BaseplateBrim): boolean {
  return (
    a.leftMm === b.leftMm &&
    a.rightMm === b.rightMm &&
    a.frontMm === b.frontMm &&
    a.backMm === b.backMm
  );
}

/**
 * The stable spec key of a drawer plate: its cell size and brim. Plates that
 * share a key are interchangeable (the group's shared options are the same for
 * all), so they merge into one queue row. Options are not part of the key
 * because they are group-wide.
 */
function plateSpecKey(plate: Pick<DrawerPlate, 'unitsX' | 'unitsY' | 'brim'>): string {
  const b = plate.brim;
  return `${plate.unitsX}x${plate.unitsY}:${b.leftMm},${b.rightMm},${b.frontMm},${b.backMm}`;
}

/**
 * Builds the BaseplateProduct that stands for a set of interchangeable drawer
 * plates: the group's shared options for the full cells, the shared brim and
 * cell size (the plates all share a spec), and the backlink carrying every
 * plate's id. The single place plates become a product, so the initial
 * queueing, a later options re-stamp and a requeue agree. plates is non-empty
 * and every plate shares plateSpecKey.
 */
function baseplateProductForPlates(
  plates: DrawerPlate[],
  options: DrawerPlateOptions,
  groupId: string,
): BaseplateProduct {
  const spec = plates[0];
  return {
    kind: 'baseplate',
    unitsX: spec.unitsX,
    unitsY: spec.unitsY,
    magnets: options.magnets,
    screwHoles: options.screwHoles,
    connectable: options.connectable,
    brim: spec.brim,
    group: { groupId, plateIds: plates.map((plate) => plate.id) },
  };
}

/**
 * Builds one queue entry per distinct plate spec: identical plates collapse to
 * a single row whose quantity is how many of them there are and whose link
 * carries all their ids. Insertion order follows the plates' order, so the
 * first plate of each spec fixes that spec's row position.
 */
function linkedEntriesForPlates(
  plates: DrawerPlate[],
  options: DrawerPlateOptions,
  groupId: string,
  now: string,
): QueueEntry[] {
  const bySpec = new Map<string, DrawerPlate[]>();
  for (const plate of plates) {
    const key = plateSpecKey(plate);
    const bucket = bySpec.get(key);
    if (bucket === undefined) bySpec.set(key, [plate]);
    else bucket.push(plate);
  }
  return [...bySpec.values()].map((specPlates) => ({
    id: crypto.randomUUID(),
    quantity: specPlates.length,
    createdAt: now,
    product: baseplateProductForPlates(specPlates, options, groupId),
  }));
}

/**
 * The connection-clip plan for a drawer's plates: the clip count (from the
 * shared connector-slot rule, never a local guess) and the linked clip row that
 * stands for it, or nulls when the drawer is not connectable or its plates need
 * no clips. The single place a drawer's clips become a queue row, so the initial
 * queueing and every re-plan agree.
 */
function planDrawerClips(
  plates: DrawerPlate[],
  connectable: boolean,
  toleranceMm: number,
  groupId: string,
  now: string,
): { clips: { count: number; toleranceMm: number } | null; entry: QueueEntry | null } {
  const count = connectable ? drawerFillClipCount(plates) : 0;
  if (count === 0) return { clips: null, entry: null };
  return {
    clips: { count, toleranceMm },
    entry: {
      id: crypto.randomUUID(),
      quantity: count,
      createdAt: now,
      product: { kind: 'clip', toleranceMm, group: { groupId } },
    },
  };
}

/** Whether two drawer-fill inputs differ on any of their four mm fields. */
function inputChanged(a: DrawerFillInput, b: DrawerFillInput): boolean {
  return (
    a.drawerWidthMm !== b.drawerWidthMm ||
    a.drawerDepthMm !== b.drawerDepthMm ||
    a.plateWidthMm !== b.plateWidthMm ||
    a.plateDepthMm !== b.plateDepthMm
  );
}

function loadPlan(): { entries: QueueEntry[]; batches: PrintBatch[]; groups: Group[] } {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error('Reading the stored plan failed.', error);
    return { entries: [], batches: [], groups: [] };
  }
  if (text === null) return { entries: [], batches: [], groups: [] };
  const result = parsePlanFile(text);
  if (!result.ok) {
    console.error(`The stored plan could not be read: ${result.error}`);
    return { entries: [], batches: [], groups: [] };
  }
  for (const warning of result.warnings) console.warn(warning);
  return {
    entries: result.plan.entries,
    batches: result.plan.batches,
    groups: result.plan.groups,
  };
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
    groupById: (state) => (id: string) => state.groups.find((g) => g.id === id) ?? null,
    /**
     * A group's print progress as done and total plate counts, derived from
     * its donePlateIds against its plates. Null when no such group exists.
     */
    groupProgress: (state) => (id: string): { done: number; total: number } | null => {
      const group = state.groups.find((g) => g.id === id);
      if (group === undefined) return null;
      return { done: group.payload.donePlateIds.length, total: group.payload.plates.length };
    },
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
        localStorage.setItem(
          STORAGE_KEY,
          serializePlanFile(this.entries, this.batches, this.groups),
        );
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
      // A linked drawer-plate row's quantity is bound to its plate set: lowering
      // it trims the trailing plate ids (those plates become planned again, and
      // can be re-queued from the drawer view); raising it past the linked plate
      // count is refused, since a new slot has to come from the drawer, not from
      // an arbitrary quantity bump.
      if (updated.product.kind === 'baseplate' && updated.product.group !== undefined) {
        const link = updated.product.group;
        if (updated.quantity > link.plateIds.length) {
          return 'This is a drawer plate row, so its quantity is set by the drawer plan. Open the drawer to queue more of its plates.';
        }
        if (updated.quantity < link.plateIds.length) {
          updated.product = {
            ...updated.product,
            group: { groupId: link.groupId, plateIds: link.plateIds.slice(0, updated.quantity) },
          };
        }
      }
      const problem = validateQueueMutation(updated.product, updated.quantity);
      if (problem !== null) return problem;
      this.entries[index] = updated;
      this.persist();
      return null;
    },
    /**
     * Duplicates an entry as a fresh copy. A drawer-linked plate row duplicates
     * to an UNLINKED standalone baseplate: a duplicate has no slot in the
     * drawer plan, so it keeps the plate's geometry but drops the group link
     * (and with it the plateIds bookkeeping). Returns the new id.
     */
    duplicate(id: string): string | null {
      const source = this.entryById(id);
      if (source === null) return null;
      const product = JSON.parse(JSON.stringify(source.product)) as Product;
      // A drawer-linked plate or clip duplicates to an unlinked standalone copy:
      // a duplicate has no place in the drawer plan, so it keeps the geometry but
      // drops the group link.
      if (
        (product.kind === 'baseplate' || product.kind === 'clip') &&
        product.group !== undefined
      ) {
        delete product.group;
      }
      const copy: QueueEntry = {
        ...source,
        product,
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
      const result = confirmBatchItem(batch, itemId, amount);
      this.batches = result.batch === null
        ? this.batches.filter((b) => b.id !== batchId)
        : this.batches.map((b) => (b.id === batchId ? result.batch! : b));
      // The confirmed plates of a drawer group count toward its progress; done
      // is null for any other product.
      if (result.done !== null) this.markGroupPlatesDone(result.done.groupId, result.done.plateIds);
      this.persist();
    },
    /** Confirms every item of a batch as fully printed; the batch disappears. */
    confirmAll(batchId: string) {
      const batch = this.batchById(batchId);
      if (batch !== null) {
        for (const item of batch.items) {
          if (item.product.kind === 'baseplate' && item.product.group !== undefined) {
            this.markGroupPlatesDone(item.product.group.groupId, item.product.group.plateIds);
          }
        }
      }
      this.batches = this.batches.filter((b) => b.id !== batchId);
      this.persist();
    },
    /**
     * Records that the given plates of a drawer group have printed, by adding
     * their ids to the group's done list. Idempotent, and skips any id that is
     * not one of the group's plates or when the group no longer exists.
     */
    markGroupPlatesDone(groupId: string, plateIds: string[]) {
      const group = this.groupById(groupId);
      if (group === null) return;
      const valid = new Set(group.payload.plates.map((plate) => plate.id));
      for (const plateId of plateIds) {
        if (valid.has(plateId) && !group.payload.donePlateIds.includes(plateId)) {
          group.payload.donePlateIds.push(plateId);
        }
      }
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
      return serializePlanFile(this.entries, this.batches, this.groups);
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
        this.groups = result.plan.groups;
      } else {
        this.entries = mergeEntries(this.entries, result.plan.entries);
        this.batches = mergeBatches(this.batches, result.plan.batches);
        this.groups = mergeGroups(this.groups, result.plan.groups);
        // A merge can drop or replace a group an existing or imported plate
        // pointed at; repair the dangling links rather than leave them.
        const warnings: string[] = [];
        repairGroupLinks(this.entries, this.batches, this.groups, warnings);
        for (const warning of warnings) console.warn(warning);
      }
      this.persist();
      return null;
    },
    /**
     * Adds a drawer group and queues one baseplate per planned plate. All or
     * nothing: the group and every plate product are validated first, and the
     * store is left untouched if any is refused, so a rejected plate never
     * leaves the drawer partially queued. Returns null on success or the
     * user-worded problem. plannerPlates come from planDrawerFill; each
     * plate's brim is the planner's own, never recomputed here.
     */
    addDrawerGroup(
      input: DrawerFillInput,
      options: DrawerPlateOptions,
      plannerPlates: DrawerFillPlate[],
      name: string,
      clipToleranceMm: number = CLIP_TOLERANCE_DEFAULT,
    ): string | null {
      const groupId = crypto.randomUUID();
      const now = new Date().toISOString();
      const plates: DrawerPlate[] = plannerPlates.map((plate) => ({
        id: crypto.randomUUID(),
        unitsX: plate.unitsX,
        unitsY: plate.unitsY,
        brim: plate.brim,
        column: plate.column,
        row: plate.row,
      }));
      // Plan the clips before building the payload, so the group is stored with
      // its clip plan and the linked clip row is validated with the plates.
      const clipPlan = planDrawerClips(plates, options.connectable, clipToleranceMm, groupId, now);
      const group: Group = {
        id: groupId,
        name,
        createdAt: now,
        payload: { kind: 'drawer', input, options, plates, donePlateIds: [] },
      };
      if (clipPlan.clips !== null) group.payload.clips = clipPlan.clips;
      const groupProblem = validateGroup(group, `group ${groupId}`);
      if (groupProblem !== null) return groupProblem;
      const entries = linkedEntriesForPlates(plates, options, groupId, now);
      for (const entry of entries) {
        const problem = validateProduct(entry.product, 'A planned plate');
        if (problem !== null) return problem;
      }
      if (clipPlan.entry !== null) {
        const clipProblem = validateProduct(clipPlan.entry.product, 'The drawer connection clips');
        if (clipProblem !== null) return clipProblem;
      }
      this.groups.push(group);
      this.entries.push(...entries);
      if (clipPlan.entry !== null) this.entries.push(clipPlan.entry);
      this.persist();
      return null;
    },
    /**
     * Applies changes to a drawer group. A name or options change is
     * non-structural: the name is set and an options change re-stamps every
     * still-queued linked plate's product with the new options (its brim and
     * group link unchanged). A change to any of the four mm inputs is
     * structural: the fill is re-planned, the plates are replaced with fresh
     * ids, every still-queued linked entry is removed and the new plates are
     * re-queued.
     *
     * A structural edit is allowed even when some plates have already printed,
     * but it CLEARS the done list, because the old plate ids no longer exist:
     * progress resets to zero. The caller that wants to warn first reads
     * groupProgress before calling. All or nothing: nothing changes when the
     * re-plan fails or a new product is refused. Returns null on success or the
     * user-worded problem.
     *
     * Connection clips ride along: a structural re-plan recomputes the clip count
     * from the new plates and re-stamps the queued clip row; a non-structural
     * options change that turns connectable off removes the clip row and clears
     * the clip plan, and a clip-tolerance change re-stamps the queued clip row's
     * tolerance. The clip count comes from drawerFillClipCount, never a local
     * figure.
     */
    updateDrawerGroup(
      id: string,
      changes: {
        name?: string;
        options?: DrawerPlateOptions;
        input?: DrawerFillInput;
        clipToleranceMm?: number;
      },
    ): string | null {
      const group = this.groupById(id);
      if (group === null) return null;
      const payload = group.payload;
      // A bad clip tolerance is refused before anything is mutated, so a
      // structural or options apply never lands with the clip plan half-updated.
      if (changes.clipToleranceMm !== undefined) {
        const problem = validateProduct(
          { kind: 'clip', toleranceMm: changes.clipToleranceMm },
          'The drawer connection clips',
        );
        if (problem !== null) return problem;
      }
      const clipToleranceMm =
        changes.clipToleranceMm ?? payload.clips?.toleranceMm ?? CLIP_TOLERANCE_DEFAULT;
      // Captured before the options re-stamp below overwrites payload.options,
      // so the non-structural clip sync can tell a fresh turn-on (add a clip row)
      // from an already-connectable drawer whose clips are all on a build plate
      // (add nothing).
      const wasConnectable = payload.options.connectable;
      const structural =
        changes.input !== undefined && inputChanged(payload.input, changes.input);
      if (structural) {
        const input = changes.input!;
        const options = changes.options ?? payload.options;
        const outcome = planDrawerFill(input);
        if ('error' in outcome) return outcome.error;
        const now = new Date().toISOString();
        const newPlates: DrawerPlate[] = outcome.plates.map((plate) => ({
          id: crypto.randomUUID(),
          unitsX: plate.unitsX,
          unitsY: plate.unitsY,
          brim: plate.brim,
          column: plate.column,
          row: plate.row,
        }));
        const newEntries = linkedEntriesForPlates(newPlates, options, id, now);
        for (const entry of newEntries) {
          const problem = validateProduct(entry.product, 'A planned plate');
          if (problem !== null) return problem;
        }
        const clipPlan = planDrawerClips(newPlates, options.connectable, clipToleranceMm, id, now);
        if (clipPlan.entry !== null) {
          const problem = validateProduct(clipPlan.entry.product, 'The drawer connection clips');
          if (problem !== null) return problem;
        }
        // Drop every still-queued row this group owns (its plates and its clips),
        // then re-queue from the fresh plan; batched rows are left alone.
        this.entries = this.entries.filter(
          (entry) =>
            !(
              (entry.product.kind === 'baseplate' || entry.product.kind === 'clip') &&
              entry.product.group?.groupId === id
            ),
        );
        payload.input = input;
        payload.options = options;
        payload.plates = newPlates;
        payload.donePlateIds = [];
        if (clipPlan.clips !== null) payload.clips = clipPlan.clips;
        else delete payload.clips;
        if (changes.name !== undefined) group.name = changes.name;
        this.entries.push(...newEntries);
        if (clipPlan.entry !== null) this.entries.push(clipPlan.entry);
        this.persist();
        return null;
      }
      // Non-structural: build any re-stamped products first, validate them all,
      // and only then apply, so a refused options change leaves the group as it
      // was.
      if (changes.options !== undefined) {
        const options = changes.options;
        const restamped: { entry: QueueEntry; product: BaseplateProduct }[] = [];
        for (const entry of this.entries) {
          if (entry.product.kind !== 'baseplate' || entry.product.group?.groupId !== id) continue;
          // Re-stamp the shared options only: the plate set (group.plateIds),
          // the cell size and the brim stay exactly as they were.
          const product: BaseplateProduct = {
            ...entry.product,
            magnets: options.magnets,
            screwHoles: options.screwHoles,
            connectable: options.connectable,
          };
          const problem = validateProduct(product, 'A planned plate');
          if (problem !== null) return problem;
          restamped.push({ entry, product });
        }
        payload.options = options;
        for (const { entry, product } of restamped) entry.product = product;
      }
      // Sync the clips whenever the options or the clip tolerance were touched.
      // The plates do not change here, so the count is stable: turning connectable
      // off removes the clip row, turning it on adds one at the full count, and a
      // tolerance change re-stamps the queued row without disturbing its quantity
      // (which a batch may have already reduced).
      if (changes.options !== undefined || changes.clipToleranceMm !== undefined) {
        const connectable = payload.options.connectable;
        const count = connectable ? drawerFillClipCount(payload.plates) : 0;
        const queuedClips = this.entries.filter(
          (entry) => entry.product.kind === 'clip' && entry.product.group?.groupId === id,
        );
        if (count === 0) {
          this.entries = this.entries.filter(
            (entry) => !(entry.product.kind === 'clip' && entry.product.group?.groupId === id),
          );
          delete payload.clips;
        } else {
          payload.clips = { count, toleranceMm: clipToleranceMm };
          if (queuedClips.length > 0) {
            for (const entry of queuedClips) {
              if (entry.product.kind === 'clip') {
                entry.product = { ...entry.product, toleranceMm: clipToleranceMm };
              }
            }
          } else if (!wasConnectable) {
            // Connectable was just turned on, so no clip row existed anywhere:
            // add a fresh full-count row. When it was already on but no row is
            // queued (every clip is on a build plate), nothing is added: those
            // clips are already accounted for in a batch.
            this.entries.push({
              id: crypto.randomUUID(),
              quantity: count,
              createdAt: new Date().toISOString(),
              product: { kind: 'clip', toleranceMm: clipToleranceMm, group: { groupId: id } },
            });
          }
        }
      }
      if (changes.name !== undefined) group.name = changes.name;
      this.persist();
      return null;
    },
    /**
     * Re-queues a single planned plate of a drawer group. When a queued row
     * already carries an interchangeable plate (same group, same cell size and
     * brim), the plate merges into it (its id is appended and the row's quantity
     * grows); otherwise a fresh one-plate row is added. Both paths build the
     * product from the group's stored options and the plate's own brim, so the
     * queue never grows a second row for a spec it already lists. Use it to
     * order a plate the group planned but that has no queue row or batch item
     * anymore (a planned plate, or one that printed and was confirmed). Returns
     * null on success, or the user-worded problem with nothing queued; null too
     * when the group or plate no longer exists, or the plate is already queued.
     */
    requeueGroupPlate(groupId: string, plateId: string): string | null {
      const group = this.groupById(groupId);
      if (group === null) return null;
      if (group.payload.kind !== 'drawer') return null;
      const plate = group.payload.plates.find((p) => p.id === plateId);
      if (plate === undefined) return null;
      const options = group.payload.options;
      // A plate already carried by some queued row must not be queued twice.
      const alreadyQueued = this.entries.some(
        (entry) =>
          entry.product.kind === 'baseplate' &&
          entry.product.group?.groupId === groupId &&
          entry.product.group.plateIds.includes(plateId),
      );
      if (alreadyQueued) return null;
      // Merge into a matching queued row when one exists, keeping quantity in
      // step with the plate set.
      const match = this.entries.find(
        (entry) =>
          entry.product.kind === 'baseplate' &&
          entry.product.group?.groupId === groupId &&
          entry.product.unitsX === plate.unitsX &&
          entry.product.unitsY === plate.unitsY &&
          brimEqual(entry.product.brim ?? plate.brim, plate.brim),
      );
      if (match !== undefined && match.product.kind === 'baseplate' && match.product.group) {
        const plateIds = [...match.product.group.plateIds, plateId];
        match.product = { ...match.product, group: { groupId, plateIds } };
        match.quantity = plateIds.length;
        this.persist();
        return null;
      }
      const product = baseplateProductForPlates([plate], options, groupId);
      const problem = validateProduct(product, 'A planned plate');
      if (problem !== null) return problem;
      this.entries.push({
        id: crypto.randomUUID(),
        quantity: 1,
        createdAt: new Date().toISOString(),
        product,
      });
      this.persist();
      return null;
    },
    /** Renames a group. */
    renameGroup(id: string, name: string) {
      const group = this.groupById(id);
      if (group === null) return;
      group.name = name;
      this.persist();
    },
    /**
     * Removes a group and every still-queued plate that belongs to it. Batch
     * items are left alone: a plate already sent to a printer keeps its
     * snapshot, and its group link simply stops resolving, which the load-time
     * repair strips the next time the plan is read.
     */
    removeGroup(id: string) {
      this.groups = this.groups.filter((g) => g.id !== id);
      this.entries = this.entries.filter(
        (entry) =>
          !(
            (entry.product.kind === 'baseplate' || entry.product.kind === 'clip') &&
            entry.product.group?.groupId === id
          ),
      );
      this.persist();
    },
  },
});
