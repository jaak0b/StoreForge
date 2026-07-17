import { describe, expect, it } from 'vitest';
import {
  confirmBatchItem,
  createBatch,
  failBatchItem,
  snapshotParams,
} from '../../src/engine/plan/batches';
import type {
  BinEntry,
  BinPockets,
  ManualBin,
  PrintBatch,
  ScrewBin,
  TracedBin,
} from '../../src/engine/plan/types';

function entry(overrides: Partial<ManualBin> = {}): ManualBin {
  return {
    id: 'a1',
    kind: 'manual',
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    labelText: 'M3 bolts',
    labelText2: '',
    labelIcon: 'bolt',
    quantity: 5,
    createdAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

function idFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function makeBatch(entries: BinEntry[], selections: { entryId: string; count: number }[]) {
  return createBatch(entries, selections, 'Plate 1', {
    batchId: 'batch1',
    itemId: idFactory('item'),
  });
}

describe('createBatch', () => {
  it('takes a partial amount and leaves the remainder queued', () => {
    const result = makeBatch([entry()], [{ entryId: 'a1', count: 2 }]);
    expect(result.entries).toEqual([entry({ quantity: 3 })]);
    expect(result.batch).not.toBeNull();
    expect(result.batch!.items).toEqual([
      {
        id: 'item1',
        params: snapshotParams(entry()),
        count: 2,
        sourceEntryId: 'a1',
      },
    ]);
  });

  it('removes an entry whose full quantity was taken', () => {
    const result = makeBatch([entry()], [{ entryId: 'a1', count: 5 }]);
    expect(result.entries).toEqual([]);
    expect(result.batch!.items[0].count).toBe(5);
  });

  it('clamps a requested amount above the quantity to the full quantity', () => {
    const result = makeBatch([entry()], [{ entryId: 'a1', count: 99 }]);
    expect(result.entries).toEqual([]);
    expect(result.batch!.items[0].count).toBe(5);
  });

  it('ignores selections naming a missing entry and returns no batch when empty', () => {
    const result = makeBatch([entry()], [{ entryId: 'ghost', count: 1 }]);
    expect(result.batch).toBeNull();
    expect(result.entries).toEqual([entry()]);
  });

  it('leaves unselected entries untouched', () => {
    const other = entry({ id: 'b2', labelText: 'M5 nuts' });
    const result = makeBatch([entry(), other], [{ entryId: 'a1', count: 1 }]);
    expect(result.entries).toEqual([entry({ quantity: 4 }), other]);
  });
});

describe('confirmBatchItem', () => {
  const batch = (): PrintBatch =>
    makeBatch(
      [entry(), entry({ id: 'b2', labelText: 'M5 nuts' })],
      [
        { entryId: 'a1', count: 3 },
        { entryId: 'b2', count: 2 },
      ],
    ).batch!;

  it('a partial confirmation decrements the item count', () => {
    const updated = confirmBatchItem(batch(), 'item1', 2);
    expect(updated!.items.map((i) => [i.id, i.count])).toEqual([
      ['item1', 1],
      ['item2', 2],
    ]);
  });

  it('a full confirmation removes the item', () => {
    const updated = confirmBatchItem(batch(), 'item1', 3);
    expect(updated!.items.map((i) => i.id)).toEqual(['item2']);
  });

  it('confirming the last remaining item empties the batch to null', () => {
    const oneLeft = confirmBatchItem(batch(), 'item1', 3)!;
    expect(confirmBatchItem(oneLeft, 'item2', 2)).toBeNull();
  });

  it('clamps an amount above the item count', () => {
    const updated = confirmBatchItem(batch(), 'item1', 99);
    expect(updated!.items.map((i) => i.id)).toEqual(['item2']);
  });
});

describe('failBatchItem', () => {
  it('returns the amount to the source entry when it still exists', () => {
    const created = makeBatch([entry()], [{ entryId: 'a1', count: 2 }]);
    const result = failBatchItem(
      created.entries,
      created.batch!,
      'item1',
      idFactory('new'),
    );
    expect(result.entries).toEqual([entry({ quantity: 5 })]);
    expect(result.batch).toBeNull();
  });

  it('recreates an entry from the snapshot when the source entry was deleted', () => {
    const created = makeBatch([entry()], [{ entryId: 'a1', count: 2 }]);
    const entriesAfterDeletion = created.entries.filter((e) => e.id !== 'a1');
    const result = failBatchItem(
      entriesAfterDeletion,
      created.batch!,
      'item1',
      idFactory('new'),
      '2026-07-03T08:00:00.000Z',
    );
    expect(result.entries).toEqual([
      entry({ id: 'new1', quantity: 2, createdAt: '2026-07-03T08:00:00.000Z' }),
    ]);
  });

  it('re-increments an entry with identical parameters over recreating one', () => {
    const created = makeBatch([entry()], [{ entryId: 'a1', count: 2 }]);
    // The source row is gone, but a fresh row with the same design exists.
    const lookalike = entry({ id: 'c3', quantity: 1 });
    const result = failBatchItem(
      [lookalike],
      created.batch!,
      'item1',
      idFactory('new'),
    );
    expect(result.entries).toEqual([entry({ id: 'c3', quantity: 3 })]);
  });

  it('the batch survives deletion of its source entry (embedded snapshot)', () => {
    const created = makeBatch([entry()], [{ entryId: 'a1', count: 5 }]);
    // Queue is now empty; the batch still knows its bin design.
    expect(created.entries).toEqual([]);
    expect(created.batch!.items[0].params).toEqual(snapshotParams(entry()));
  });

  it('keeps other items and leaves the batch open when one item fails', () => {
    const created = makeBatch(
      [entry(), entry({ id: 'b2', labelText: 'M5 nuts' })],
      [
        { entryId: 'a1', count: 1 },
        { entryId: 'b2', count: 1 },
      ],
    );
    const result = failBatchItem(
      created.entries,
      created.batch!,
      'item1',
      idFactory('new'),
    );
    expect(result.batch!.items.map((i) => i.id)).toEqual(['item2']);
  });
});

describe('screw snapshots in batches', () => {
  function screwEntry(): ScrewBin {
    return {
      ...entry({ id: 'a1', labelText: 'M3 x 20' }),
      kind: 'screw',
      screw: { thread: 'M3', lengthMm: 20, head: 'countersunk screw', enteredLengthText: null },
    };
  }

  it('snapshots the screw description into the batch item', () => {
    const result = makeBatch([screwEntry()], [{ entryId: 'a1', count: 2 }]);
    expect(result.batch!.items[0].screw).toEqual(screwEntry().screw);
  });

  it('recreates a failed screw item as a screw entry', () => {
    const made = makeBatch([screwEntry()], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(1);
    const recreated = failed.entries[0];
    expect(recreated.kind).toBe('screw');
    expect((recreated as ScrewBin).screw).toEqual(screwEntry().screw);
  });

  it('leaves the screw field off items from entries of other kinds', () => {
    const result = makeBatch([entry()], [{ entryId: 'a1', count: 1 }]);
    expect('screw' in result.batch!.items[0]).toBe(false);
  });
});

describe('pockets in batches', () => {
  function pockets(): BinPockets {
    return {
      tools: [
        {
          id: 't1',
          name: 'Wrench',
          outline: {
            outer: [
              { x: -10, y: -5 },
              { x: 10, y: -5 },
              { x: 0, y: 5 },
            ],
            holes: [],
          },
          rotationDeg: 0,
          offsetMm: 0.5,
          mirrored: false,
          clicks: [],
          fingerHoles: [],
        },
      ],
      placements: [{ toolId: 't1', xMm: 0, yMm: 0, pocketDepthMm: 12 }],
    };
  }

  function tracedEntry(): TracedBin {
    const { dividerCountX, dividerCountY, kind, ...base } = entry();
    void dividerCountX;
    void dividerCountY;
    void kind;
    return { ...base, kind: 'traced', pockets: pockets() };
  }

  it('snapshots the pockets into the batch item without aliasing the entry', () => {
    const source = tracedEntry();
    const result = makeBatch([source], [{ entryId: 'a1', count: 2 }]);
    const item = result.batch!.items[0];
    expect(item.pockets).toEqual(pockets());
    item.pockets!.placements[0].xMm = 99;
    expect(source.pockets.placements[0].xMm).toBe(0);
  });

  it('leaves the pockets field off items from entries without pockets', () => {
    const result = makeBatch([entry()], [{ entryId: 'a1', count: 1 }]);
    expect('pockets' in result.batch!.items[0]).toBe(false);
  });

  it('recreates a failed item as a traced entry that keeps its pockets', () => {
    const source = tracedEntry();
    const made = makeBatch([source], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(1);
    const recreated: BinEntry = failed.entries[0];
    expect(recreated.kind).toBe('traced');
    expect((recreated as TracedBin).pockets).toEqual(pockets());
  });

  it('snapshots the trace source id and paper into the batch item without aliasing', () => {
    const paper = {
      corners: {
        tl: { x: 1, y: 2 },
        tr: { x: 3, y: 2 },
        br: { x: 3, y: 4 },
        bl: { x: 1, y: 4 },
      },
      kind: 'letter' as const,
    };
    const source: TracedBin = { ...tracedEntry(), traceSourceId: 'photo-1', paper };
    const result = makeBatch([source], [{ entryId: 'a1', count: 2 }]);
    const item = result.batch!.items[0];
    expect(item.traceSourceId).toBe('photo-1');
    expect(item.paper).toEqual(paper);
    item.paper!.corners.tl.x = 99;
    expect(source.paper!.corners.tl.x).toBe(1);
  });

  it('recreates a failed item with its trace source id and paper', () => {
    const paper = {
      corners: {
        tl: { x: 1, y: 2 },
        tr: { x: 3, y: 2 },
        br: { x: 3, y: 4 },
        bl: { x: 1, y: 4 },
      },
      kind: 'a4' as const,
    };
    const source: TracedBin = { ...tracedEntry(), traceSourceId: 'photo-1', paper };
    const made = makeBatch([source], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([], made.batch!, 'item1', idFactory('new'));
    const recreated = failed.entries[0] as TracedBin;
    expect(recreated.traceSourceId).toBe('photo-1');
    expect(recreated.paper).toEqual(paper);
  });

  it('leaves the trace source fields off items from entries without them', () => {
    const result = makeBatch([tracedEntry()], [{ entryId: 'a1', count: 1 }]);
    const item = result.batch!.items[0];
    expect('traceSourceId' in item).toBe(false);
    expect('paper' in item).toBe(false);
  });

  it('does not merge a failed pocket item into a pocketless entry with equal params', () => {
    const plain = entry({ id: 'other' });
    const source = tracedEntry();
    const made = makeBatch([source], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([plain], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(2);
    expect(failed.entries[0].quantity).toBe(5);
    expect((failed.entries[1] as TracedBin).pockets).toEqual(pockets());
  });
});
