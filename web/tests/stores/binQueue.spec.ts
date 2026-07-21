import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// The store's persist path fans out to IndexedDB-backed stores and the geometry
// worker, none of which exist in the node test environment. They are mocked to
// no-ops so the tests exercise only the plan mutations themselves.
vi.mock('../../src/workerClient', () => ({ releaseCutoutModels: () => Promise.resolve() }));
vi.mock('../../src/photoStore', () => ({
  listPhotoIds: () => Promise.resolve([]),
  deletePhoto: () => Promise.resolve(),
}));
vi.mock('../../src/modelStore', () => ({
  listModelIds: () => Promise.resolve([]),
  deleteModel: () => Promise.resolve(),
}));
vi.mock('../../src/solidStore', () => ({
  listSolidRecordKeys: () => Promise.resolve([]),
  deleteSolidRecord: () => Promise.resolve(),
}));

// A minimal in-memory localStorage so the store's persist path writes rather
// than logging a ReferenceError in the node environment.
const memoryStore = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStore.set(k, v),
  removeItem: (k: string) => void memoryStore.delete(k),
  clear: () => memoryStore.clear(),
});

import { useBinQueue } from '../../src/stores/binQueue';
import type {
  BaseplateProduct,
  DrawerFillInput,
  DrawerPlateOptions,
} from '../../src/engine/plan/types';
import type { DrawerFillPlate } from '../../src/engine/baseplate/drawerFill';

const INPUT: DrawerFillInput = {
  drawerWidthMm: 470,
  drawerDepthMm: 300,
  plateWidthMm: 470,
  plateDepthMm: 300,
};

const OPTIONS: DrawerPlateOptions = { magnets: null, screwHoles: false, connectable: false };

function plannerPlates(): DrawerFillPlate[] {
  return [
    { unitsX: 3, unitsY: 2, brim: { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6 }, column: 0, row: 0 },
    { unitsX: 3, unitsY: 2, brim: { leftMm: 0, rightMm: 4, frontMm: 0, backMm: 6 }, column: 1, row: 0 },
  ];
}

/** A queue entry's baseplate group link, or undefined when it is not a linked plate. */
function linkOf(product: unknown): { groupId: string; plateIds: string[] } | undefined {
  const p = product as BaseplateProduct;
  return p.kind === 'baseplate' ? p.group : undefined;
}

