import { describe, expect, it } from 'vitest';
import {
  mergeBatches,
  mergeEntries,
  parsePlanFile,
  serializePlanFile,
  validateBatch,
  validateEntry,
} from '../../src/engine/plan/planFile';
import type {
  BatchItem,
  BinPockets,
  ManualBin,
  ManualInsertProduct,
  PrintBatch,
  Product,
  QueueEntry,
  ScrewBin,
  ScrewSpec,
  TracedBin,
} from '../../src/engine/plan/types';

function manualBin(overrides: Partial<ManualBin> = {}): ManualBin {
  return {
    origin: 'manual',
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    ...overrides,
  };
}

function screwSpec(overrides: Partial<ScrewSpec> = {}): ScrewSpec {
  return {
    thread: 'M3',
    lengthMm: 20,
    head: 'countersunk screw',
    enteredLengthText: null,
    ...overrides,
  };
}

function screwBin(overrides: Partial<ScrewBin> = {}): ScrewBin {
  return { ...manualBin(), origin: 'screw', screw: screwSpec(), ...overrides };
}

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
            { x: 10, y: 5 },
            { x: -10, y: 5 },
          ],
          holes: [
            [
              { x: -2, y: -1 },
              { x: -2, y: 1 },
              { x: 2, y: 1 },
              { x: 2, y: -1 },
            ],
          ],
        },
        clicks: [
          { x: 120, y: 80, label: 1 },
          { x: 40, y: 30, label: 0 },
        ],
        rotationDeg: 90,
        offsetMm: 0.5,
        mirrored: true,
        minHoleWidthMm: 3.2,
        filledHoleIndices: [0],
        fingerHoles: [{ x: 0, y: 0, diameterMm: 25 }],
      },
    ],
    placements: [{ toolId: 't1', xMm: 3, yMm: -4, pocketDepthMm: 12 }],
  };
}

function tracedBin(overrides: Partial<TracedBin> = {}): TracedBin {
  const { dividerCountX, dividerCountY, origin, ...base } = manualBin();
  void dividerCountX;
  void dividerCountY;
  void origin;
  return { ...base, origin: 'traced', pockets: pockets(), ...overrides };
}

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'a1',
    quantity: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    product: { kind: 'bin', labelSlot: true, bin: manualBin() },
    ...overrides,
  };
}

function batchItem(overrides: Partial<BatchItem> = {}): BatchItem {
  return {
    id: 'i1',
    product: { kind: 'bin', labelSlot: true, bin: manualBin() },
    count: 2,
    sourceEntryId: 'a1',
    ...overrides,
  };
}

function batch(overrides: Partial<PrintBatch> = {}): PrintBatch {
  return {
    id: 'batch1',
    name: 'Printer A1',
    items: [batchItem()],
    createdAt: '2026-07-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('serializePlanFile / parsePlanFile', () => {
  it('round-trips a plan with entries and batches through JSON unchanged', () => {
    const entries = [entry(), entry({ id: 'b2', notes: 'reprint in PETG' })];
    const batches = [batch()];
    const result = parsePlanFile(serializePlanFile(entries, batches));
    expect(result).toEqual({ ok: true, plan: { version: 4, entries, batches }, warnings: [] });
  });

  it('rejects text that is not JSON', () => {
    const result = parsePlanFile('not json at all');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('rejects a JSON array instead of a plan object', () => {
    const result = parsePlanFile('[]');
    expect(result).toEqual({ ok: false, error: 'The file does not contain a plan object.' });
  });

  it('rejects an envelope version newer than this build reads', () => {
    const result = parsePlanFile('{"version":5,"entries":[],"batches":[]}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version 5');
    if (!result.ok) expect(result.error).toContain('versions 1 to 4');
  });

  it('rejects a missing entries list', () => {
    const result = parsePlanFile('{"version":4}');
    expect(result).toEqual({ ok: false, error: 'The plan is missing its entries list.' });
  });

  it('rejects a version-4 file without a batches list', () => {
    const result = parsePlanFile('{"version":4,"entries":[]}');
    expect(result).toEqual({ ok: false, error: 'The plan is missing its batches list.' });
  });

  it('rejects a plan containing one malformed entry instead of dropping it', () => {
    const good = entry();
    const bad = {
      ...entry({ id: 'b2' }),
      product: { kind: 'bin', labelSlot: true, bin: { ...manualBin(), gridX: 'two' } },
    };
    const text = JSON.stringify({ version: 4, entries: [good, bad], batches: [] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: entry b2: gridX must be an integer of at least 1.',
    });
  });

  it('rejects duplicate entry ids', () => {
    const text = JSON.stringify({ version: 4, entries: [entry(), entry()], batches: [] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: entry id a1 appears twice.',
    });
  });

  it('rejects duplicate batch ids', () => {
    const text = JSON.stringify({ version: 4, entries: [], batches: [batch(), batch()] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: batch id batch1 appears twice.',
    });
  });

  it('rejects a malformed batch item instead of dropping it', () => {
    const bad = batch({ items: [batchItem({ count: 0 })] });
    const text = JSON.stringify({ version: 4, entries: [], batches: [bad] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: batch batch1: item i1: count must be an integer of at least 1.',
    });
  });

  it('drops unknown extra fields on an entry when parsing', () => {
    const withExtra = { ...entry(), somethingElse: 42 };
    const result = parsePlanFile(
      JSON.stringify({ version: 4, entries: [withExtra], batches: [] }),
    );
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [entry()], batches: [] },
      warnings: [],
    });
  });
});

