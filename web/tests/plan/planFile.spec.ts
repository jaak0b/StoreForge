import { describe, expect, it } from 'vitest';
import {
  mergeBatches,
  mergeEntries,
  parsePlanFile,
  serializePlanFile,
  validateBatch,
  validateEntry,
  type PlanParseResult,
} from '../../src/engine/plan/planFile';
import type {
  BatchItem,
  BinPockets,
  CutoutBin,
  CutoutModel,
  ManualBin,
  ManualInsertProduct,
  PrintBatch,
  Product,
  QueueEntry,
  ScrewBin,
  ScrewSpec,
  TracedBin,
} from '../../src/engine/plan/types';
import { PLAN_FILE_VERSION } from '../../src/engine/plan/types';
import { evenDividerWalls } from '../../src/engine/gridfinity/dividerModel';

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
    placements: [{ toolId: 't1', xMm: 3, yMm: -4, pocketDepthMm: 12, draftAngleDeg: 0 }],
  };
}

function tracedBin(overrides: Partial<TracedBin> = {}): TracedBin {
  const { walls, origin, ...base } = manualBin();
  void walls;
  void origin;
  return { ...base, origin: 'traced', pockets: pockets(), edits: [], ...overrides };
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
    expect(result).toEqual({ ok: true, plan: { version: PLAN_FILE_VERSION, entries, batches, groups: [] }, warnings: [] });
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
    const futureVersion = PLAN_FILE_VERSION + 1;
    const result = parsePlanFile(
      JSON.stringify({ version: futureVersion, entries: [], batches: [] }),
    );
    // The exact string catches the guard being hardcoded instead of derived
    // from the version constant.
    expect(result).toEqual({
      ok: false,
      error: `The file has plan version ${futureVersion}, but this app reads versions 1 to ${PLAN_FILE_VERSION}.`,
    });
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
      error:
        'The plan is invalid: entry b2: The bin width must be a whole number of at least 1 grid unit.',
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
      error:
        'The plan is invalid: batch batch1: item i1: The count must be a whole number of at least 1.',
    });
  });

  it('drops unknown extra fields on an entry when parsing', () => {
    const withExtra = { ...entry(), somethingElse: 42 };
    const result = parsePlanFile(
      JSON.stringify({ version: 4, entries: [withExtra], batches: [] }),
    );
    expect(result).toEqual({
      ok: true,
      plan: { version: PLAN_FILE_VERSION, entries: [entry()], batches: [], groups: [] },
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
      plan: { version: PLAN_FILE_VERSION, entries: [plainBinEntry()], batches: [], groups: [] },
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
      plan: { version: PLAN_FILE_VERSION, entries: [plainBinEntry()], batches: [], groups: [] },
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
      plan: { version: PLAN_FILE_VERSION, entries: [plainBinEntry()], batches: [], groups: [] },
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
      plan: { version: PLAN_FILE_VERSION, entries: [entry()], batches: [], groups: [] },
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
      plan: { version: PLAN_FILE_VERSION, entries: [], batches: [batch()], groups: [] },
      warnings: [],
    });
  });
});

