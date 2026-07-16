import { describe, expect, it } from 'vitest';
import {
  confirmBatchItem,
  createBatch,
  failBatchItem,
  snapshotParams,
} from '../../src/engine/plan/batches';
import type { BinEntry, PrintBatch } from '../../src/engine/plan/types';

function entry(overrides: Partial<BinEntry> = {}): BinEntry {
  return {
    id: 'a1',
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    perforatedBase: false,
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