describe('version-1 migration', () => {
  function legacyFlatEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'a1',
      kind: 'manual',
      gridX: 2,
      gridY: 1,
      heightUnits: 3,
      // Version-1 entries carried the stacking-lip flag. The lip is no longer
      // optional, so the field is read and ignored.
      stackingLip: true,
      magnetHoles: false,
      dividerCountX: 0,
      dividerCountY: 0,
      labelText: '',
      labelText2: '',
      labelIcon: null,
      quantity: 1,
      createdAt: '2026-07-01T10:00:00.000Z',
      ...overrides,
    };
  }

  // Version-1 entries with no label were plain bins with no label feature,
  // so they convert without the insert slot.
  const plainBinEntry = () =>
    entry({ product: { kind: 'bin', labelSlot: false, bin: manualBin() } });

  it('imports queued version-1 entries and starts with no batches', () => {
    const legacy = { ...legacyFlatEntry(), status: 'queued' };
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [legacy] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [plainBinEntry()], batches: [] },
      warnings: [],
    });
  });

  it('drops version-1 entries that were already printed', () => {
    const queued = { ...legacyFlatEntry(), status: 'queued' };
    const printed = {
      ...legacyFlatEntry({ id: 'b2' }),
      status: 'printed',
      printedAt: '2026-07-02T09:30:00.000Z',
    };
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [queued, printed] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [plainBinEntry()], batches: [] },
      warnings: [],
    });
  });

  it('defaults dividers and the second label line on old version-1 files', () => {
    const legacy: Record<string, unknown> = { ...legacyFlatEntry(), status: 'queued' };
    delete legacy.dividerCountX;
    delete legacy.dividerCountY;
    delete legacy.labelText2;
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [legacy] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [plainBinEntry()], batches: [] },
      warnings: [],
    });
  });
});

describe('version-3 migration', () => {
  // Version-3 files carry the same product shape as version 4 plus the
  // stacking-lip flag on every bin. The lip is now always present, so the
  // field is ignored on read whichever value it holds, and the plan loads
  // without an error or a warning.
  function version3Bin(stackingLip: boolean): Record<string, unknown> {
    return { ...manualBin(), stackingLip };
  }

  it.each([true, false])('ignores the stacking-lip flag on a version-3 bin (%s)', (flag) => {
    const raw = {
      ...entry(),
      product: { kind: 'bin', labelSlot: true, bin: version3Bin(flag) },
    };
    const result = parsePlanFile(JSON.stringify({ version: 3, entries: [raw], batches: [] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [entry()], batches: [] },
      warnings: [],
    });
  });

  it('ignores the stacking-lip flag on a version-3 batch item', () => {
    const rawBatch = {
      ...batch(),
      items: [
        { ...batchItem(), product: { kind: 'bin', labelSlot: true, bin: version3Bin(false) } },
      ],
    };
    const result = parsePlanFile(
      JSON.stringify({ version: 3, entries: [], batches: [rawBatch] }),
    );
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [], batches: [batch()] },
      warnings: [],
    });
  });
});

