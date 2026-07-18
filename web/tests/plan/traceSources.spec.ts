import { describe, expect, it } from 'vitest';
import {
  referencedTraceSourceIds,
  sweepOrphanTracePhotos,
  type PhotoStoreLike,
} from '../../src/engine/plan/traceSources';
import type {
  BatchItem,
  ManualBin,
  PrintBatch,
  Product,
  QueueEntry,
  TracedBin,
} from '../../src/engine/plan/types';

// The photo blobs themselves live in an IndexedDB wrapper (src/photoStore.ts)
// that node cannot run without a shim; the wrapper stays thin and untested,
// and these tests cover the garbage-collection logic through a fake store.

function manualBin(): ManualBin {
  return {
    origin: 'manual',
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
  };
}

function tracedBin(traceSourceId?: string): TracedBin {
  const { dividerCountX, dividerCountY, origin, ...base } = manualBin();
  void dividerCountX;
  void dividerCountY;
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

function fakeStore(ids: string[]): PhotoStoreLike & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    listIds: () => Promise.resolve([...ids]),
    deletePhoto: (id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
  };
}

describe('referencedTraceSourceIds', () => {
  it('collects ids from traced entries and batch items and skips the rest', () => {
    const entries: QueueEntry[] = [manualEntry('m1'), tracedEntry('t1', 'photo-a'), tracedEntry('t2')];
    const batches = [
      batchWith([{ product: { kind: 'bin', bin: tracedBin('photo-b') } }, {}]),
    ];
    expect(referencedTraceSourceIds(entries, batches)).toEqual(new Set(['photo-a', 'photo-b']));
  });

  it('returns an empty set for an empty plan', () => {
    expect(referencedTraceSourceIds([], [])).toEqual(new Set());
  });
});

describe('sweepOrphanTracePhotos', () => {
  it('deletes stored photos no plan row references anymore', async () => {
    const store = fakeStore(['photo-a', 'photo-b', 'photo-stale']);
    const deleted = await sweepOrphanTracePhotos(
      store,
      [tracedEntry('t1', 'photo-a')],
      [batchWith([{ product: { kind: 'bin', bin: tracedBin('photo-b') } }])],
    );
    expect(deleted).toEqual(['photo-stale']);
    expect(store.deleted).toEqual(['photo-stale']);
  });

  it('deletes nothing when every stored photo is referenced', async () => {
    const store = fakeStore(['photo-a']);
    const deleted = await sweepOrphanTracePhotos(store, [tracedEntry('t1', 'photo-a')], []);
    expect(deleted).toEqual([]);
    expect(store.deleted).toEqual([]);
  });

  it('deletes everything stored when the plan is empty', async () => {
    const store = fakeStore(['photo-a', 'photo-b']);
    const deleted = await sweepOrphanTracePhotos(store, [], []);
    expect(deleted).toEqual(['photo-a', 'photo-b']);
  });

  it('a batch item keeps its photo alive after the source entry is deleted', async () => {
    const store = fakeStore(['photo-a']);
    const deleted = await sweepOrphanTracePhotos(
      store,
      [],
      [
        batchWith([
          { product: { kind: 'bin', bin: tracedBin('photo-a') }, sourceEntryId: 'gone' },
        ]),
      ],
    );
    expect(deleted).toEqual([]);
  });
});
