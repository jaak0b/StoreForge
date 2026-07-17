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
  PrintBatch,
  ScrewBin,
  ScrewSpec,
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
    quantity: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
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

function screwEntry(overrides: Partial<ScrewBin> = {}): ScrewBin {
  return { ...entry({ id: 's1' }), kind: 'screw', screw: screwSpec(), ...overrides };
}

function tracedEntry(overrides: Partial<TracedBin> = {}): TracedBin {
  const { dividerCountX, dividerCountY, kind, ...base } = entry({ id: 't1' });
  void dividerCountX;
  void dividerCountY;
  void kind;
  return { ...base, kind: 'traced', pockets: pockets(), ...overrides };
}

function batchItem(overrides: Partial<BatchItem> = {}): BatchItem {
  const { id, kind, quantity, createdAt, notes, ...params } = entry();
  void quantity;
  void createdAt;
  void notes;
  void id;
  void kind;
  return { id: 'i1', params, count: 2, sourceEntryId: 'a1', ...overrides };
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
        fingerHoles: [{ x: 0, y: 0, diameterMm: 25 }],
      },
    ],
    placements: [{ toolId: 't1', xMm: 3, yMm: -4, pocketDepthMm: 12 }],
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
    expect(result).toEqual({ ok: true, plan: { version: 2, entries, batches } });
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

  it('rejects an unknown envelope version', () => {
    const result = parsePlanFile('{"version":3,"entries":[],"batches":[]}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version 3');
  });

  it('rejects a missing entries list', () => {
    const result = parsePlanFile('{"version":2}');
    expect(result).toEqual({ ok: false, error: 'The plan is missing its entries list.' });
  });

  it('rejects a version-2 file without a batches list', () => {
    const result = parsePlanFile('{"version":2,"entries":[]}');
    expect(result).toEqual({ ok: false, error: 'The plan is missing its batches list.' });
  });

  it('rejects a plan containing one malformed entry instead of dropping it', () => {
    const good = entry();
    const bad = { ...entry({ id: 'b2' }), gridX: 'two' };
    const text = JSON.stringify({ version: 2, entries: [good, bad], batches: [] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: entry b2: gridX must be an integer of at least 1.',
    });
  });

  it('rejects duplicate entry ids', () => {
    const text = JSON.stringify({ version: 2, entries: [entry(), entry()], batches: [] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: entry id a1 appears twice.',
    });
  });

  it('rejects duplicate batch ids', () => {
    const text = JSON.stringify({ version: 2, entries: [], batches: [batch(), batch()] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: batch id batch1 appears twice.',
    });
  });

  it('rejects a malformed batch item instead of dropping it', () => {
    const bad = batch({ items: [batchItem({ count: 0 })] });
    const text = JSON.stringify({ version: 2, entries: [], batches: [bad] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: batch batch1: item i1: count must be an integer of at least 1.',
    });
  });

  it('drops unknown extra fields on an entry when parsing', () => {
    const withExtra = { ...entry(), somethingElse: 42 };
    const result = parsePlanFile(
      JSON.stringify({ version: 2, entries: [withExtra], batches: [] }),
    );
    expect(result).toEqual({
      ok: true,
      plan: { version: 2, entries: [entry()], batches: [] },
    });
  });
});

describe('version-1 migration', () => {
  it('imports queued version-1 entries and starts with no batches', () => {
    const legacy = { ...entry(), status: 'queued' };
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [legacy] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 2, entries: [entry()], batches: [] },
    });
  });

  it('drops version-1 entries that were already printed', () => {
    const queued = { ...entry(), status: 'queued' };
    const printed = {
      ...entry({ id: 'b2' }),
      status: 'printed',
      printedAt: '2026-07-02T09:30:00.000Z',
    };
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [queued, printed] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 2, entries: [entry()], batches: [] },
    });
  });

  it('defaults dividers and the second label line on old version-1 files', () => {
    const legacy: Record<string, unknown> = { ...entry(), status: 'queued' };
    delete legacy.dividerCountX;
    delete legacy.dividerCountY;
    delete legacy.labelText2;
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [legacy] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 2, entries: [entry()], batches: [] },
    });
  });
});