describe('validateEntry', () => {
  it('accepts a complete valid entry', () => {
    expect(validateEntry(entry())).toBeNull();
  });

  it.each([
    ['gridX', 0, 'gridX must be an integer of at least 1'],
    ['gridY', 1.5, 'gridY must be an integer of at least 1'],
    ['heightUnits', 1, 'heightUnits must be an integer of at least 2'],
    ['magnetHoles', 1, 'magnetHoles must be true or false'],
    ['dividerCountX', -1, 'dividerCountX must be an integer of at least 0'],
    ['dividerCountY', 0.5, 'dividerCountY must be an integer of at least 0'],
  ])('rejects a bad bin %s field', (field, value, message) => {
    const raw = entry({
      product: { kind: 'bin', labelSlot: true, bin: { ...manualBin(), [field]: value } },
    });
    expect(validateEntry(raw)).toBe(`entry a1: ${message}`);
  });

  it.each([
    ['quantity', 0, 'quantity must be an integer of at least 1'],
    ['createdAt', 'yesterday', 'createdAt must be an ISO 8601 timestamp'],
    ['notes', 5, 'notes must be a string'],
  ])('rejects a bad entry %s field', (field, value, message) => {
    const raw = { ...entry(), [field]: value };
    expect(validateEntry(raw)).toBe(`entry a1: ${message}`);
  });

  it('rejects an entry with a missing field', () => {
    const raw: Record<string, unknown> = { ...entry() };
    delete raw.quantity;
    expect(validateEntry(raw)).toBe('entry a1: quantity must be an integer of at least 1');
  });

  it('rejects a non-object', () => {
    expect(validateEntry('hello')).toBe('an entry is not an object');
  });

  it('rejects a missing id', () => {
    const raw: Record<string, unknown> = { ...entry() };
    delete raw.id;
    expect(validateEntry(raw)).toBe('an entry is missing its id');
  });
});

describe('validateBatch', () => {
  it('accepts a complete valid batch', () => {
    expect(validateBatch(batch())).toBeNull();
  });

  it('accepts a batch item without a sourceEntryId', () => {
    const item: Record<string, unknown> = { ...batchItem() };
    delete item.sourceEntryId;
    expect(validateBatch(batch({ items: [item as unknown as BatchItem] }))).toBeNull();
  });

  it('rejects a missing id', () => {
    const raw: Record<string, unknown> = { ...batch() };
    delete raw.id;
    expect(validateBatch(raw)).toBe('a batch is missing its id');
  });

  it('rejects a bad item product field', () => {
    const item = batchItem();
    const badItem = {
      ...item,
      product: { kind: 'bin', labelSlot: true, bin: { ...manualBin(), gridX: 'two' } },
    };
    expect(validateBatch(batch({ items: [badItem as unknown as BatchItem] }))).toBe(
      'batch batch1: item i1: gridX must be an integer of at least 1',
    );
  });

  it('rejects a missing items list', () => {
    const raw: Record<string, unknown> = { ...batch() };
    delete raw.items;
    expect(validateBatch(raw)).toBe('batch batch1: items must be a list');
  });
});

describe('mergeEntries', () => {
  it('replaces entries with matching ids and appends new ones', () => {
    const existing = [
      entry(),
      entry({ id: 'b2', product: { kind: 'insert', origin: 'manual', cells: 1, content: { text: 'old', text2: '', icon: null } } }),
    ];
    const imported = [
      entry({ id: 'b2', product: { kind: 'insert', origin: 'manual', cells: 1, content: { text: 'new', text2: '', icon: null } } }),
      entry({ id: 'c3' }),
    ];
    const merged = mergeEntries(existing, imported);
    expect(merged.map((e) => e.id)).toEqual(['a1', 'b2', 'c3']);
    expect((merged[1].product as ManualInsertProduct).content.text).toBe('new');
  });

  it('keeps existing entries untouched when the import shares no ids', () => {
    const existing = [entry()];
    const merged = mergeEntries(existing, [entry({ id: 'z9' })]);
    expect(merged).toEqual([existing[0], entry({ id: 'z9' })]);
  });
});

describe('mergeBatches', () => {
  it('replaces batches with matching ids and appends new ones', () => {
    const existing = [batch(), batch({ id: 'batch2', name: 'old name' })];
    const imported = [batch({ id: 'batch2', name: 'new name' }), batch({ id: 'batch3' })];
    const merged = mergeBatches(existing, imported);
    expect(merged.map((b) => b.id)).toEqual(['batch1', 'batch2', 'batch3']);
    expect(merged[1].name).toBe('new name');
  });
});

