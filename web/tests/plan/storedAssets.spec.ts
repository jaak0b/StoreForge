import { describe, expect, it } from 'vitest';
import {
  referencedAssetIds,
  referencedCutoutModelKeySpecs,
  sweepOrphanAssets,
  type AssetStoreLike,
} from '../../src/engine/plan/storedAssets';
import type {
  BatchItem,
  CutoutBin,
  CutoutModel,
  ManualBin,
  PrintBatch,
  Product,
  QueueEntry,
  TracedBin,
} from '../../src/engine/plan/types';

// The blobs themselves live in IndexedDB wrappers (src/photoStore.ts and
// src/modelStore.ts over src/idb.ts) that node cannot run without a shim; the
// wrappers stay thin and untested, and these tests cover the
// garbage-collection logic through fake stores.

function manualBin(): ManualBin {
  return {
    origin: 'manual',
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
  };
}

function tracedBin(traceSourceId?: string): TracedBin {
  const { walls, origin, ...base } = manualBin();
  void walls;
  void origin;
  const bin: TracedBin = {
    ...base,
    origin: 'traced',
    pockets: {
      tools: [
        {
          id: 't1',
          name: 'Tool',
          outline: {
            outer: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 0, y: 10 },
            ],
            holes: [],
          },
          clicks: [],
          rotationDeg: 0,
          offsetMm: 0,
          mirrored: false,
          fingerHoles: [],
        },
      ],
      placements: [{ toolId: 't1', xMm: 0, yMm: 0, pocketDepthMm: 10 }],
    },
  };
  if (traceSourceId !== undefined) bin.traceSourceId = traceSourceId;
  return bin;
}

function cutoutModel(modelSourceId: string): CutoutModel {
  return {
    id: `record-${modelSourceId}`,
    name: `${modelSourceId}.stl`,
    modelSourceId,
    triangleCount: 12,
    unitScale: 1,
    sizeMm: { x: 20, y: 10, z: 5 },
    placement: { xMm: 0, yMm: 0, zMm: 3, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 },
    clearanceMm: 0.4,
    sweepEnabled: false,
    draftAngleDeg: 0,
  };
}

function cutoutBin(...modelSourceIds: string[]): CutoutBin {
  const { walls, origin, ...base } = manualBin();
  void walls;
  void origin;
  return { ...base, origin: 'cutout', models: modelSourceIds.map(cutoutModel) };
}

function manualEntry(id: string): QueueEntry {
  return {
    id,
    quantity: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    product: { kind: 'bin', bin: manualBin() },
  };
}

function tracedEntry(id: string, traceSourceId?: string): QueueEntry {
  return {
    id,
    quantity: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    product: { kind: 'bin', bin: tracedBin(traceSourceId) },
  };
}

function cutoutEntry(id: string, ...modelSourceIds: string[]): QueueEntry {
  return {
    id,
    quantity: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    product: { kind: 'bin', bin: cutoutBin(...modelSourceIds) },
  };
}

function batchWith(items: Array<Partial<BatchItem> & { product?: Product }>): PrintBatch {
  return {
    id: 'batch1',
    name: 'Plate',
    createdAt: '2026-07-02T10:00:00.000Z',
    items: items.map((overrides, index) => ({
      id: `item${index}`,
      product: { kind: 'bin', bin: manualBin() },
      count: 1,
      ...overrides,
    })),
  };
}

function fakeStore(ids: string[]): AssetStoreLike & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    listIds: () => Promise.resolve([...ids]),
    deleteAsset: (id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
  };
}

function fakeStores(photoIds: string[], modelIds: string[]) {
  return { photos: fakeStore(photoIds), models: fakeStore(modelIds) };
}