describe('validateEntry', () => {
  it('accepts a complete valid entry', () => {
    expect(validateEntry(entry())).toBeNull();
  });

  it('tolerates version-1 lifecycle fields', () => {
    expect(validateEntry({ ...entry(), status: 'printed', printedAt: 'whenever' })).toBeNull();
  });

  it.each([
    ['gridX', 0, 'gridX must be an integer of at least 1'],
    ['gridY', 1.5, 'gridY must be an integer of at least 1'],
    ['heightUnits', 1, 'heightUnits must be an integer of at least 2'],
    ['stackingLip', 'yes', 'stackingLip must be true or false'],
    ['magnetHoles', 1, 'magnetHoles must be true or false'],
    ['dividerCountX', -1, 'dividerCountX must be an integer of at least 0'],
    ['dividerCountY', 0.5, 'dividerCountY must be an integer of at least 0'],
    ['labelText', null, 'labelText must be a string'],
    ['labelText2', 7, 'labelText2 must be a string'],
    ['labelIcon', 7, 'labelIcon must be a string or null'],
    ['quantity', 0, 'quantity must be an integer of at least 1'],
    ['createdAt', 'yesterday', 'createdAt must be an ISO 8601 timestamp'],
    ['notes', 5, 'notes must be a string'],
  ])('rejects a bad %s field', (field, value, message) => {
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

  it('rejects a bad item params field', () => {
    const item = batchItem();
    const badItem = { ...item, params: { ...item.params, gridX: 'two' } };
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
    const existing = [entry(), entry({ id: 'b2', labelText: 'old' })];
    const imported = [entry({ id: 'b2', labelText: 'new' }), entry({ id: 'c3' })];
    const merged = mergeEntries(existing, imported);
    expect(merged.map((e) => e.id)).toEqual(['a1', 'b2', 'c3']);
    expect(merged[1].labelText).toBe('new');
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
    const imperial = screwEntry({
      screw: screwSpec({ thread: '#8', lengthMm: 38, enteredLengthText: '1-1/2"' }),
    });
    const lengthless = screwEntry({
      id: 's2',
      screw: screwSpec({ thread: 'M5', lengthMm: null, head: 'hex nut' }),
    });
    const result = parsePlanFile(serializePlanFile([imperial, lengthless], []));
    expect(result).toEqual({
      ok: true,
      plan: { version: 2, entries: [imperial, lengthless], batches: [] },
    });
  });

  it('round-trips a traced entry with pockets and no divider fields', () => {
    const traced = tracedEntry();
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({ ok: true, plan: { version: 2, entries: [traced], batches: [] } });
  });

  it('round-trips a batch item with pockets and screw snapshots', () => {
    const withSnapshots = batch({
      items: [batchItem({ pockets: pockets() }), batchItem({ id: 'i2', screw: screwSpec() })],
    });
    const result = parsePlanFile(serializePlanFile([], [withSnapshots]));
    expect(result).toEqual({ ok: true, plan: { version: 2, entries: [], batches: [withSnapshots] } });
  });

  it('migrates a legacy entry without kind and with pockets to a traced bin', () => {
    const legacy: Record<string, unknown> = { ...tracedEntry(), dividerCountX: 0, dividerCountY: 0 };
    delete legacy.kind;
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result).toEqual({ ok: true, plan: { version: 2, entries: [tracedEntry()], batches: [] } });
  });

  it('migrates a legacy entry without kind and without pockets to a manual bin', () => {
    const legacy: Record<string, unknown> = { ...entry() };
    delete legacy.kind;
    const result = parsePlanFile(JSON.stringify({ version: 2, entries: [legacy], batches: [] }));
    expect(result).toEqual({ ok: true, plan: { version: 2, entries: [entry()], batches: [] } });
  });

  it('rejects an unknown kind', () => {
    expect(validateEntry({ ...entry(), kind: 'mystery' })).toBe(
      'entry a1: kind must be manual, screw or traced',
    );
  });

  it('rejects a traced entry without pockets', () => {
    const bad: Record<string, unknown> = { ...tracedEntry() };
    delete bad.pockets;
    expect(validateEntry(bad)).toBe('entry t1: a traced entry must have pockets');
  });

  it('rejects a traced entry with divider fields', () => {
    expect(validateEntry({ ...tracedEntry(), dividerCountX: 1 })).toBe(
      'entry t1: a traced entry cannot have divider walls',
    );
  });

  it('rejects a manual entry with pockets', () => {
    expect(validateEntry({ ...entry(), pockets: pockets() })).toBe(
      'entry a1: only a traced entry can have pockets',
    );
  });

  it('rejects a screw entry without its screw description', () => {
    const bad: Record<string, unknown> = { ...screwEntry() };
    delete bad.screw;
    expect(validateEntry(bad)).toBe('entry s1: screw must be an object');
  });

  it('rejects a screw entry with an unknown head type', () => {
    expect(validateEntry(screwEntry({ screw: { ...screwSpec(), head: 'mushroom' as never } }))).toBe(
      'entry s1: screw head must be a known head type or null',
    );
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
    const traced = tracedEntry({ traceSourceId: 'photo-1', paper: tracePaper() });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({ ok: true, plan: { version: 2, entries: [traced], batches: [] } });
  });

  it('accepts a traced entry without trace source fields (imported plan)', () => {
    expect(validateEntry(tracedEntry())).toBeNull();
  });

  it('defaults missing tool clicks to an empty list on old plans', () => {
    const legacy = tracedEntry();
    const raw = JSON.parse(serializePlanFile([legacy], [])) as {
      entries: Array<{ pockets: { tools: Array<Record<string, unknown>> } }>;
    };
    delete raw.entries[0].pockets.tools[0].clicks;
    const result = parsePlanFile(JSON.stringify({ ...raw, version: 2, batches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries[0] as TracedBin;
      expect(entry.pockets.tools[0].clicks).toEqual([]);
    }
  });

  it('rejects a malformed click', () => {
    const bad = pockets();
    bad.tools[0].clicks = [{ x: 1, y: 2, label: 3 as never }];
    expect(validateEntry(tracedEntry({ pockets: bad }))).toBe(
      'entry t1: pocket tool t1: a click needs x, y and a label of 0 or 1',
    );
  });

  it('rejects an empty traceSourceId', () => {
    expect(validateEntry({ ...tracedEntry(), traceSourceId: '' })).toBe(
      'entry t1: traceSourceId must be a non-empty string',
    );
  });

  it('rejects an unknown paper kind', () => {
    const paper = { ...tracePaper(), kind: 'a3' };
    expect(validateEntry({ ...tracedEntry(), paper })).toBe(
      'entry t1: paper kind must be a4 or letter',
    );
  });

  it('rejects a paper corner without coordinates', () => {
    const paper = tracePaper() as unknown as { corners: Record<string, unknown>; kind: string };
    paper.corners.br = { x: 5 };
    expect(validateEntry({ ...tracedEntry(), paper })).toBe(
      'entry t1: paper corner br needs x and y coordinates',
    );
  });

  it('round-trips a batch item carrying the trace source snapshot', () => {
    const withSource = batch({
      items: [batchItem({ pockets: pockets(), traceSourceId: 'photo-1', paper: tracePaper() })],
    });
    const result = parsePlanFile(serializePlanFile([], [withSource]));
    expect(result).toEqual({ ok: true, plan: { version: 2, entries: [], batches: [withSource] } });
  });

  it('rejects a batch item with a malformed paper field', () => {
    const bad = batch({ items: [batchItem({ paper: 'a4' as never })] });
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
    expect(validateEntry(tracedEntry({ pockets: bad }))).toBe(
      'entry t1: a pocket placement refers to a tool that is not in the pockets',
    );
  });

  it('rejects an outline with fewer than 3 outer points', () => {
    const bad = pockets();
    bad.tools[0].outline.outer = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    expect(validateEntry(tracedEntry({ pockets: bad }))).toBe(
      'entry t1: pocket tool t1: outline needs at least 3 outer points',
    );
  });

  it('rejects a pocket depth of zero', () => {
    const bad = pockets();
    bad.placements[0].pocketDepthMm = 0;
    expect(validateEntry(tracedEntry({ pockets: bad }))).toBe(
      'entry t1: a pocket placement needs xMm, yMm and a pocketDepthMm above 0',
    );
  });

  it('round-trips a traced entry whose finger hole is an elongated slot', () => {
    const withSlot = pockets();
    withSlot.tools[0].fingerHoles = [{ x: 0, y: 0, x2: 12, y2: -3, diameterMm: 20 }];
    const traced = tracedEntry({ pockets: withSlot });
    const result = parsePlanFile(serializePlanFile([traced], []));
    expect(result).toEqual({ ok: true, plan: { version: 2, entries: [traced], batches: [] } });
  });

  it('accepts a circular finger hole without slot endpoints (old plans)', () => {
    expect(validateEntry(tracedEntry())).toBeNull();
  });

  it('rejects a finger hole with only one slot coordinate', () => {
    const bad = pockets();
    bad.tools[0].fingerHoles = [{ x: 0, y: 0, x2: 12, diameterMm: 20 }];
    expect(validateEntry(tracedEntry({ pockets: bad }))).toBe(
      'entry t1: pocket tool t1: an elongated finger hole needs both x2 and y2 as numbers',
    );
  });
});