describe('divider walls migration', () => {
  it('converts version-4 divider counts to walls on load', () => {
    const v4Bin = { ...manualBin(), dividerCountX: 2, dividerCountY: 1 } as unknown;
    delete (v4Bin as Record<string, unknown>).walls;
    const raw = { ...entry(), product: { kind: 'bin', labelSlot: true, bin: v4Bin } };
    const result = parsePlanFile(JSON.stringify({ version: 4, entries: [raw], batches: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bin = result.plan.entries[0].product;
    if (bin.kind !== 'bin' || bin.bin.origin !== 'manual') throw new Error('unexpected product');
    expect(bin.bin.walls).toEqual(evenDividerWalls(2, 1, 2, 1));
  });

  it('round-trips version-5 walls verbatim', () => {
    const walls = [
      { x1: -5, y1: -8, x2: -5, y2: 8 },
      { x1: 6, y1: -3, x2: 20, y2: 4 },
    ];
    const withWalls = entry({
      product: { kind: 'bin', labelSlot: true, bin: manualBin({ walls }) },
    });
    const result = parsePlanFile(serializePlanFile([withWalls], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: PLAN_FILE_VERSION, entries: [withWalls], batches: [], groups: [] },
      warnings: [],
    });
  });
});

describe('validateEntry', () => {
  it('accepts a complete valid entry', () => {
    expect(validateEntry(entry())).toBeNull();
  });

  it('accepts a fractional bin height', () => {
    const raw = entry({
      product: { kind: 'bin', labelSlot: true, bin: { ...manualBin(), heightUnits: 5.5 } },
    });
    expect(validateEntry(raw)).toBeNull();
  });

  it.each([
    ['gridX', 0, 'The bin width must be a whole number of at least 1 grid unit.'],
    ['gridY', 1.5, 'The bin depth must be a whole number of at least 1 grid unit.'],
    ['heightUnits', 1, 'The bin height must be a number of at least 2 height units.'],
    ['heightUnits', NaN, 'The bin height must be a number of at least 2 height units.'],
    ['magnetHoles', 1, 'The magnet holes setting must be true or false.'],
    ['walls', 'nope', 'The divider walls must be a list.'],
    [
      'walls',
      [{ x1: 0, y1: 0, x2: 1 }],
      'A divider wall needs finite x1, y1, x2 and y2 coordinates.',
    ],
  ])('rejects a bad bin %s field', (field, value, message) => {
    const raw = entry({
      product: { kind: 'bin', labelSlot: true, bin: { ...manualBin(), [field]: value } },
    });
    expect(validateEntry(raw)).toBe(`entry a1: ${message}`);
  });

  it.each([
    ['quantity', 0, 'The quantity must be a whole number of at least 1.'],
    ['createdAt', 'yesterday', 'The creation time must be an ISO 8601 timestamp.'],
    ['notes', 5, 'The notes must be text.'],
  ])('rejects a bad entry %s field', (field, value, message) => {
    const raw = { ...entry(), [field]: value };
    expect(validateEntry(raw)).toBe(`entry a1: ${message}`);
  });

  it('rejects an entry with a missing field', () => {
    const raw: Record<string, unknown> = { ...entry() };
    delete raw.quantity;
    expect(validateEntry(raw)).toBe('entry a1: The quantity must be a whole number of at least 1.');
  });

  it('rejects a non-object', () => {
    expect(validateEntry('hello')).toBe('An entry is not an object.');
  });

  it('rejects a missing id', () => {
    const raw: Record<string, unknown> = { ...entry() };
    delete raw.id;
    expect(validateEntry(raw)).toBe('An entry is missing its id.');
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
    expect(validateBatch(raw)).toBe('A batch is missing its id.');
  });

  it('rejects a bad item product field', () => {
    const item = batchItem();
    const badItem = {
      ...item,
      product: { kind: 'bin', labelSlot: true, bin: { ...manualBin(), gridX: 'two' } },
    };
    expect(validateBatch(batch({ items: [badItem as unknown as BatchItem] }))).toBe(
      'batch batch1: item i1: The bin width must be a whole number of at least 1 grid unit.',
    );
  });

  it('rejects a missing items list', () => {
    const raw: Record<string, unknown> = { ...batch() };
    delete raw.items;
    expect(validateBatch(raw)).toBe('batch batch1: The items must be a list.');
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
      plan: { version: PLAN_FILE_VERSION, entries: [imperial, lengthless], batches: [], groups: [] },
      warnings: [],
    });
  });

  it('round-trips a traced entry with pockets and no divider fields', () => {
    const traced = entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin() } });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: PLAN_FILE_VERSION, entries: [traced], batches: [], groups: [] },
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
      plan: { version: PLAN_FILE_VERSION, entries: [], batches: [withSnapshots], groups: [] },
      warnings: [],
    });
  });

  it('rejects an unknown product kind', () => {
    expect(validateEntry({ ...entry(), product: { kind: 'mystery' } })).toBe(
      'entry a1: product kind must be bin, binWithInsert, insert, baseplate or clip',
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
      plan: { version: PLAN_FILE_VERSION, entries: [fused], batches: [], groups: [] },
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
      'entry f1: The fused setting must be true or false.',
    );
  });

  it('rejects a traced bin without pockets', () => {
    const bad: Product = { kind: 'bin', bin: { ...tracedBin() } };
    delete (bad.bin as Record<string, unknown>).pockets;
    expect(validateEntry(entry({ id: 't1', product: bad }))).toBe(
      'entry t1: The tool pockets must be an object.',
    );
  });

  it('rejects a traced bin with divider fields', () => {
    const bad: Product = { kind: 'bin', bin: { ...tracedBin(), dividerCountX: 1 } as never };
    expect(validateEntry(entry({ id: 't1', product: bad }))).toBe(
      'entry t1: A traced bin cannot have divider walls.',
    );
  });

  it('rejects a bin origin that is not manual, screw, traced or cutout', () => {
    const bad: Product = { kind: 'bin', bin: { ...manualBin(), origin: 'mystery' as never } };
    expect(validateEntry(entry({ product: bad }))).toBe(
      'entry a1: The bin origin must be manual, screw, traced or cutout.',
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
    expect(validateEntry(bad)).toBe('entry s1: The screw must be an object.');
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
    expect(validateEntry(bad)).toBe('entry s1: The screw head must be a known head type, or null.');
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
      plan: { version: PLAN_FILE_VERSION, entries: [traced], batches: [], groups: [] },
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
    ).toBe('entry t1: pocket tool t1: The minimum hole width must be a number of at least 0 mm.');
  });

  it('rejects a negative minimum hole width', () => {
    const bad = pockets();
    bad.tools[0].minHoleWidthMm = -1;
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: The minimum hole width must be a number of at least 0 mm.');
  });

  it('rejects a filled hole index outside the outline holes', () => {
    const bad = pockets();
    // The fixture tool has one hole, so index 1 refers to nothing.
    bad.tools[0].filledHoleIndices = [1];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe(
      "entry t1: pocket tool t1: The filled hole list must contain whole numbers referring to the tool's own holes.",
    );
  });

  it('rejects a malformed click', () => {
    const bad = pockets();
    bad.tools[0].clicks = [{ x: 1, y: 2, label: 3 as never }];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: A click needs an x, a y and a label of 0 or 1.');
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
      plan: { version: PLAN_FILE_VERSION, entries: [traced], batches: [], groups: [] },
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
      plan: { version: PLAN_FILE_VERSION, entries: [traced], batches: [], groups: [] },
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
      'entry t1: pocket tool t1: A brush stroke needs a mode of add, erase or smooth, a radius above 0 mm and a list of points.',
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
      'entry t1: pocket tool t1: A brush stroke needs a mode of add, erase or smooth, a radius above 0 mm and a list of points.',
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
      'entry t1: pocket tool t1: A brush stroke needs a mode of add, erase or smooth, a radius above 0 mm and a list of points.',
    );
  });

  it('rejects a brush stroke point with a non-finite coordinate', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).brushStrokes = [
      { mode: 'add', radiusMm: 4, points: [{ x: 1, y: Number.NaN }] },
    ];
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: A brush stroke point needs an x and a y.');
  });

  it('rejects a brushStrokes field that is not a list', () => {
    const bad = pockets();
    (bad.tools[0] as Record<string, unknown>).brushStrokes = { mode: 'add' };
    expect(
      validateEntry(entry({ id: 't1', product: { kind: 'bin', labelSlot: true, bin: tracedBin({ pockets: bad }) } })),
    ).toBe('entry t1: pocket tool t1: The brush strokes must be a list.');
  });

  it('rejects an empty traceSourceId', () => {
    const bad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ traceSourceId: '' }) },
    });
    expect(validateEntry(bad)).toBe('entry t1: The trace source id must be text that is not empty.');
  });

  it('rejects an unknown paper kind', () => {
    const paper = { ...tracePaper(), kind: 'a3' };
    const bad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ paper: paper as never }) },
    });
    expect(validateEntry(bad)).toBe('entry t1: The paper kind must be a4 or letter.');
  });

  it('rejects a paper corner without coordinates', () => {
    const paper = tracePaper() as unknown as { corners: Record<string, unknown>; kind: string };
    paper.corners.br = { x: 5 };
    const bad = entry({
      id: 't1',
      product: { kind: 'bin', labelSlot: true, bin: tracedBin({ paper: paper as never }) },
    });
    expect(validateEntry(bad)).toBe('entry t1: The paper corner br needs an x and a y coordinate.');
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
      plan: { version: PLAN_FILE_VERSION, entries: [], batches: [withSource], groups: [] },
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
      error: 'The plan is invalid: batch batch1: item i1: The paper must be an object.',
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
      'entry t1: A pocket placement refers to a tool that is not in the pockets.',
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
      'entry t1: pocket tool t1: The outline needs at least 3 outer points.',
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
      'entry t1: A pocket placement needs an x, a y and a pocket depth above 0 mm.',
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
      plan: { version: PLAN_FILE_VERSION, entries: [traced], batches: [], groups: [] },
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
      'entry t1: pocket tool t1: An elongated finger hole needs its second point, so x2 and y2 must both be numbers.',
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
      error: 'The plan is invalid: entry a1: The entry kind must be manual, screw or traced.',
    });
  });

  it('rejects an unknown legacy label mode', () => {
    const result = parsePlanFile(
      JSON.stringify({ version: 2, entries: [{ ...legacyFlatEntry(), labelMode: 'sticker' }], batches: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('The label mode must be embossed, slot, slot-insert or insert.');
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

/**
 * Wall sets a user can draw and the editor accepts, on footprints whose
 * interior is not a whole multiple of the snap step. Interior half-extents are
 * hand-calculated from the Gridfinity standard: n cells span n * 42 mm of pitch
 * less the 0.5 mm shared footprint clearance and a 0.95 mm wall per side, so a
 * 1-cell interior is 39.6 mm across and a 2-cell interior 81.6 mm.
 */
const ROUND_TRIP_WALLS = [
  { name: 'no walls', gridX: 2, gridY: 1, walls: [] },
  {
    name: 'a full-span wall',
    gridX: 1,
    gridY: 1,
    walls: [{ x1: 0, y1: -19.8, x2: 0, y2: 19.8 }],
  },
  {
    name: 'a wall ending in open interior',
    gridX: 2,
    gridY: 2,
    walls: [{ x1: 0, y1: -12, x2: 0, y2: 12 }],
  },
  {
    name: 'an angled wall with fractional coordinates',
    gridX: 2,
    gridY: 2,
    walls: [{ x1: -18.375, y1: -9.125, x2: 18.375, y2: 9.125 }],
  },
  {
    name: 'a T junction',
    gridX: 2,
    gridY: 2,
    walls: [
      { x1: -40.8, y1: 0, x2: 40.8, y2: 0 },
      { x1: 0, y1: 0, x2: 0, y2: 22 },
    ],
  },
  {
    name: 'four walls at once',
    gridX: 3,
    gridY: 2,
    walls: [
      { x1: -20, y1: -40.8, x2: -20, y2: 40.8 },
      { x1: 20, y1: -40.8, x2: 20, y2: 40.8 },
      { x1: -61.8, y1: 0, x2: -20, y2: 0 },
      { x1: 20, y1: 0, x2: 61.8, y2: 0 },
    ],
  },
];

describe('divider walls survive a save and reload', () => {
  it.each(ROUND_TRIP_WALLS)(
    'reloads $name on a manual bin exactly as saved',
    ({ gridX, gridY, walls }) => {
      // A wall configuration the editor accepted must come back byte for byte.
      // Silently dropping or rewriting one on save is invisible in the app
      // until the user reopens the bin and finds their layout changed.
      const entries = [
        entry({
          product: { kind: 'bin', labelSlot: true, bin: manualBin({ gridX, gridY, walls }) },
        }),
      ];

      const result = parsePlanFile(serializePlanFile(entries, []));

      expect(result).toEqual({ ok: true, plan: { version: PLAN_FILE_VERSION, entries, batches: [], groups: [] }, warnings: [] });
    },
  );

  it.each(ROUND_TRIP_WALLS)(
    'reloads $name on a screw bin exactly as saved',
    ({ gridX, gridY, walls }) => {
      // A screw bin derives its footprint from the screw, so its walls travel a
      // different load path than a manual bin's. They must survive it intact.
      const entries = [
        entry({
          product: {
            kind: 'binWithInsert',
            bin: screwBin({ gridX, gridY, walls }),
            insert: { text: 'M3 x 20', text2: '', icon: 'countersunk screw' },
          },
        }),
      ];

      const result = parsePlanFile(serializePlanFile(entries, []));

      expect(result).toEqual({ ok: true, plan: { version: PLAN_FILE_VERSION, entries, batches: [], groups: [] }, warnings: [] });
    },
  );

  it.each(ROUND_TRIP_WALLS)('reloads $name inside a print batch', ({ gridX, gridY, walls }) => {
    // A batch carries its own copy of the product, so it is a second place a
    // wall list can be lost between sessions.
    const batches = [
      batch({
        items: [
          batchItem({
            product: { kind: 'bin', labelSlot: true, bin: manualBin({ gridX, gridY, walls }) },
          }),
        ],
      }),
    ];

    const result = parsePlanFile(serializePlanFile([], batches));

    expect(result).toEqual({ ok: true, plan: { version: PLAN_FILE_VERSION, entries: [], batches, groups: [] }, warnings: [] });
  });
});

describe('cutout bins in plan files', () => {
  /** One carved model, complete in every field a version-7 plan stores. */
  function cutoutModel(overrides: Partial<CutoutModel> = {}): CutoutModel {
    return {
      id: 'm1',
      name: 'socket-19.stl',
      modelSourceId: 'model-a',
      triangleCount: 14842,
      unitScale: 1,
      sizeMm: { x: 24.5, y: 24.5, z: 40 },
      placement: { xMm: 12.4, yMm: -3.1, zMm: 21.75, rotXDeg: 0, rotYDeg: 90, rotZDeg: 15 },
      clearanceMm: 0.4,
      sweepEnabled: true,
      draftAngleDeg: 5,
      ...overrides,
    };
  }

  function cutoutBin(overrides: Partial<CutoutBin> = {}): CutoutBin {
    return {
      origin: 'cutout',
      gridX: 3,
      gridY: 2,
      heightUnits: 6,
      magnetHoles: true,
      models: [cutoutModel()],
      edits: [],
      ...overrides,
    };
  }

  /** An entry ordering a cutout bin. */
  function cutoutEntry(bin: CutoutBin = cutoutBin()): QueueEntry {
    return entry({ id: 'c1', product: { kind: 'bin', labelSlot: true, bin } });
  }

  /** A cutout product whose bin fields are deliberately malformed. */
  function badProduct(bin: Record<string, unknown>): Product {
    return { kind: 'bin', labelSlot: true, bin } as unknown as Product;
  }

  /**
   * Serializes one cutout entry, drops the named field from its single model,
   * and parses the result: the shape a plan written before that field existed
   * has on disk.
   */
  function withoutModelField(field: string): PlanParseResult {
    const raw = JSON.parse(serializePlanFile([cutoutEntry()], [])) as {
      entries: Array<{ product: { bin: { models: Record<string, unknown>[] } } }>;
    };
    delete raw.entries[0].product.bin.models[0][field];
    return parsePlanFile(JSON.stringify(raw));
  }

  /** The cutout bin of a parsed plan's single entry. */
  function loadedBin(result: PlanParseResult): CutoutBin {
    if (!result.ok) throw new Error(`expected the plan to load: ${result.error}`);
    return (result.plan.entries[0].product as { bin: CutoutBin }).bin;
  }

  it('round-trips a cutout bin with every model field intact', () => {
    const entries = [cutoutEntry()];

    const result = parsePlanFile(serializePlanFile(entries, []));

    expect(result).toEqual({ ok: true, plan: { version: PLAN_FILE_VERSION, entries, batches: [], groups: [] }, warnings: [] });
  });

  it('round-trips a cutout bin inside a print batch', () => {
    // A batch carries its own copy of the product, so it is a second place a
    // model list can be lost between sessions.
    const batches = [
      batch({ items: [batchItem({ product: { kind: 'bin', labelSlot: true, bin: cutoutBin() } })] }),
    ];

    const result = parsePlanFile(serializePlanFile([], batches));

    expect(result).toEqual({ ok: true, plan: { version: PLAN_FILE_VERSION, entries: [], batches, groups: [] }, warnings: [] });
  });

  it('keeps two models in one bin on their own clearances', () => {
    // A bin-wide clearance creeping back into the loader would collapse these
    // two values into one, giving one model the other's fit with no symptom
    // until the part is printed.
    const entries = [
      cutoutEntry(
        cutoutBin({
          models: [
            cutoutModel({ id: 'm1', clearanceMm: 0 }),
            cutoutModel({ id: 'm2', modelSourceId: 'model-b', clearanceMm: 0.6 }),
          ],
        }),
      ),
    ];

    const result = parsePlanFile(serializePlanFile(entries, []));

    expect(loadedBin(result).models.map((model) => model.clearanceMm)).toEqual([0, 0.6]);
  });

  it('defaults a model saved without a clearance to one nozzle width', () => {
    const result = withoutModelField('clearanceMm');

    expect(loadedBin(result).models[0].clearanceMm).toBe(0.4);
  });

  it('keeps a unit scale of 25.4, the value an inch-authored model needs', () => {
    const entries = [cutoutEntry(cutoutBin({ models: [cutoutModel({ unitScale: 25.4 })] }))];

    const result = parsePlanFile(serializePlanFile(entries, []));

    expect(loadedBin(result).models[0].unitScale).toBe(25.4);
  });

  it('defaults a model saved without a unit scale to millimetres', () => {
    // A plan written before the field existed described a model that was
    // already being treated as millimetres, so 1 reproduces what it meant.
    const result = withoutModelField('unitScale');

    expect(loadedBin(result).models[0].unitScale).toBe(1);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it('defaults an absent model size to zeroes, which the next generation recomputes', () => {
    const result = withoutModelField('sizeMm');

    expect(loadedBin(result).models[0].sizeMm).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('loads a model saved before the sweep existed with the sweep off', () => {
    // A pre-version-7 plan described bins with exact pockets; loading it with
    // the sweep on would silently enlarge every pocket it described.
    const result = withoutModelField('sweepEnabled');

    expect(loadedBin(result).models[0].sweepEnabled).toBe(false);
  });

  it('defaults an absent draft angle to 0 degrees', () => {
    const result = withoutModelField('draftAngleDeg');

    expect(loadedBin(result).models[0].draftAngleDeg).toBe(0);
  });

  it('keeps a committed sweep and draft angle through a round trip', () => {
    const entries = [
      cutoutEntry(
        cutoutBin({ models: [cutoutModel({ sweepEnabled: true, draftAngleDeg: 12.5 })] }),
      ),
    ];

    const result = parsePlanFile(serializePlanFile(entries, []));

    expect(loadedBin(result).models[0].sweepEnabled).toBe(true);
    expect(loadedBin(result).models[0].draftAngleDeg).toBe(12.5);
  });

  it('accepts a draft angle just under the 90 degree bound', () => {
    const nearLimit = badProduct({
      ...cutoutBin(),
      models: [cutoutModel({ draftAngleDeg: 89.9 })],
    });

    expect(validateEntry(entry({ id: 'c1', product: nearLimit }))).toBeNull();
  });

  it('drops an unknown extra model field rather than carrying it into storage', () => {
    const raw = JSON.parse(serializePlanFile([cutoutEntry()], [])) as {
      entries: Array<{ product: { bin: { models: Record<string, unknown>[] } } }>;
    };
    raw.entries[0].product.bin.models[0].stlBase64 = 'AAAA';

    const result = parsePlanFile(JSON.stringify(raw));

    expect(loadedBin(result).models[0]).toEqual(cutoutModel());
  });

  it('rejects a cutout bin carrying divider walls', () => {
    const bad = badProduct({ ...cutoutBin(), walls: [{ x1: 0, y1: 0, x2: 10, y2: 0 }] });

    expect(validateEntry(entry({ id: 'c1', product: bad }))).toBe(
      'entry c1: A cutout bin cannot have divider walls.',
    );
  });

  it('rejects a cutout bin carrying legacy divider counts', () => {
    const bad = badProduct({ ...cutoutBin(), dividerCountX: 2 });

    expect(validateEntry(entry({ id: 'c1', product: bad }))).toBe(
      'entry c1: A cutout bin cannot have divider walls.',
    );
  });

  it('rejects a models field that is not a list', () => {
    const bad = badProduct({ ...cutoutBin(), models: 'nope' });

    expect(validateEntry(entry({ id: 'c1', product: bad }))).toBe(
      'entry c1: The models must be a list.',
    );
  });

  it.each([
    ['a non-object model', 'nope', 'A cutout model is not an object.'],
    ['a model with an empty id', { ...cutoutModel(), id: '' }, 'A cutout model is missing its id.'],
    ['a non-string name', { ...cutoutModel(), name: 7 }, 'cutout model m1: The model name must be text.'],
    [
      'an empty modelSourceId',
      { ...cutoutModel(), modelSourceId: '' },
      'cutout model m1: The model source id must be text that is not empty.',
    ],
    [
      'a fractional triangle count',
      { ...cutoutModel(), triangleCount: 12.5 },
      'cutout model m1: The triangle count must be a whole number of at least 1.',
    ],
    [
      'a triangle count over the import ceiling',
      { ...cutoutModel(), triangleCount: 250001 },
      'cutout model m1: The triangle count must not exceed 250000.',
    ],
    [
      'a unit scale of zero',
      { ...cutoutModel(), unitScale: 0 },
      'cutout model m1: The unit scale must be a number greater than 0.',
    ],
    [
      'a size missing its z',
      { ...cutoutModel(), sizeMm: { x: 10, y: 10 } },
      'cutout model m1: The model size needs a finite x, y and z in mm.',
    ],
    [
      'a placement that is not an object',
      { ...cutoutModel(), placement: 'centre' },
      'cutout model m1: The placement must be an object.',
    ],
    [
      'a placement with a non-numeric position',
      { ...cutoutModel(), placement: { ...cutoutModel().placement, yMm: 'front' } },
      'cutout model m1: The placement value yMm must be a number.',
    ],
    [
      'a placement with a non-numeric rotation',
      { ...cutoutModel(), placement: { ...cutoutModel().placement, rotZDeg: null } },
      'cutout model m1: The placement value rotZDeg must be a number.',
    ],
    [
      'a negative clearance',
      { ...cutoutModel(), clearanceMm: -0.1 },
      'cutout model m1: The clearance must be a number of at least 0 mm.',
    ],
    [
      'a sweep flag that is not a boolean',
      { ...cutoutModel(), sweepEnabled: 'yes' },
      'cutout model m1: The sweep option must be true or false.',
    ],
    [
      'a draft angle of 90 degrees, whose cone would be infinite',
      { ...cutoutModel(), draftAngleDeg: 90 },
      'cutout model m1: The draft angle must be a number from 0 up to but not including 90 degrees.',
    ],
    [
      'a negative draft angle',
      { ...cutoutModel(), draftAngleDeg: -1 },
      'cutout model m1: The draft angle must be a number from 0 up to but not including 90 degrees.',
    ],
    [
      'a draft angle that is not a number',
      { ...cutoutModel(), draftAngleDeg: 'steep' },
      'cutout model m1: The draft angle must be a number from 0 up to but not including 90 degrees.',
    ],
  ])('rejects %s', (_name, model, message) => {
    const bad = badProduct({ ...cutoutBin(), models: [model] });

    expect(validateEntry(entry({ id: 'c1', product: bad }))).toBe(`entry c1: ${message}`);
  });

  it('rejects two models sharing one id', () => {
    const bad = badProduct({ ...cutoutBin(), models: [cutoutModel(), cutoutModel()] });

    expect(validateEntry(entry({ id: 'c1', product: bad }))).toBe(
      'entry c1: The cutout model id m1 appears twice.',
    );
  });

  it('rejects a clearance wider than the bin allows, naming the limit that bin has', () => {
    // A 1 by 1 bin has a 39.6 mm interior, and a clearance dilates the model in
    // every direction, so half of that is the most any model in it can carry.
    const bad = badProduct({
      ...cutoutBin(),
      gridX: 1,
      gridY: 1,
      models: [cutoutModel({ clearanceMm: 25 })],
    });

    expect(validateEntry(entry({ id: 'c1', product: bad }))).toBe(
      'entry c1: cutout model m1: The clearance is 25 mm, but a bin of 1 by 1 grid units allows at most 19.8 mm.',
    );
  });

  it('accepts a clearance exactly at the bin limit', () => {
    const atLimit = badProduct({
      ...cutoutBin(),
      gridX: 1,
      gridY: 1,
      models: [cutoutModel({ clearanceMm: 19.8 })],
    });

    expect(validateEntry(entry({ id: 'c1', product: atLimit }))).toBeNull();
  });

  it('accepts a cutout bin with no models at all', () => {
    expect(validateEntry(cutoutEntry(cutoutBin({ models: [] })))).toBeNull();
  });
});

describe('a plan written by the previous build', () => {
  it('loads a version-5 plan unchanged, with no warnings', () => {
    // The regression that matters most: binQueue.loadPlan degrades a parse
    // failure to an empty plan and only logs, so a break here would silently
    // empty every existing user's queue on their next visit.
    const stored = {
      id: 'a1',
      quantity: 2,
      createdAt: '2026-07-01T10:00:00.000Z',
      notes: 'reprint in PETG',
      product: {
        kind: 'binWithInsert',
        bin: {
          origin: 'manual',
          gridX: 2,
          gridY: 1,
          heightUnits: 3,
          magnetHoles: false,
          walls: [{ x1: 0, y1: -20, x2: 0, y2: 20 }],
        },
        insert: { text: 'M3 x 20', text2: 'drawer 2', icon: 'countersunk screw' },
      },
    };

    const result = parsePlanFile(JSON.stringify({ version: 5, entries: [stored], batches: [] }));

    expect(result).toEqual({
      ok: true,
      plan: { version: PLAN_FILE_VERSION, entries: [stored], batches: [], groups: [] },
      warnings: [],
    });
  });
});

describe('cavity edits (plan version 9)', () => {
  function cutoutEntry(edits: unknown): Record<string, unknown> {
    return {
      id: 'e1',
      quantity: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      product: {
        kind: 'bin',
        labelSlot: true,
        bin: {
          origin: 'cutout',
          gridX: 2,
          gridY: 2,
          heightUnits: 4,
          magnetHoles: false,
          models: [],
          ...(edits === undefined ? {} : { edits }),
        },
      },
    };
  }
  function planText(edits: unknown, version = 9): string {
    return JSON.stringify({ version, entries: [cutoutEntry(edits)], batches: [] });
  }

  it('round-trips edits through serialize and parse', () => {
    const edits = [
      { kind: 'add', points: [{ xMm: 1, yMm: 2, zMm: 3 }], radiusMm: 2 },
      { kind: 'remove', points: [{ xMm: 0, yMm: 0, zMm: 5 }, { xMm: 4, yMm: 0, zMm: 5 }], radiusMm: 1.5 },
      {
        kind: 'flatten',
        centerMm: { xMm: 5, yMm: 5, zMm: 10 },
        radiusMm: 6,
        normalMm: { xMm: 0, yMm: 0, zMm: 1 },
        heightMm: 8,
      },
    ];
    const result = parsePlanFile(planText(edits));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bin = (result.plan.entries[0].product as { bin: { edits: unknown } }).bin;
    expect(bin.edits).toEqual(edits);
    const reparsed = parsePlanFile(
      serializePlanFile(result.plan.entries, result.plan.batches),
    );
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect((reparsed.plan.entries[0].product as { bin: { edits: unknown } }).bin.edits).toEqual(edits);
  });

  it('loads a version 8 cutout bin with no edits field as an empty edit list', () => {
    const result = parsePlanFile(planText(undefined, 8));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.plan.entries[0].product as { bin: { edits: unknown } }).bin.edits).toEqual([]);
    expect(result.plan.version).toBe(10);
  });

  it('rejects an edit with a radius outside 0.2 to 50 mm', () => {
    const result = parsePlanFile(
      planText([{ kind: 'add', points: [{ xMm: 0, yMm: 0, zMm: 0 }], radiusMm: 0.1 }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('brush radius');
  });

  it('rejects a stroke edit with no points', () => {
    const result = parsePlanFile(planText([{ kind: 'remove', points: [], radiusMm: 2 }]));
    expect(result.ok).toBe(false);
  });

  it('rejects an edit with a non-finite coordinate', () => {
    const result = parsePlanFile(
      planText([
        {
          kind: 'flatten',
          centerMm: { xMm: 0, yMm: 0, zMm: null },
          radiusMm: 2,
          normalMm: { xMm: 0, yMm: 0, zMm: 1 },
          heightMm: 5,
        },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a flatten edit whose normal is not a unit vector', () => {
    const result = parsePlanFile(
      planText([
        {
          kind: 'flatten',
          centerMm: { xMm: 0, yMm: 0, zMm: 0 },
          radiusMm: 2,
          normalMm: { xMm: 0, yMm: 0, zMm: 2 },
          heightMm: 5,
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unit vector');
  });

  it('rejects a flatten edit with a zero normal', () => {
    const result = parsePlanFile(
      planText([
        {
          kind: 'flatten',
          centerMm: { xMm: 0, yMm: 0, zMm: 0 },
          radiusMm: 2,
          normalMm: { xMm: 0, yMm: 0, zMm: 0 },
          heightMm: 5,
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unit vector');
  });

  it('rejects a flatten edit with a cut height outside 0.2 to 100 mm', () => {
    const result = parsePlanFile(
      planText([
        {
          kind: 'flatten',
          centerMm: { xMm: 0, yMm: 0, zMm: 0 },
          radiusMm: 2,
          normalMm: { xMm: 0, yMm: 0, zMm: 1 },
          heightMm: 150,
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('cut height');
  });

  it('merges an imported entry with edits over an existing one', () => {
    const a = parsePlanFile(planText([]));
    const b = parsePlanFile(
      planText([{ kind: 'add', points: [{ xMm: 1, yMm: 1, zMm: 1 }], radiusMm: 3 }]),
    );
    if (!a.ok || !b.ok) throw new Error('setup failed');
    const merged = mergeEntries(a.plan.entries, b.plan.entries);
    expect(merged).toHaveLength(1);
    expect((merged[0].product as { bin: { edits: unknown[] } }).bin.edits).toHaveLength(1);
  });
});

describe('traced bin cavity edits and pocket draft angle (plan version 10)', () => {
  function tracedPlanText(
    opts: { edits?: unknown; draftAngleDeg?: unknown } = {},
    version = 10,
  ): string {
    const placement: Record<string, unknown> = {
      toolId: 't1',
      xMm: 0,
      yMm: 0,
      pocketDepthMm: 10,
    };
    if (opts.draftAngleDeg !== undefined) placement.draftAngleDeg = opts.draftAngleDeg;
    const bin: Record<string, unknown> = {
      origin: 'traced',
      gridX: 2,
      gridY: 2,
      heightUnits: 4,
      magnetHoles: false,
      pockets: {
        tools: [
          {
            id: 't1',
            name: 'Tool',
            outline: {
              outer: [
                { x: -10, y: -5 },
                { x: 10, y: -5 },
                { x: 10, y: 5 },
                { x: -10, y: 5 },
              ],
              holes: [],
            },
            rotationDeg: 0,
            offsetMm: 0,
            mirrored: false,
            fingerHoles: [],
          },
        ],
        placements: [placement],
      },
    };
    if (opts.edits !== undefined) bin.edits = opts.edits;
    return JSON.stringify({
      version,
      entries: [
        {
          id: 'e1',
          quantity: 1,
          createdAt: '2026-07-22T00:00:00.000Z',
          product: { kind: 'bin', labelSlot: true, bin },
        },
      ],
      batches: [],
    });
  }

  type LoadedTraced = {
    edits: unknown;
    pockets: { placements: { draftAngleDeg: unknown }[] };
  };
  function loadedTraced(result: PlanParseResult): LoadedTraced {
    if (!result.ok) throw new Error(`expected a valid plan, got: ${result.error}`);
    return (result.plan.entries[0].product as { bin: LoadedTraced }).bin;
  }

  it('round-trips a non-empty edits list and a pocket draft angle', () => {
    const edits = [
      { kind: 'add', points: [{ xMm: 1, yMm: 2, zMm: 3 }], radiusMm: 2 },
      {
        kind: 'flatten',
        centerMm: { xMm: 5, yMm: 5, zMm: 10 },
        radiusMm: 6,
        normalMm: { xMm: 0, yMm: 0, zMm: 1 },
        heightMm: 8,
      },
    ];
    const result = parsePlanFile(tracedPlanText({ edits, draftAngleDeg: 15 }));
    const bin = loadedTraced(result);
    expect(bin.edits).toEqual(edits);
    expect(bin.pockets.placements[0].draftAngleDeg).toBe(15);
    if (!result.ok) return;
    const reparsed = parsePlanFile(
      serializePlanFile(result.plan.entries, result.plan.batches),
    );
    const reBin = loadedTraced(reparsed);
    expect(reBin.edits).toEqual(edits);
    expect(reBin.pockets.placements[0].draftAngleDeg).toBe(15);
  });

  it('loads a traced bin lacking both fields as an empty edit list and a zero draft angle', () => {
    const bin = loadedTraced(parsePlanFile(tracedPlanText()));
    expect(bin.edits).toEqual([]);
    expect(bin.pockets.placements[0].draftAngleDeg).toBe(0);
  });

  it('rejects a traced bin cavity edit with a radius outside 0.2 to 50 mm', () => {
    const result = parsePlanFile(
      tracedPlanText({ edits: [{ kind: 'add', points: [{ xMm: 0, yMm: 0, zMm: 0 }], radiusMm: 0.1 }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('brush radius');
  });

  it('rejects a traced pocket with a draft angle of 90 degrees', () => {
    const result = parsePlanFile(tracedPlanText({ draftAngleDeg: 90 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('draft angle');
  });
});
