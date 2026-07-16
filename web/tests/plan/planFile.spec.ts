import { describe, expect, it } from 'vitest';
import {
  mergeBatches,
  mergeEntries,
  parsePlanFile,
  serializePlanFile,
  validateBatch,
  validateEntry,
} from '../../src/engine/plan/planFile';
import type { BatchItem, BinEntry, PrintBatch } from '../../src/engine/plan/types';

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
    labelText: 'M3 bolts',
    labelText2: '',
    labelIcon: 'bolt',
    quantity: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

function batchItem(overrides: Partial<BatchItem> = {}): BatchItem {
  const { id, quantity, createdAt, notes, ...params } = entry();
  void quantity;
  void createdAt;
  void notes;
  void id;
  return { id: 'i1', params, count: 2, sourceEntryId: 'a1', ...overrides };
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
