import { describe, expect, it } from 'vitest';
import {
  confirmBatchItem,
  createBatch,
  failBatchItem,
  productKey,
  snapshotProduct,
} from '../../src/engine/plan/batches';
import type {
  BinPockets,
  CutoutBin,
  CutoutModel,
  ManualBin,
  Product,
  PrintBatch,
  QueueEntry,
  ScrewBin,
  TracedBin,
} from '../../src/engine/plan/types';

function manualBin(overrides: Partial<ManualBin> = {}): ManualBin {
  return {
    origin: 'manual',
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
    ...overrides,
  };
}

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'a1',
    quantity: 5,
    createdAt: '2026-07-01T10:00:00.000Z',
    product: { kind: 'binWithInsert', bin: manualBin(), insert: { text: 'M3 bolts', text2: '', icon: 'bolt' } },
    ...overrides,
  };
}

function idFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function makeBatch(entries: QueueEntry[], selections: { entryId: string; count: number }[]) {
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
        product: snapshotProduct(entry().product),
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
    const other = entry({
      id: 'b2',
      product: { kind: 'binWithInsert', bin: manualBin(), insert: { text: 'M5 nuts', text2: '', icon: null } },
    });
    const result = makeBatch([entry(), other], [{ entryId: 'a1', count: 1 }]);
    expect(result.entries).toEqual([entry({ quantity: 4 }), other]);
  });
});

