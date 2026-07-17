import { describe, expect, it } from 'vitest';
import {
  referencedTraceSourceIds,
  sweepOrphanTracePhotos,
  type PhotoStoreLike,
} from '../../src/engine/plan/traceSources';
import type {
  BatchItem,
  BinEntry,
  ManualBin,
  PrintBatch,
  TracedBin,
} from '../../src/engine/plan/types';

// The photo blobs themselves live in an IndexedDB wrapper (src/photoStore.ts)
// that node cannot run without a shim; the wrapper stays thin and untested,
// and these tests cover the garbage-collection logic through a fake store.

function manual(id: string): ManualBin {
  return {
    id,
    kind: 'manual',
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    labelText: '',
    labelText2: '',
    labelIcon: null,
    quantity: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
  };
}

function traced(id: string, traceSourceId?: string): TracedBin {
  const { dividerCountX, dividerCountY, kind, ...base } = manual(id);
  void dividerCountX;
  void dividerCountY;
  void kind;
  const entry: TracedBin = {
    ...base,
    kind: 'traced',
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
  if (traceSourceId !== undefined) entry.traceSourceId = traceSourceId;
  return entry;
}

function batchWith(items: Partial<BatchItem>[]): PrintBatch {
  const { id, kind, quantity, createdAt, ...params } = manual('x');
  void id;
  void kind;
  void quantity;
  void createdAt;
  return {
    id: 'batch1',
    name: 'Plate',
    createdAt: '2026-07-02T10:00:00.000Z',
    items: items.map((overrides, index) => ({
      id: `item${index}`,
      params,
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
    const entries: BinEntry[] = [manual('m1'), traced('t1', 'photo-a'), traced('t2')];
    const batches = [batchWith([{ traceSourceId: 'photo-b' }, {}])];
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
      [traced('t1', 'photo-a')],
      [batchWith([{ traceSourceId: 'photo-b' }])],
    );
    expect(deleted).toEqual(['photo-stale']);
    expect(store.deleted).toEqual(['photo-stale']);
  });

  it('deletes nothing when every stored photo is referenced', async () => {
    const store = fakeStore(['photo-a']);
    const deleted = await sweepOrphanTracePhotos(store, [traced('t1', 'photo-a')], []);
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
      [batchWith([{ traceSourceId: 'photo-a', sourceEntryId: 'gone' }])],
    );
    expect(deleted).toEqual([]);
  });
});