describe('bin entry kinds in plan files', () => {
  it('round-trips a screw entry with its screw description', () => {
    const imperial = entry({
      id: 's1',
      product: {
        kind: 'binWithInsert',
        bin: screwBin({ screw: screwSpec({ thread: '#8', lengthMm: 38, enteredLengthText: '1-1/2"' }) }),
        insert: { text: '#8 x 1-1/2"', text2: '', icon: 'countersunk screw' },
      },
    });
    const lengthless = entry({
      id: 's2',
      product: {
        kind: 'binWithInsert',
        bin: screwBin({ screw: screwSpec({ thread: 'M5', lengthMm: null, head: 'hex nut' }) }),
        insert: { text: 'M5 NUT', text2: '', icon: 'hex nut' },
      },
    });
    const result = parsePlanFile(serializePlanFile([imperial, lengthless], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [imperial, lengthless], batches: [] },
      warnings: [],
    });
  });

  it('round-trips a traced entry with pockets and no divider fields', () => {
    const traced = entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [traced], batches: [] },
      warnings: [],
    });
  });

  it('round-trips a batch item with pocket and screw products', () => {
    const withSnapshots = batch({
      items: [
        batchItem({ product: { kind: 'bin', labelSlot: true, bin: tracedBin() } }),
        batchItem({
          id: 'i2',
          product: {
            kind: 'binWithInsert',
            bin: screwBin(),
            insert: { text: 'M3 x 20', text2: '', icon: 'countersunk screw' },
          },
        }),
      ],
    });
    const result = parsePlanFile(serializePlanFile([], [withSnapshots]));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [], batches: [withSnapshots] },
      warnings: [],
    });
  });

  it('rejects an unknown product kind', () => {
    expect(validateEntry({ ...entry(), product: { kind: 'mystery' } })).toBe(
      'entry a1: product kind must be bin, binWithInsert or insert',
    );
  });

  it('accepts a fused binWithInsert and round-trips the fused flag', () => {
    const fused = entry({
      id: 'f1',
      product: {
        kind: 'binWithInsert',
        bin: manualBin(),
        insert: { text: 'M3 x 20', text2: '', icon: 'countersunk screw' },
        fused: true,
      },
    });
    expect(validateEntry(fused)).toBeNull();
    const result = parsePlanFile(serializePlanFile([fused], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [fused], batches: [] },
      warnings: [],
    });
  });

  it('rejects a non-boolean fused value on a binWithInsert', () => {
    const bad: Product = {
      kind: 'binWithInsert',
      bin: manualBin(),
      insert: { text: 'M3', text2: '', icon: null },
      fused: 'yes' as never,
    };
    expect(validateEntry(entry({ id: 'f1', product: bad }))).toBe(
      'entry f1: fused must be true or false',
    );
  });

  it('rejects a traced bin without pockets', () => {
    const bad: Product = { kind: 'bin', bin: { ...tracedBin() } };
    delete (bad.bin as Record<string, unknown>).pockets;
    expect(validateEntry(entry({ id: 't1', product: bad }))).toBe(
      'entry t1: pockets must be an object',
    );
  });

  it('rejects a traced bin with divider fields', () => {
    const bad: Product = { kind: 'bin', bin: { ...tracedBin(), dividerCountX: 1 } as never };
    expect(validateEntry(entry({ id: 't1', product: bad }))).toBe(
      'entry t1: a traced bin cannot have divider walls',
    );
  });

  it('rejects a bin origin that is not manual, screw or traced', () => {
    const bad: Product = { kind: 'bin', bin: { ...manualBin(), origin: 'mystery' as never } };
    expect(validateEntry(entry({ product: bad }))).toBe(
      'entry a1: bin origin must be manual, screw or traced',
    );
  });

  it('rejects a screw bin without its screw description', () => {
    const bad = {
      ...entry({
        id: 's1',
        product: { kind: 'bin', labelSlot: true, bin: screwBin() } as unknown as Product,
      }),
    };
    delete (bad.product as { bin: Record<string, unknown> }).bin.screw;
    expect(validateEntry(bad)).toBe('entry s1: screw must be an object');
  });

  it('rejects a screw bin with an unknown head type', () => {
    const bad = entry({
      id: 's1',
      product: {
        kind: 'bin',
        labelSlot: true,
        bin: screwBin({ screw: { ...screwSpec(), head: 'mushroom' as never } }),
      } as unknown as Product,
    });
    expect(validateEntry(bad)).toBe('entry s1: screw head must be a known head type or null');
  });
});

