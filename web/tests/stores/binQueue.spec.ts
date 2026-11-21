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
  ConnectionClipProduct,
  DrawerFillInput,
  DrawerPlateOptions,
  Product,
} from '../../src/engine/plan/types';
import {
  drawerFillClipCount,
  type DrawerFillPlate,
} from '../../src/engine/baseplate/drawerFill';

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

const CONNECTABLE: DrawerPlateOptions = { magnets: null, screwHoles: false, connectable: true };

/** The clips a plate list needs when connectable, for asserting the queued row. */
function expectedClips(plates: DrawerFillPlate[]): number {
  return drawerFillClipCount(plates);
}

/** The store's queued clip rows linked to the given group. */
function clipRows(store: ReturnType<typeof useBinQueue>, groupId: string) {
  return store.entries.filter(
    (e) => e.product.kind === 'clip' && (e.product as ConnectionClipProduct).group?.groupId === groupId,
  );
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
    const result = store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer');
    expect(result.problem).toBeNull();
    expect(result.groupId).toBe(store.groups[0]?.id);
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
    expect(result.groupId).toBeNull();
    expect(result.problem).toEqual(expect.any(String));
    expect(store.groups).toHaveLength(0);
    expect(store.entries).toHaveLength(0);
  });

  it('marks a plate done when its batch item is confirmed', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
    const id = store.groups[0].id;
    const newOptions: DrawerPlateOptions = {
      magnets: { diameterMm: 6, heightMm: 2 },
      screwHoles: true,
      connectable: true,
    };
    const before = store.groups[0].payload.plates.map((p) => p.id);
    const problem = store.updateDrawerGroup(id, { options: newOptions });
    expect(problem).toBeNull();
    // Plates keep their ids (non-structural), but every plate product now carries
    // the new options.
    expect(store.groups[0].payload.plates.map((p) => p.id)).toEqual(before);
    for (const entry of store.entries) {
      if (entry.product.kind !== 'baseplate') continue;
      const p = entry.product;
      expect(p.magnets).toEqual({ diameterMm: 6, heightMm: 2 });
      expect(p.screwHoles).toBe(true);
      expect(p.connectable).toBe(true);
    }
    // Turning connectable on also queued the drawer's clips.
    const clips = clipRows(store, id);
    expect(clips).toHaveLength(1);
    expect(clips[0].quantity).toBe(expectedClips(plannerPlates()));
    expect(store.groups[0].payload.clips).toEqual({
      count: expectedClips(plannerPlates()),
      toleranceMm: 0,
    });
  });

  it('clears progress and re-queues fresh plates on a structural edit', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plates, 'Wide drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plates, 'Drawer').problem).toBeNull();
    const entry = store.entries[0];
    expect(entry.quantity).toBe(2);
    expect(store.update(entry.id, { quantity: 1 })).toBeNull();
    expect(store.entries[0].quantity).toBe(1);
    expect(linkOf(store.entries[0].product)!.plateIds).toHaveLength(1);
  });

  it('refuses to raise a linked row quantity beyond its planned plates', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
    const entry = store.entries[0];
    expect(entry.quantity).toBe(1);
    const problem = store.update(entry.id, { quantity: 2 });
    expect(problem).not.toBeNull();
    expect(store.entries[0].quantity).toBe(1);
  });

  it('duplicating a linked row produces an unlinked standalone plate', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
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
    expect(store.addDrawerGroup(INPUT, OPTIONS, plates, 'Drawer').problem).toBeNull();
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

describe('binQueue empty group auto-delete', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useBinQueue();
    store.entries = [];
    store.batches = [];
    store.groups = [];
  });

  it('deletes an unprinted group when its last queued row is removed', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
    const id = store.groups[0].id;
    for (const e of [...store.entries]) store.remove(e.id);
    expect(store.groupById(id)).toBeNull();
    expect(store.groups).toHaveLength(0);
  });

  it('keeps a group with printed plates when its last queued row is removed', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
    const id = store.groups[0].id;
    const first = store.entries[0];
    const batchId = store.createBatch([{ entryId: first.id, count: 1 }], 'Printer')!;
    const batch = store.batchById(batchId)!;
    store.confirmBatchItem(batchId, batch.items[0].id, 1);
    for (const e of [...store.entries]) store.remove(e.id);
    expect(store.groupById(id)).not.toBeNull();
  });

  it('keeps a group with a linked batch item when its last queued row is removed', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
    const id = store.groups[0].id;
    const first = store.entries[0];
    store.createBatch([{ entryId: first.id, count: 1 }], 'Printer');
    for (const e of [...store.entries]) store.remove(e.id);
    expect(store.groupById(id)).not.toBeNull();
  });

  it('does not auto-delete when the queue empties through print confirmation', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Top drawer').problem).toBeNull();
    const id = store.groups[0].id;
    const batchId = store.createBatch(
      store.entries.map((e) => ({ entryId: e.id, count: 1 })),
      'Printer',
    )!;
    store.confirmAll(batchId);
    expect(store.entries).toHaveLength(0);
    expect(store.groupById(id)).not.toBeNull();
    expect(store.groupProgress(id)).toEqual({ done: 2, total: 2 });
  });
});