describe('referencedAssetIds', () => {
  it('collects ids from traced entries and batch items and skips the rest', () => {
    const entries: QueueEntry[] = [manualEntry('m1'), tracedEntry('t1', 'photo-a'), tracedEntry('t2')];
    const batches = [
      batchWith([{ product: { kind: 'bin', bin: tracedBin('photo-b') } }, {}]),
    ];
    expect(referencedAssetIds(entries, batches).tracePhotos).toEqual(
      new Set(['photo-a', 'photo-b']),
    );
  });

  it('returns an empty set for an empty plan', () => {
    expect(referencedAssetIds([], []).tracePhotos).toEqual(new Set());
    expect(referencedAssetIds([], []).cutoutModels).toEqual(new Set());
  });

  it('collects every model of every cutout bin, in entries and in batch items', () => {
    const entries = [cutoutEntry('c1', 'model-a', 'model-b'), manualEntry('m1')];
    const batches = [batchWith([{ product: { kind: 'bin', bin: cutoutBin('model-c') } }, {}])];
    expect(referencedAssetIds(entries, batches).cutoutModels).toEqual(
      new Set(['model-a', 'model-b', 'model-c']),
    );
  });

  it('keeps the two asset kinds apart', () => {
    const referenced = referencedAssetIds(
      [tracedEntry('t1', 'photo-a'), cutoutEntry('c1', 'model-a')],
      [],
    );
    expect(referenced.tracePhotos).toEqual(new Set(['photo-a']));
    expect(referenced.cutoutModels).toEqual(new Set(['model-a']));
  });
});

describe('referencedCutoutModelKeySpecs', () => {
  // The keep-list the worker's solid cache retains. A queued bin's solid has
  // to survive its editor closing, and an editor's solid has to survive plan
  // mutations, so only the union over both is a correct keep-list.

  it('returns the editor-held specs when no plan row orders a cutout bin', () => {
    const specs = referencedCutoutModelKeySpecs(
      [manualEntry('m1'), tracedEntry('t1', 'photo-a')],
      [],
      [{ modelSourceId: 'model-editor', unitScale: 25.4, clearanceMm: 0.6 }],
    );
    expect(specs).toEqual([
      { modelSourceId: 'model-editor', unitScale: 25.4, clearanceMm: 0.6 },
    ]);
  });

  it('collects queue entries and batch items when no editor holds a model', () => {
    const specs = referencedCutoutModelKeySpecs(
      [cutoutEntry('c1', 'model-a'), manualEntry('m1')],
      [batchWith([{ product: { kind: 'bin', bin: cutoutBin('model-b') } }, {}])],
      [],
    );
    expect(specs).toEqual([
      { modelSourceId: 'model-a', unitScale: 1, clearanceMm: 0.4 },
      { modelSourceId: 'model-b', unitScale: 1, clearanceMm: 0.4 },
    ]);
  });

  it('names a model the editor and a queue row share exactly once', () => {
    const specs = referencedCutoutModelKeySpecs(
      [cutoutEntry('c1', 'model-shared')],
      [],
      [
        { modelSourceId: 'model-shared', unitScale: 1, clearanceMm: 0.4 },
        { modelSourceId: 'model-editor-only', unitScale: 1, clearanceMm: 0.4 },
      ],
    );
    expect(specs).toEqual([
      { modelSourceId: 'model-shared', unitScale: 1, clearanceMm: 0.4 },
      { modelSourceId: 'model-editor-only', unitScale: 1, clearanceMm: 0.4 },
    ]);
  });

  it('keeps two specs of one model apart when their clearances differ', () => {
    // An editor retuning a queued bin's clearance holds the new solid while
    // the queue row still names the old one; both are alive references and
    // collapsing them would evict a solid a plan row still orders.
    const specs = referencedCutoutModelKeySpecs(
      [cutoutEntry('c1', 'model-a')],
      [],
      [{ modelSourceId: 'model-a', unitScale: 1, clearanceMm: 0.8 }],
    );
    expect(specs).toEqual([
      { modelSourceId: 'model-a', unitScale: 1, clearanceMm: 0.8 },
      { modelSourceId: 'model-a', unitScale: 1, clearanceMm: 0.4 },
    ]);
  });

  it('returns nothing for an empty plan and an empty editor', () => {
    expect(referencedCutoutModelKeySpecs([], [], [])).toEqual([]);
  });
});