describe('binQueue drawer groups', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // Each test starts from an empty plan; the store loads localStorage which
    // does not exist in node, so it starts empty by catch anyway, but reset the
    // arrays explicitly to be independent of load order.
    const store = useBinQueue();
    store.entries = [];
    store.batches = [];
    store.groups = [];
  });

  it('adds a drawer group and queues one linked plate per planned plate', () => {
    const store = useBinQueue();
    const problem = store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer');
    expect(problem).toBeNull();
    expect(store.groups).toHaveLength(1);
    expect(store.entries).toHaveLength(2);
    const id = store.groups[0].id;
    const group = store.groupById(id)!;
    expect(group.payload.plates).toHaveLength(2);
    // Every queued entry links back to a real plate of the group.
    for (const entry of store.entries) {
      const link = linkOf(entry.product);
      expect(link?.groupId).toBe(id);
      // The row's quantity equals its plate set, and every id resolves to a plate.
      expect(entry.quantity).toBe(link?.plateIds.length);
      expect(
        (link?.plateIds ?? []).every((pid) => group.payload.plates.some((p) => p.id === pid)),
      ).toBe(true);
    }
  });

  it('adds nothing when the group is invalid, leaving the plan untouched', () => {
    const store = useBinQueue();
    const badOptions: DrawerPlateOptions = {
      magnets: { diameterMm: 999, heightMm: 2 },
      screwHoles: false,
      connectable: false,
    };
    const result = store.addDrawerGroup(INPUT, badOptions, plannerPlates(), 'Bad');
    expect(result).not.toBeNull();
    expect(store.groups).toHaveLength(0);
    expect(store.entries).toHaveLength(0);
  });

  it('marks a plate done when its batch item is confirmed', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    const firstEntry = store.entries[0];
    const plateId = linkOf(firstEntry.product)!.plateIds[0];
    const batchId = store.createBatch([{ entryId: firstEntry.id, count: 1 }], 'Printer')!;
    const batch = store.batchById(batchId)!;
    store.confirmBatchItem(batchId, batch.items[0].id, 1);
    expect(store.groupById(id)!.payload.donePlateIds).toContain(plateId);
    expect(store.groupProgress(id)).toEqual({ done: 1, total: 2 });
  });

  it('marks every plate of a batch done on confirmAll', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    const batchId = store.createBatch(
      store.entries.map((e) => ({ entryId: e.id, count: 1 })),
      'Printer',
    )!;
    store.confirmAll(batchId);
    expect(store.groupProgress(id)).toEqual({ done: 2, total: 2 });
    expect(store.batchById(batchId)).toBeNull();
  });

  it('returns a failed plate to the queue with its group link intact', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    const firstEntry = store.entries[0];
    const plateId = linkOf(firstEntry.product)!.plateIds[0];
    const batchId = store.createBatch([{ entryId: firstEntry.id, count: 1 }], 'Printer')!;
    const batch = store.batchById(batchId)!;
    store.failBatchItem(batchId, batch.items[0].id);
    const requeued = store.entries.find((e) => linkOf(e.product)?.plateIds.includes(plateId));
    expect(requeued).toBeDefined();
    expect(linkOf(requeued!.product)).toEqual({ groupId: id, plateIds: [plateId] });
    // The plate is not marked done: a failed print did not print it.
    expect(store.groupProgress(id)).toEqual({ done: 0, total: 2 });
  });

  it('removeGroup removes still-queued linked entries but not batch items', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    const firstEntry = store.entries[0];
    const batchId = store.createBatch([{ entryId: firstEntry.id, count: 1 }], 'Printer')!;
    store.removeGroup(id);
    expect(store.groupById(id)).toBeNull();
    // The one plate still queued (the second) is gone; the batched plate stays.
    expect(store.entries).toHaveLength(0);
    expect(store.batchById(batchId)!.items).toHaveLength(1);
  });

  it('re-stamps still-queued plate products on a non-structural options change', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    const newOptions: DrawerPlateOptions = {
      magnets: { diameterMm: 6, heightMm: 2 },
      screwHoles: true,
      connectable: true,
    };
    const before = store.groups[0].payload.plates.map((p) => p.id);
    const problem = store.updateDrawerGroup(id, { options: newOptions });
    expect(problem).toBeNull();
    // Plates keep their ids (non-structural), but every product now carries the
    // new options.
    expect(store.groups[0].payload.plates.map((p) => p.id)).toEqual(before);
    for (const entry of store.entries) {
      const p = entry.product as BaseplateProduct;
      expect(p.magnets).toEqual({ diameterMm: 6, heightMm: 2 });
      expect(p.screwHoles).toBe(true);
      expect(p.connectable).toBe(true);
    }
  });

  it('clears progress and re-queues fresh plates on a structural edit', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    // Confirm one plate so there is progress to clear.
    const firstEntry = store.entries[0];
    const batchId = store.createBatch([{ entryId: firstEntry.id, count: 1 }], 'Printer')!;
    const batch = store.batchById(batchId)!;
    store.confirmBatchItem(batchId, batch.items[0].id, 1);
    expect(store.groupProgress(id)!.done).toBe(1);
    const oldPlateIds = new Set(store.groups[0].payload.plates.map((p) => p.id));

    const newInput: DrawerFillInput = { ...INPUT, drawerWidthMm: 260, plateWidthMm: 260 };
    const problem = store.updateDrawerGroup(id, { input: newInput });
    expect(problem).toBeNull();
    // Done list cleared, plates replaced with fresh ids, all linked entries are
    // the newly planned ones.
    expect(store.groupProgress(id)!.done).toBe(0);
    const newPlateIds = store.groups[0].payload.plates.map((p) => p.id);
    for (const pid of newPlateIds) expect(oldPlateIds.has(pid)).toBe(false);
    const queuedPlateIds = store.entries.flatMap((e) => linkOf(e.product)?.plateIds ?? []);
    expect(new Set(queuedPlateIds)).toEqual(new Set(newPlateIds));
  });

  it('requeues a single planned plate as a fresh linked entry', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    // Batch both plates so the queue is empty and every plate is "planned".
    const batchId = store.createBatch(
      store.entries.map((e) => ({ entryId: e.id, count: 1 })),
      'Printer',
    )!;
    store.confirmAll(batchId);
    expect(store.entries).toHaveLength(0);

    const plate = store.groups[0].payload.plates[0];
    const problem = store.requeueGroupPlate(id, plate.id);
    expect(problem).toBeNull();
    expect(store.entries).toHaveLength(1);
    const product = store.entries[0].product as BaseplateProduct;
    expect(product.kind).toBe('baseplate');
    expect(product.group).toEqual({ groupId: id, plateIds: [plate.id] });
    // The re-queued product inherits the group's stored options and the plate's
    // own brim.
    expect(product.brim).toEqual(plate.brim);
    expect(product.magnets).toBe(OPTIONS.magnets);
  });

  it('requeues nothing for a group or plate that does not exist', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const id = store.groups[0].id;
    expect(store.requeueGroupPlate('no-such-group', 'x')).toBeNull();
    expect(store.requeueGroupPlate(id, 'no-such-plate')).toBeNull();
    // Neither call queued anything beyond the original two plates.
    expect(store.entries).toHaveLength(2);
  });

  it('merges identical plates into one row with a quantity', () => {
    const store = useBinQueue();
    // Four plates, two of each of two specs: two distinct rows, quantity two each.
    const brimA = { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 0 };
    const brimB = { leftMm: 0, rightMm: 4, frontMm: 0, backMm: 0 };
    const plates: DrawerFillPlate[] = [
      { unitsX: 3, unitsY: 2, brim: brimA, column: 0, row: 0 },
      { unitsX: 3, unitsY: 2, brim: brimA, column: 1, row: 0 },
      { unitsX: 3, unitsY: 2, brim: brimB, column: 2, row: 0 },
      { unitsX: 3, unitsY: 2, brim: brimB, column: 3, row: 0 },
    ];
    expect(store.addDrawerGroup(INPUT, OPTIONS, plates, 'Wide drawer')).toBeNull();
    expect(store.groups[0].payload.plates).toHaveLength(4);
    expect(store.entries).toHaveLength(2);
    for (const entry of store.entries) {
      expect(entry.quantity).toBe(2);
      expect(linkOf(entry.product)!.plateIds).toHaveLength(2);
    }
  });

  it('lowering a linked row quantity trims its plate set', () => {
    const store = useBinQueue();
    const brim = { leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 };
    const plates: DrawerFillPlate[] = [
      { unitsX: 2, unitsY: 2, brim, column: 0, row: 0 },
      { unitsX: 2, unitsY: 2, brim, column: 1, row: 0 },
    ];
    expect(store.addDrawerGroup(INPUT, OPTIONS, plates, 'Drawer')).toBeNull();
    const entry = store.entries[0];
    expect(entry.quantity).toBe(2);
    expect(store.update(entry.id, { quantity: 1 })).toBeNull();
    expect(store.entries[0].quantity).toBe(1);
    expect(linkOf(store.entries[0].product)!.plateIds).toHaveLength(1);
  });

  it('refuses to raise a linked row quantity beyond its planned plates', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const entry = store.entries[0];
    expect(entry.quantity).toBe(1);
    const problem = store.update(entry.id, { quantity: 2 });
    expect(problem).not.toBeNull();
    expect(store.entries[0].quantity).toBe(1);
  });

  it('duplicating a linked row produces an unlinked standalone plate', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer')).toBeNull();
    const source = store.entries[0];
    const newId = store.duplicate(source.id)!;
    const copy = store.entries.find((e) => e.id === newId)!;
    expect(copy.product.kind).toBe('baseplate');
    expect(linkOf(copy.product)).toBeUndefined();
  });

  it('requeue merges into a matching queued row instead of adding a second', () => {
    const store = useBinQueue();
    const brim = { leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 };
    const plates: DrawerFillPlate[] = [
      { unitsX: 2, unitsY: 2, brim, column: 0, row: 0 },
      { unitsX: 2, unitsY: 2, brim, column: 1, row: 0 },
    ];
    expect(store.addDrawerGroup(INPUT, OPTIONS, plates, 'Drawer')).toBeNull();
    // One merged row of quantity two; batch one plate away so it becomes planned.
    const entry = store.entries[0];
    const batchId = store.createBatch([{ entryId: entry.id, count: 1 }], 'Printer')!;
    store.confirmAll(batchId);
    // The remaining row carries one plate; the group has one planned plate.
    const remaining = store.entries[0];
    expect(linkOf(remaining.product)!.plateIds).toHaveLength(1);
    const queuedId = linkOf(remaining.product)!.plateIds[0];
    const id = store.groups[0].id;
    const plannedPlate = store.groups[0].payload.plates.find((p) => p.id !== queuedId)!;
    expect(store.requeueGroupPlate(id, plannedPlate.id)).toBeNull();
    // Still one row, now back to quantity two.
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].quantity).toBe(2);
    expect(linkOf(store.entries[0].product)!.plateIds).toContain(plannedPlate.id);
  });
});