describe('binQueue drawer connection clips', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useBinQueue();
    store.entries = [];
    store.batches = [];
    store.groups = [];
  });

  it('queues one linked clip row at the computed count and stores the plan', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, plannerPlates(), 'Top drawer', 0.1).problem).toBeNull();
    const id = store.groups[0].id;
    const count = expectedClips(plannerPlates());
    expect(count).toBeGreaterThan(0);
    const clips = clipRows(store, id);
    expect(clips).toHaveLength(1);
    expect(clips[0].quantity).toBe(count);
    expect((clips[0].product as ConnectionClipProduct).toleranceMm).toBe(0.1);
    expect(store.groups[0].payload.clips).toEqual({ count, toleranceMm: 0.1 });
  });

  it('queues no clip row when a connectable single plate has no interior edges', () => {
    const store = useBinQueue();
    const single: DrawerFillPlate[] = [
      { unitsX: 3, unitsY: 2, brim: { leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 }, column: 0, row: 0 },
    ];
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, single, 'Solo').problem).toBeNull();
    const id = store.groups[0].id;
    expect(clipRows(store, id)).toHaveLength(0);
    expect(store.groups[0].payload.clips).toBeUndefined();
  });

  it('queues no clip row for a non-connectable drawer', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, OPTIONS, plannerPlates(), 'Plain').problem).toBeNull();
    const id = store.groups[0].id;
    expect(clipRows(store, id)).toHaveLength(0);
    expect(store.groups[0].payload.clips).toBeUndefined();
  });

  it('removes the clip row and clip plan when connectable is turned off', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, plannerPlates(), 'Top drawer', 0.1).problem).toBeNull();
    const id = store.groups[0].id;
    expect(clipRows(store, id)).toHaveLength(1);
    expect(store.updateDrawerGroup(id, { options: OPTIONS })).toBeNull();
    expect(clipRows(store, id)).toHaveLength(0);
    expect(store.groups[0].payload.clips).toBeUndefined();
  });

  it('re-stamps the queued clip row tolerance without changing its quantity', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, plannerPlates(), 'Top drawer', 0).problem).toBeNull();
    const id = store.groups[0].id;
    const before = clipRows(store, id)[0];
    expect(store.updateDrawerGroup(id, { options: CONNECTABLE, clipToleranceMm: 0.2 })).toBeNull();
    const after = clipRows(store, id);
    expect(after).toHaveLength(1);
    expect((after[0].product as ConnectionClipProduct).toleranceMm).toBe(0.2);
    expect(after[0].quantity).toBe(before.quantity);
    expect(store.groups[0].payload.clips!.toleranceMm).toBe(0.2);
  });

  it('recomputes the clip count and re-stamps the clip row on a structural re-plan', () => {
    const store = useBinQueue();
    // Start with two side-by-side plates (one interior edge).
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, plannerPlates(), 'Top drawer', 0.1).problem).toBeNull();
    const id = store.groups[0].id;
    // Re-plan to a single plate: no interior edges, so the clips disappear.
    const single: DrawerFillInput = { ...INPUT, drawerWidthMm: 130, plateWidthMm: 470 };
    expect(store.updateDrawerGroup(id, { input: single, options: CONNECTABLE })).toBeNull();
    const newCount = expectedClips(
      store.groups[0].payload.plates.map((p) => ({
        unitsX: p.unitsX,
        unitsY: p.unitsY,
        brim: p.brim,
        column: p.column,
        row: p.row,
      })),
    );
    const clips = clipRows(store, id);
    if (newCount === 0) {
      expect(clips).toHaveLength(0);
      expect(store.groups[0].payload.clips).toBeUndefined();
    } else {
      expect(clips[0].quantity).toBe(newCount);
      expect(store.groups[0].payload.clips!.count).toBe(newCount);
    }
  });

  it('removeGroup removes the still-queued clip row', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, plannerPlates(), 'Top drawer', 0.1).problem).toBeNull();
    const id = store.groups[0].id;
    expect(clipRows(store, id)).toHaveLength(1);
    store.removeGroup(id);
    expect(store.entries.filter((e) => e.product.kind === 'clip')).toHaveLength(0);
  });

  it('duplicating a linked clip row produces an unlinked standalone clip', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, plannerPlates(), 'Top drawer', 0.1).problem).toBeNull();
    const id = store.groups[0].id;
    const clip = clipRows(store, id)[0];
    const newId = store.duplicate(clip.id)!;
    const copy = store.entries.find((e) => e.id === newId)!;
    expect(copy.product.kind).toBe('clip');
    expect((copy.product as ConnectionClipProduct).group).toBeUndefined();
  });

  it('confirming the clip row leaves the plan without touching plate progress', () => {
    const store = useBinQueue();
    expect(store.addDrawerGroup(INPUT, CONNECTABLE, plannerPlates(), 'Top drawer', 0.1).problem).toBeNull();
    const id = store.groups[0].id;
    const clip = clipRows(store, id)[0];
    const batchId = store.createBatch([{ entryId: clip.id, count: clip.quantity }], 'Printer')!;
    const batch = store.batchById(batchId)!;
    store.confirmBatchItem(batchId, batch.items[0].id, clip.quantity);
    // Clips left the plan; the group keeps no per-clip record and progress is
    // plate-based only.
    expect(store.groups[0].payload.donePlateIds).toHaveLength(0);
    expect(store.groupProgress(id)).toEqual({ done: 0, total: 2 });
  });
});