describe('trace sources in plan files', () => {
  function tracePaper() {
    return {
      corners: {
        tl: { x: 100, y: 120 },
        tr: { x: 900, y: 110 },
        br: { x: 920, y: 700 },
        bl: { x: 90, y: 710 },
      },
      kind: 'a4' as const,
    };
  }

  it('round-trips a traced entry with its trace source id, paper and clicks', () => {
    const traced = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ traceSourceId: 'photo-1', paper: tracePaper() }) },
    });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [traced], batches: [] },
      warnings: [],
    });
  });

  it('accepts a traced entry without trace source fields (imported plan)', () => {
    expect(validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } }))).toBeNull();
  });

  it('defaults missing tool clicks to an empty list on old plans', () => {
    const legacy = entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } });
    const raw = JSON.parse(serializePlanFile([legacy], [])) as {
      entries: Array<{ product: { bin: { pockets: { tools: Array<Record<string, unknown>> } } } }>;
    };
    delete raw.entries[0].product.bin.pockets.tools[0].clicks;
    const result = parsePlanFile(JSON.stringify({ ...raw, version: 4, batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const bin = result.plan.entries[0].product as { bin: TracedBin };
      expect(bin.bin.pockets.tools[0].clicks).toEqual([]);
    }
  });

  it('defaults missing hole-fill fields on old plans without a warning', () => {
    const legacy = entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } });
    const raw = JSON.parse(serializePlanFile([legacy], [])) as {
      entries: Array<{ product: { bin: { pockets: { tools: Array<Record<string, unknown>> } } } }>;
    };
    delete raw.entries[0].product.bin.pockets.tools[0].minHoleWidthMm;
    delete raw.entries[0].product.bin.pockets.tools[0].filledHoleIndices;
    const result = parsePlanFile(JSON.stringify({ ...raw, version: 4, batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
      const bin = result.plan.entries[0].product as { bin: TracedBin };
      // The layout model's default minimum hole width, and no filled holes.
      expect(bin.bin.pockets.tools[0].minHoleWidthMm).toBe(1.6);
      expect(bin.bin.pockets.tools[0].filledHoleIndices).toEqual([]);
    }
  });

  it('rejects a non-numeric minimum hole width', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).minHoleWidthMm = 'wide';
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: minHoleWidthMm must be a number of at least 0');
  });

  it('rejects a negative minimum hole width', () => {
    const bad = pockets();
    bad.tools[0].minHoleWidthMm = -1;
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: minHoleWidthMm must be a number of at least 0');
  });

  it('rejects a filled hole index outside the outline holes', () => {
    const bad = pockets();
    // The fixture tool has one hole, so index 1 refers to nothing.
    bad.tools[0].filledHoleIndices = [1];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe(
      "entry t1: pocket tool t1: filledHoleIndices must be whole numbers referring to the tool's holes",
    );
  });

  it('rejects a malformed click', () => {
    const bad = pockets();
    bad.tools[0].clicks = [{ x: 1, y: 2, label: 3 as never }];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: a click needs x, y and a label of 0 or 1');
  });

  it('round-trips a tool carrying mixed add and erase brush strokes', () => {
    const withStrokes = pockets();
    (withStrokes.tools[0] as Record<string, unknown>).brushStrokes = [
      { mode: 'add', radiusMm: 4, points: [{ x: 12, y: 20 }, { x: 30, y: 24 }] },
      { mode: 'erase', radiusMm: 2.5, points: [{ x: 50, y: 60 }] },
    ];
    const traced = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: withStrokes }) },
    });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [traced], batches: [] },
      warnings: [],
    });
  });

  it('round-trips a tool carrying a smooth brush stroke', () => {
    const withStrokes = pockets();
    (withStrokes.tools[0] as Record<string, unknown>).brushStrokes = [
      { mode: 'smooth', radiusMm: 3, points: [{ x: 18, y: 44 }, { x: 22, y: 47 }] },
    ];
    const traced = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: withStrokes }) },
    });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [traced], batches: [] },
      warnings: [],
    });
  });

  it('leaves a tool without brush strokes free of the brushStrokes key', () => {
    const traced = entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bin = result.plan.entries[0].product as { bin: TracedBin };
    expect('brushStrokes' in bin.bin.pockets.tools[0]).toBe(false);
  });

  it('loads a legacy plan whose tools predate brush strokes without a warning', () => {
    const legacy = entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } });
    const raw = JSON.parse(serializePlanFile([legacy], [])) as {
      entries: Array<{ product: { bin: { pockets: { tools: Array<Record<string, unknown>> } } } }>;
    };
    delete raw.entries[0].product.bin.pockets.tools[0].brushStrokes;
    const result = parsePlanFile(JSON.stringify({ ...raw, version: 4, batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it('rejects a brush stroke with an unknown mode', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).brushStrokes = [
      { mode: 'paint', radiusMm: 4, points: [{ x: 1, y: 2 }] },
    ];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe(
      'entry t1: pocket tool t1: a brush stroke needs mode add, erase or smooth, a radiusMm above 0 and a points list',
    );
  });

  it('rejects a brush stroke with a non-positive radius', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).brushStrokes = [
      { mode: 'add', radiusMm: 0, points: [{ x: 1, y: 2 }] },
    ];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe(
      'entry t1: pocket tool t1: a brush stroke needs mode add, erase or smooth, a radiusMm above 0 and a points list',
    );
  });

  it('rejects a brush stroke whose points is not a list', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).brushStrokes = [
      { mode: 'add', radiusMm: 4, points: 'here' },
    ];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe(
      'entry t1: pocket tool t1: a brush stroke needs mode add, erase or smooth, a radiusMm above 0 and a points list',
    );
  });

  it('rejects a brush stroke point with a non-finite coordinate', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).brushStrokes = [
      { mode: 'add', radiusMm: 4, points: [{ x: 1, y: Number.NaN }] },
    ];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: a brush stroke point needs x and y');
  });

  it('rejects a brushStrokes field that is not a list', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).brushStrokes = { mode: 'add' };
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: brushStrokes must be a list');
  });

  it('rejects an empty traceSourceId', () => {
    const bad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ traceSourceId: '' }) },
    });
    expect(validateEntry(bad)).toBe('entry t1: traceSourceId must be a non-empty string');
  });

  it('rejects an unknown paper kind', () => {
    const paper = { ...tracePaper(), kind: 'a3' };
    const bad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ paper: paper as never }) },
    });
    expect(validateEntry(bad)).toBe('entry t1: paper kind must be a4 or letter');
  });

  it('rejects a paper corner without coordinates', () => {
    const paper = tracePaper() as unknown as { corners: Record<string, unknown>; kind: string };
    paper.corners.br = { x: 5 };
    const bad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ paper: paper as never }) },
    });
    expect(validateEntry(bad)).toBe('entry t1: paper corner br needs x and y coordinates');
  });

  it('round-trips a batch item carrying the trace source snapshot', () => {
    const withSource = batch({
      items: [
        batchItem({
          product: { kind: 'bin', labelSlot: true, bin: tracedBin({ traceSourceId: 'photo-1', paper: tracePaper() }) },
        }),
      ],
    });
    const result = parsePlanFile(serializePlanFile([], [withSource]));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [], batches: [withSource] },
      warnings: [],
    });
  });

  it('rejects a batch item with a malformed paper field', () => {
    const bad = batch({
      items: [
        batchItem({
          product: { kind: 'bin', labelSlot: true, bin: tracedBin({ paper: 'a4' as never }) },
        }),
      ],
    });
    const result = parsePlanFile(serializePlanFile([], [bad]));
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: batch batch1: item i1: paper must be an object.',
    });
  });
});