describe('sweepOrphanAssets', () => {
  it('deletes stored photos no plan row references anymore', async () => {
    const stores = fakeStores(['photo-a', 'photo-b', 'photo-stale'], []);
    const deleted = await sweepOrphanAssets(
      stores,
      [tracedEntry('t1', 'photo-a')],
      [batchWith([{ product: { kind: 'bin', bin: tracedBin('photo-b') } }])],
    );
    expect(deleted.tracePhotos).toEqual(['photo-stale']);
    expect(stores.photos.deleted).toEqual(['photo-stale']);
  });

  it('deletes nothing when every stored photo is referenced', async () => {
    const stores = fakeStores(['photo-a'], []);
    const deleted = await sweepOrphanAssets(stores, [tracedEntry('t1', 'photo-a')], []);
    expect(deleted.tracePhotos).toEqual([]);
    expect(stores.photos.deleted).toEqual([]);
  });

  it('deletes everything stored when the plan is empty', async () => {
    const stores = fakeStores(['photo-a', 'photo-b'], []);
    const deleted = await sweepOrphanAssets(stores, [], []);
    expect(deleted.tracePhotos).toEqual(['photo-a', 'photo-b']);
  });

  it('a batch item keeps its photo alive after the source entry is deleted', async () => {
    const stores = fakeStores(['photo-a'], []);
    const deleted = await sweepOrphanAssets(
      stores,
      [],
      [
        batchWith([
          { product: { kind: 'bin', bin: tracedBin('photo-a') }, sourceEntryId: 'gone' },
        ]),
      ],
    );
    expect(deleted.tracePhotos).toEqual([]);
  });

  it('a cutout model referenced by an entry is not swept', async () => {
    const stores = fakeStores([], ['model-a', 'model-stale']);
    const deleted = await sweepOrphanAssets(stores, [cutoutEntry('c1', 'model-a')], []);
    expect(deleted.cutoutModels).toEqual(['model-stale']);
    expect(stores.models.deleted).toEqual(['model-stale']);
  });

  it('a cutout model referenced only by a batch item is not swept', async () => {
    const stores = fakeStores([], ['model-a']);
    const deleted = await sweepOrphanAssets(
      stores,
      [],
      [
        batchWith([
          { product: { kind: 'bin', bin: cutoutBin('model-a') }, sourceEntryId: 'gone' },
        ]),
      ],
    );
    expect(deleted.cutoutModels).toEqual([]);
    expect(stores.models.deleted).toEqual([]);
  });

  it('a model referenced by two bins survives deleting one of them', async () => {
    // Duplicating a queue row deep clones the product with its ids, so two
    // rows sharing one model id is normal. A reference count would delete the
    // model when the first of them goes; set membership is the only correct test.
    const stores = fakeStores([], ['model-a']);
    const both = await sweepOrphanAssets(
      stores,
      [cutoutEntry('c1', 'model-a'), cutoutEntry('c2', 'model-a')],
      [],
    );
    expect(both.cutoutModels).toEqual([]);
    const afterDeletingOne = await sweepOrphanAssets(stores, [cutoutEntry('c2', 'model-a')], []);
    expect(afterDeletingOne.cutoutModels).toEqual([]);
    expect(stores.models.deleted).toEqual([]);
  });

  it('sweeps an unreferenced model without touching the photo store', async () => {
    const stores = fakeStores(['photo-a'], ['model-stale']);
    const deleted = await sweepOrphanAssets(stores, [tracedEntry('t1', 'photo-a')], []);
    expect(deleted).toEqual({ tracePhotos: [], cutoutModels: ['model-stale'] });
    expect(stores.photos.deleted).toEqual([]);
    expect(stores.models.deleted).toEqual(['model-stale']);
  });

  it('sweeps an unreferenced photo without touching the model store', async () => {
    const stores = fakeStores(['photo-stale'], ['model-a']);
    const deleted = await sweepOrphanAssets(stores, [cutoutEntry('c1', 'model-a')], []);
    expect(deleted).toEqual({ tracePhotos: ['photo-stale'], cutoutModels: [] });
    expect(stores.models.deleted).toEqual([]);
  });

  it('protectedIds keeps an upload in progress alive with no plan row referencing it', async () => {
    // The write ordering trap. The model file has to reach the store before
    // the bin that uses it is queued, because the carve preview needs the
    // bytes long before the bin is saved. Any plan mutation in between runs
    // this sweep, which without the protection deletes the blob moments after
    // it was written, asynchronously and silently.
    const stores = fakeStores([], ['model-uploading']);
    const deleted = await sweepOrphanAssets(stores, [], [], new Set(['model-uploading']));
    expect(deleted.cutoutModels).toEqual([]);
    expect(stores.models.deleted).toEqual([]);
  });

  it('sweeps an upload that is no longer protected and still unreferenced', async () => {
    const stores = fakeStores([], ['model-abandoned']);
    const deleted = await sweepOrphanAssets(stores, [], [], new Set());
    expect(deleted.cutoutModels).toEqual(['model-abandoned']);
    expect(stores.models.deleted).toEqual(['model-abandoned']);
  });
});