describe('binQueue entry mutations', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useBinQueue();
    store.entries = [];
    store.batches = [];
    store.groups = [];
  });

  const INSERT: Product = {
    kind: 'insert',
    origin: 'manual',
    cells: 2,
    content: { text: 'Bits', text2: '', icon: null },
  };

  it('refuses to update an unknown entry with a user-worded problem', () => {
    const store = useBinQueue();

    const problem = store.update('no-such-id', { quantity: 2 });

    expect(problem).toBe(
      'This queue entry no longer exists. It may have been removed or moved onto a build plate.',
    );
  });

  it('refuses to remove an unknown entry and leaves the queue unchanged', () => {
    const store = useBinQueue();
    store.add(INSERT, 1);

    const problem = store.remove('no-such-id');

    expect(problem).toBe(
      'This queue entry no longer exists. It may have been removed or moved onto a build plate.',
    );
    expect(store.entries).toHaveLength(1);
  });

  it('removes a known entry and reports success', () => {
    const store = useBinQueue();
    const { id } = store.add(INSERT, 1);

    expect(store.remove(id!)).toBeNull();
    expect(store.entries).toEqual([]);
  });

  it('stores a sanitized copy on add, dropping unknown fields', () => {
    const store = useBinQueue();
    const dirty = { ...INSERT, extra: 'not part of the plan' } as Product;

    store.add(dirty, 1);

    expect(store.entries[0].product).toEqual(INSERT);
    expect(store.entries[0].product).not.toBe(dirty);
  });

  it('stores a sanitized copy on update, dropping unknown fields', () => {
    const store = useBinQueue();
    const { id } = store.add(INSERT, 1);
    const dirty = { ...INSERT, cells: 3, extra: 'not part of the plan' } as Product;

    expect(store.update(id!, { product: dirty })).toBeNull();

    expect(store.entries[0].product).toEqual({ ...INSERT, cells: 3 });
  });

  it('refuses a screw bin ordered without its insert instead of repairing it silently', () => {
    const store = useBinQueue();
    const bareScrewBin = {
      kind: 'bin',
      labelSlot: true,
      bin: {
        origin: 'screw',
        gridX: 1,
        gridY: 1,
        heightUnits: 6,
        magnetHoles: false,
        walls: [],
        screw: { thread: 'M3', lengthMm: 20, head: 'countersunk screw', enteredLengthText: null },
      },
    } as unknown as Product;

    const result = store.add(bareScrewBin, 1);

    expect(result.problem).toBe(
      'This design is a screw bin without its label insert. A screw bin is always ordered with its label insert, so choose Bin + label insert.',
    );
    expect(store.entries).toEqual([]);
  });

  it('adds several products in order with shared notes', () => {
    const store = useBinQueue();
    const second: Product = { ...INSERT, cells: 1 };

    const result = store.addMany(
      [
        { product: INSERT, quantity: 2 },
        { product: second, quantity: 5 },
      ],
      'drawer 3',
    );

    expect(result.problem).toBeNull();
    expect(store.entries.map((e) => [e.id, e.quantity, e.notes])).toEqual([
      [result.ids![0], 2, 'drawer 3'],
      [result.ids![1], 5, 'drawer 3'],
    ]);
  });

  it('adds nothing when any of several products is refused, naming its position', () => {
    const store = useBinQueue();

    const result = store.addMany([
      { product: INSERT, quantity: 1 },
      { product: INSERT, quantity: 0 },
    ]);

    expect(result.problem).toBe('Entry 2: The quantity must be a whole number of at least 1.');
    expect(store.entries).toEqual([]);
  });
});