describe('pockets in plan files', () => {
  it('rejects a placement naming a tool that is not in the pockets', () => {
    const bad = pockets();
    bad.placements[0].toolId = 'ghost';
    const entryWithBad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) },
    });
    expect(validateEntry(entryWithBad)).toBe(
      'entry t1: a pocket placement refers to a tool that is not in the pockets',
    );
  });

  it('rejects an outline with fewer than 3 outer points', () => {
    const bad = pockets();
    bad.tools[0].outline.outer = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const entryWithBad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) },
    });
    expect(validateEntry(entryWithBad)).toBe(
      'entry t1: pocket tool t1: outline needs at least 3 outer points',
    );
  });

  it('rejects a pocket depth of zero', () => {
    const bad = pockets();
    bad.placements[0].pocketDepthMm = 0;
    const entryWithBad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) },
    });
    expect(validateEntry(entryWithBad)).toBe(
      'entry t1: a pocket placement needs xMm, yMm and a pocketDepthMm above 0',
    );
  });

  it('round-trips a traced entry whose finger hole is an elongated slot', () => {
    const withSlot = pockets();
    withSlot.tools[0].fingerHoles = [{ x: 0, y: 0, x2: 12, y2: -3, diameterMm: 20 }];
    const traced = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: withSlot }) },
    });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 4, entries: [traced], batches: [] },
      warnings: [],
    });
  });

  it('accepts a circular finger hole without slot endpoints (old plans)', () => {
    expect(validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } }))).toBeNull();
  });

  it('rejects a finger hole with only one slot coordinate', () => {
    const bad = pockets();
    bad.tools[0].fingerHoles = [{ x: 0, y: 0, x2: 12, diameterMm: 20 }];
    const entryWithBad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) },
    });
    expect(validateEntry(entryWithBad)).toBe(
      'entry t1: pocket tool t1: an elongated finger hole needs both x2 and y2 as numbers',
    );
  });
});