describe('confirmBatchItem', () => {
  const batch = (): PrintBatch =>
    makeBatch(
      [
        entry(),
        entry({
          id: 'b2',
          product: { kind: 'binWithInsert', bin: manualBin(), insert: { text: 'M5 nuts', text2: '', icon: null } },
        }),
      ],
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
    expect(created.batch!.items[0].product).toEqual(snapshotProduct(entry().product));
  });

  it('keeps other items and leaves the batch open when one item fails', () => {
    const created = makeBatch(
      [
        entry(),
        entry({
          id: 'b2',
          product: { kind: 'binWithInsert', bin: manualBin(), insert: { text: 'M5 nuts', text2: '', icon: null } },
        }),
      ],
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
  function screwEntry(): QueueEntry {
    const screwBin: ScrewBin = {
      ...manualBin(),
      origin: 'screw',
      screw: { thread: 'M3', lengthMm: 20, head: 'countersunk screw', enteredLengthText: null },
    };
    return entry({
      id: 'a1',
      product: { kind: 'binWithInsert', bin: screwBin, insert: { text: 'M3 x 20', text2: '', icon: null } },
    });
  }

  it('snapshots the screw description into the batch item', () => {
    const result = makeBatch([screwEntry()], [{ entryId: 'a1', count: 2 }]);
    const bin = result.batch!.items[0].product.kind === 'binWithInsert' ? result.batch!.items[0].product.bin : null;
    expect((bin as ScrewBin).screw).toEqual((screwEntry().product as { bin: ScrewBin }).bin.screw);
  });

  it('recreates a failed screw item as a screw entry', () => {
    const made = makeBatch([screwEntry()], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(1);
    const recreated = failed.entries[0];
    const bin = recreated.product.kind === 'binWithInsert' ? recreated.product.bin : null;
    expect(bin!.origin).toBe('screw');
    expect((bin as ScrewBin).screw).toEqual((screwEntry().product as { bin: ScrewBin }).bin.screw);
  });

  it('leaves the screw field off items from entries of other kinds', () => {
    const result = makeBatch([entry()], [{ entryId: 'a1', count: 1 }]);
    const product = result.batch!.items[0].product;
    expect(product.kind === 'binWithInsert' && 'screw' in product.bin).toBe(false);
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

  function tracedEntry(): QueueEntry {
    const { walls, origin, ...base } = manualBin();
    void walls;
    void origin;
    const tracedBin: TracedBin = { ...base, origin: 'traced', pockets: pockets() };
    return entry({ id: 'a1', product: { kind: 'bin', bin: tracedBin } });
  }

  it('snapshots the pockets into the batch item without aliasing the entry', () => {
    const source = tracedEntry();
    const result = makeBatch([source], [{ entryId: 'a1', count: 2 }]);
    const item = result.batch!.items[0];
    const bin = item.product.kind === 'bin' ? (item.product.bin as TracedBin) : null;
    expect(bin!.pockets).toEqual(pockets());
    bin!.pockets.placements[0].xMm = 99;
    expect((source.product as { bin: TracedBin }).bin.pockets.placements[0].xMm).toBe(0);
  });

  it('leaves the pockets field off items from entries without pockets', () => {
    const result = makeBatch([entry()], [{ entryId: 'a1', count: 1 }]);
    const product = result.batch!.items[0].product;
    expect(product.kind === 'binWithInsert' && 'pockets' in product.bin).toBe(false);
  });

  it('recreates a failed item as a traced entry that keeps its pockets', () => {
    const source = tracedEntry();
    const made = makeBatch([source], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(1);
    const recreated = failed.entries[0];
    const bin = recreated.product.kind === 'bin' ? (recreated.product.bin as TracedBin) : null;
    expect(bin!.origin).toBe('traced');
    expect(bin!.pockets).toEqual(pockets());
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
    const base = tracedEntry();
    const bin = (base.product as { bin: TracedBin }).bin;
    const source: QueueEntry = {
      ...base,
      product: { kind: 'bin', bin: { ...bin, traceSourceId: 'photo-1', paper } },
    };
    const result = makeBatch([source], [{ entryId: 'a1', count: 2 }]);
    const item = result.batch!.items[0];
    const itemBin = item.product.kind === 'bin' ? (item.product.bin as TracedBin) : null;
    expect(itemBin!.traceSourceId).toBe('photo-1');
    expect(itemBin!.paper).toEqual(paper);
    itemBin!.paper!.corners.tl.x = 99;
    expect((source.product as { bin: TracedBin }).bin.paper!.corners.tl.x).toBe(1);
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
    const base = tracedEntry();
    const bin = (base.product as { bin: TracedBin }).bin;
    const source: QueueEntry = {
      ...base,
      product: { kind: 'bin', bin: { ...bin, traceSourceId: 'photo-1', paper } },
    };
    const made = makeBatch([source], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([], made.batch!, 'item1', idFactory('new'));
    const recreatedBin = (failed.entries[0].product as { bin: TracedBin }).bin;
    expect(recreatedBin.traceSourceId).toBe('photo-1');
    expect(recreatedBin.paper).toEqual(paper);
  });

  it('leaves the trace source fields off items from entries without them', () => {
    const result = makeBatch([tracedEntry()], [{ entryId: 'a1', count: 1 }]);
    const item = result.batch!.items[0];
    const bin = item.product.kind === 'bin' ? item.product.bin : null;
    expect(bin !== null && 'traceSourceId' in bin).toBe(false);
    expect(bin !== null && 'paper' in bin).toBe(false);
  });

  it('does not merge a failed pocket item into a pocketless entry with equal product', () => {
    const plain = entry({ id: 'other' });
    const source = tracedEntry();
    const made = makeBatch([source], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([plain], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(2);
    expect(failed.entries[0].quantity).toBe(5);
    const bin = (failed.entries[1].product as { bin: TracedBin }).bin;
    expect(bin.pockets).toEqual(pockets());
  });
});

describe('cutout models in batches', () => {
  function model(overrides: Partial<CutoutModel> = {}): CutoutModel {
    return {
      id: 'm1',
      name: 'socket-19.stl',
      modelSourceId: 'src-1',
      triangleCount: 14842,
      unitScale: 1,
      sizeMm: { x: 24, y: 24, z: 40 },
      placement: { xMm: 3, yMm: -2, zMm: 21.75, rotXDeg: 0, rotYDeg: 90, rotZDeg: 15 },
      clearanceMm: 0.4,
      ...overrides,
    };
  }

  function cutoutBin(): CutoutBin {
    const { walls, origin, ...base } = manualBin();
    void walls;
    void origin;
    return {
      ...base,
      origin: 'cutout',
      models: [model(), model({ id: 'm2', name: 'socket-22.stl', modelSourceId: 'src-2', clearanceMm: 0.8 })],
    };
  }

  function cutoutEntry(): QueueEntry {
    return entry({ id: 'a1', product: { kind: 'bin', bin: cutoutBin(), labelSlot: true } });
  }

  function binOfItemProduct(product: Product): CutoutBin | null {
    return product.kind === 'bin' ? (product.bin as CutoutBin) : null;
  }

  it('snapshots every model into the batch item without aliasing the entry', () => {
    const source = cutoutEntry();
    const result = makeBatch([source], [{ entryId: 'a1', count: 2 }]);
    const bin = binOfItemProduct(result.batch!.items[0].product);
    expect(bin!.origin).toBe('cutout');
    expect(bin!.models).toEqual(cutoutBin().models);
    bin!.models[0].placement.xMm = 99;
    expect((source.product as { bin: CutoutBin }).bin.models[0].placement.xMm).toBe(3);
  });

  it('keeps the per-model clearances distinct through the snapshot', () => {
    const result = makeBatch([cutoutEntry()], [{ entryId: 'a1', count: 1 }]);
    const bin = binOfItemProduct(result.batch!.items[0].product);
    expect(bin!.models.map((m) => m.clearanceMm)).toEqual([0.4, 0.8]);
  });

  it('recreates a failed item as a cutout entry that keeps its models', () => {
    const made = makeBatch([cutoutEntry()], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(1);
    const bin = binOfItemProduct(failed.entries[0].product);
    expect(bin!.origin).toBe('cutout');
    // The whole record survives, including the model store keys the bytes are
    // found under: losing those would export the bin as an uncarved solid.
    expect(bin!.models).toEqual(cutoutBin().models);
  });

  it('does not merge a failed cutout item into a modelless entry with equal envelope', () => {
    const plain = entry({ id: 'other', product: { kind: 'bin', bin: manualBin(), labelSlot: true } });
    const made = makeBatch([cutoutEntry()], [{ entryId: 'a1', count: 5 }]);
    const failed = failBatchItem([plain], made.batch!, 'item1', idFactory('new'));
    expect(failed.entries).toHaveLength(2);
    expect(failed.entries[0].quantity).toBe(5);
    expect(binOfItemProduct(failed.entries[1].product)!.models).toEqual(cutoutBin().models);
  });

  it('two bins differing only in a model placement are different design keys', () => {
    const moved = cutoutBin();
    moved.models[0].placement.xMm = 12;
    expect(productKey({ kind: 'bin', bin: cutoutBin(), labelSlot: true })).not.toBe(
      productKey({ kind: 'bin', bin: moved, labelSlot: true }),
    );
  });
});

describe('product snapshots and keys', () => {
  it('a paired insert product is a different design key than a bin alone', () => {
    const withInsert: Product = { kind: 'binWithInsert', bin: manualBin(), insert: { text: 'M3', text2: '', icon: null } };
    const binAlone: Product = { kind: 'bin', bin: manualBin() };
    expect(productKey(withInsert)).not.toBe(productKey(binAlone));
  });

  it('deep-copies a product so mutating the snapshot does not alias the source', () => {
    const product: Product = { kind: 'binWithInsert', bin: manualBin(), insert: { text: 'M3', text2: '', icon: null } };
    const snapshot = snapshotProduct(product);
    (snapshot as { insert: { text: string } }).insert.text = 'changed';
    expect((product as { insert: { text: string } }).insert.text).toBe('M3');
  });
});