describe('binQueue addDrawerFromSize', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useBinQueue();
    store.entries = [];
    store.batches = [];
    store.groups = [];
  });

  it('plans the drawer and queues it as a group named after the drawer size', () => {
    const store = useBinQueue();

    // 470 x 300 mm on a 260 mm wide build plate splits into 6 + 5 columns.
    const result = store.addDrawerFromSize(
      { drawerWidthMm: 470, drawerDepthMm: 300, plateWidthMm: 260, plateDepthMm: 300 },
      OPTIONS,
    );

    expect(result.problem).toBeNull();
    const group = store.groupById(result.groupId!)!;
    expect(group.name).toBe('Drawer 470 × 300 mm');
    expect(group.payload.plates.map((p) => [p.unitsX, p.unitsY])).toEqual([
      [6, 7],
      [5, 7],
    ]);
    expect(
      store.entries.map((e) => (e.product.kind === 'baseplate' ? e.product.unitsX : null)),
    ).toEqual([6, 5]);
  });

  it('returns the planner error and queues nothing when the drawer is too small', () => {
    const store = useBinQueue();

    const result = store.addDrawerFromSize(
      { drawerWidthMm: 30, drawerDepthMm: 300, plateWidthMm: 260, plateDepthMm: 300 },
      OPTIONS,
    );

    expect(result).toEqual({
      groupId: null,
      problem: 'The drawer must be at least 42 mm in both width and depth to fit one grid cell.',
    });
    expect(store.groups).toEqual([]);
    expect(store.entries).toEqual([]);
  });

  it('stores the clip tolerance for a connectable drawer', () => {
    const store = useBinQueue();

    const result = store.addDrawerFromSize(
      { drawerWidthMm: 470, drawerDepthMm: 300, plateWidthMm: 260, plateDepthMm: 300 },
      CONNECTABLE,
      0.2,
    );

    expect(store.groupById(result.groupId!)!.payload.clips?.toleranceMm).toBe(0.2);
  });
});