describe('legacy label mode conversion (versions 1 and 2)', () => {
  function legacyFlatEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      quantity: 1,
      createdAt: '2026-07-01T10:00:00.000Z',
      ...overrides,
    };
  }

  it('converts an embossed label (with content) into a bin with its insert', () => {
    const legacy = legacyFlatEntry({ labelMode: 'embossed' });
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'binWithInsert',
        bin: manualBin(),
        insert: { text: 'M3 bolts', text2: '', icon: 'bolt' },
      });
    }
  });

  it('converts an embossed label with no content into a plain bin without the slot', () => {
    const legacy = legacyFlatEntry({ labelMode: 'embossed', labelText: '', labelIcon: null });
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'bin',
        bin: manualBin(),
        labelSlot: false,
      });
    }
  });

  it('leaves an absent labelMode defaulting to embossed conversion behavior', () => {
    const legacy = legacyFlatEntry();
    delete legacy.labelMode;
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'binWithInsert',
        bin: manualBin(),
        insert: { text: 'M3 bolts', text2: '', icon: 'bolt' },
      });
    }
  });

  it('converts a slot label into a slotted bin, dropping any content with a warning', () => {
    const legacy = legacyFlatEntry({ labelMode: 'slot' });
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'bin',
        bin: manualBin(),
        labelSlot: true,
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('dropped');
    }
  });

  it('converts a slot-insert label into a bin with its insert', () => {
    const legacy = legacyFlatEntry({ labelMode: 'slot-insert' });
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'binWithInsert',
        bin: manualBin(),
        insert: { text: 'M3 bolts', text2: '', icon: 'bolt' },
      });
    }
  });

  it('converts a manual insert-only entry into a standalone manual insert product', () => {
    const legacy = legacyFlatEntry({ labelMode: 'insert' });
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'insert',
        origin: 'manual',
        cells: 2,
        content: { text: 'M3 bolts', text2: '', icon: 'bolt' },
      });
      expect(result.warnings).toEqual([]);
    }
  });

  it('converts a screw insert-only entry into a standalone screw insert product', () => {
    const legacy = legacyFlatEntry({
      kind: 'screw',
      labelMode: 'insert',
      screw: screwSpec(),
    });
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'insert',
        origin: 'screw',
        cells: 2,
        content: { text: 'M3 bolts', text2: '', icon: 'bolt' },
        screw: screwSpec(),
      });
    }
  });

  it('converts a traced insert-only entry into a standalone manual insert with a dropped-pockets warning', () => {
    const legacy = legacyFlatEntry({ kind: 'traced', labelMode: 'insert', pockets: pockets() });
    delete legacy.dividerCountX;
    delete legacy.dividerCountY;
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'insert',
        origin: 'manual',
        cells: 2,
        content: { text: 'M3 bolts', text2: '', icon: 'bolt' },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('dropped');
    }
  });

  it('round-trips a legacy screw entry with its screw description as a bin with insert', () => {
    const legacy = legacyFlatEntry({ kind: 'screw', screw: screwSpec({ thread: '#8', lengthMm: 38 }) });
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'binWithInsert',
        bin: screwBin({ screw: screwSpec({ thread: '#8', lengthMm: 38 }) }),
        insert: { text: 'M3 bolts', text2: '', icon: 'bolt' },
      });
    }
  });

  it('migrates a legacy entry without kind and with pockets to a traced bin', () => {
    const legacy: Record<string, unknown> = {
      ...legacyFlatEntry({ labelMode: 'slot', pockets: pockets() }),
    };
    delete legacy.kind;
    delete legacy.dividerCountX;
    delete legacy.dividerCountY;
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'bin',
        bin: tracedBin(),
        labelSlot: true,
      });
    }
  });

  it('migrates a legacy entry without kind and without pockets to a manual bin', () => {
    const legacy: Record<string, unknown> = { ...legacyFlatEntry({ labelMode: 'slot' }) };
    delete legacy.kind;
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0].product).toEqual({
        kind: 'bin',
        bin: manualBin(),
        labelSlot: true,
      });
    }
  });

  it('rejects an unknown legacy kind', () => {
    const result = parsePlanFile(
      JSON.stringify({ version: 2, entries: [{ ...legacyFlatEntry(), kind: 'mystery' }], batches: [] }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: entry a1: kind must be manual, screw or traced.',
    });
  });

  it('rejects an unknown legacy label mode', () => {
    const result = parsePlanFile(
      JSON.stringify({ version: 2, entries: [{ ...legacyFlatEntry(), labelMode: 'sticker' }], batches: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('labelMode must be embossed, slot, slot-insert or insert');
    }
  });
});

describe('screw bins stored without their label insert', () => {
  it('repairs a version-4 entry, keeps the rest of the plan and warns', () => {
    const bare = entry({
      id: 's1',
      product: {
        kind: 'bin',
        labelSlot: true,
        bin: screwBin({ screw: screwSpec({ thread: 'M4', lengthMm: 12 }) }),
      } as unknown as Product,
    });
    const manual = entry({ id: 'm1' });
    const text = JSON.stringify({
      version: 4,
      entries: [bare, manual],
      batches: [batch()],
    });
    const result = parsePlanFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.entries[0].product).toEqual({
      kind: 'binWithInsert',
      bin: screwBin({ screw: screwSpec({ thread: 'M4', lengthMm: 12 }) }),
      insert: { text: 'M4 x 12', text2: '', icon: 'countersunk screw' },
    });
    expect(result.plan.entries[0].id).toBe('s1');
    expect(result.plan.entries[1]).toEqual(manual);
    expect(result.plan.batches).toEqual([batch()]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe(
      'entry s1 was a screw bin ordered without its label insert; the insert was added back with the label "M4 x 12", because a screw bin is printed to carry that label.',
    );
  });

  it('repairs a bare screw bin snapshotted inside a batch item', () => {
    const withBare = batch({
      items: [
        batchItem(),
        batchItem({
          id: 'i2',
          product: {
            kind: 'bin',
            labelSlot: false,
            bin: screwBin({ screw: screwSpec({ thread: 'M5', lengthMm: null, head: 'washer' }) }),
          } as unknown as Product,
        }),
      ],
    });
    const result = parsePlanFile(JSON.stringify({ version: 4, entries: [], batches: [withBare] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = result.plan.batches[0].items;
    expect(items[0]).toEqual(batchItem());
    expect(items[1].product).toEqual({
      kind: 'binWithInsert',
      bin: screwBin({ screw: screwSpec({ thread: 'M5', lengthMm: null, head: 'washer' }) }),
      insert: { text: 'M5 WASHER', text2: '', icon: 'washer' },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('batch batch1: item i2');
  });

  it('repairs a legacy slotted screw bin through the same path', () => {
    const legacy = {
      id: 'a1',
      kind: 'screw',
      gridX: 2,
      gridY: 1,
      heightUnits: 3,
      magnetHoles: false,
      dividerCountX: 0,
      dividerCountY: 0,
      labelText: '',
      labelText2: '',
      labelIcon: null,
      labelMode: 'slot',
      screw: screwSpec({ thread: 'M6', lengthMm: 30 }),
      quantity: 1,
      createdAt: '2026-07-01T10:00:00.000Z',
    };
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.entries[0].product).toEqual({
      kind: 'binWithInsert',
      bin: screwBin({ screw: screwSpec({ thread: 'M6', lengthMm: 30 }) }),
      insert: { text: 'M6 x 30', text2: '', icon: 'countersunk screw' },
    });
    expect(result.warnings).toHaveLength(1);
  });
});
