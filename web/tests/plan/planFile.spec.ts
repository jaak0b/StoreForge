import { describe, expect, it } from 'vitest';
import {
  markEntriesPrinted,
  mergeEntries,
  parsePlanFile,
  requeueEntries,
  serializePlanFile,
  validateEntry,
} from '../../src/engine/plan/planFile';
import type { BinEntry } from '../../src/engine/plan/types';

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
    quantity: 1,
    status: 'queued',
    createdAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('serializePlanFile / parsePlanFile', () => {
  it('round-trips a plan through JSON unchanged', () => {
    const entries = [
      entry(),
      entry({
        id: 'b2',
        status: 'printed',
        printedAt: '2026-07-02T09:30:00.000Z',
        notes: 'reprint in PETG',
      }),
    ];
    const result = parsePlanFile(serializePlanFile(entries));
    expect(result).toEqual({ ok: true, plan: { version: 1, entries } });
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
    const result = parsePlanFile('{"version":2,"entries":[]}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version 2');
  });

  it('rejects a missing entries list', () => {
    const result = parsePlanFile('{"version":1}');
    expect(result).toEqual({ ok: false, error: 'The plan is missing its entries list.' });
  });

  it('rejects a plan containing one malformed entry instead of dropping it', () => {
    const good = entry();
    const bad = { ...entry({ id: 'b2' }), gridX: 'two' };
    const text = JSON.stringify({ version: 1, entries: [good, bad] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: entry b2: gridX must be an integer of at least 1.',
    });
  });

  it('rejects duplicate entry ids', () => {
    const text = JSON.stringify({ version: 1, entries: [entry(), entry()] });
    const result = parsePlanFile(text);
    expect(result).toEqual({
      ok: false,
      error: 'The plan is invalid: entry id a1 appears twice.',
    });
  });

  it('defaults dividers and perforation on version-1 files that predate them', () => {
    const legacy: Record<string, unknown> = { ...entry() };
    delete legacy.dividerCountX;
    delete legacy.dividerCountY;
    delete legacy.perforatedBase;
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [legacy] }));
    expect(result).toEqual({
      ok: true,
      plan: {
        version: 1,
        entries: [entry({ dividerCountX: 0, dividerCountY: 0, perforatedBase: false })],
      },
    });
  });

  it('defaults the second label line on version-1 files that predate it', () => {
    const legacy: Record<string, unknown> = { ...entry() };
    delete legacy.labelText2;
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [legacy] }));
    expect(result).toEqual({
      ok: true,
      plan: { version: 1, entries: [entry({ labelText2: '' })] },
    });
  });

  it('drops unknown extra fields on an entry when parsing', () => {
    const withExtra = { ...entry(), somethingElse: 42 };
    const result = parsePlanFile(JSON.stringify({ version: 1, entries: [withExtra] }));
    expect(result).toEqual({ ok: true, plan: { version: 1, entries: [entry()] } });
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
    ['stackingLip', 'yes', 'stackingLip must be true or false'],
    ['magnetHoles', 1, 'magnetHoles must be true or false'],
    ['dividerCountX', -1, 'dividerCountX must be an integer of at least 0'],
    ['dividerCountY', 0.5, 'dividerCountY must be an integer of at least 0'],
    ['perforatedBase', 'yes', 'perforatedBase must be true or false'],
    ['labelText', null, 'labelText must be a string'],
    ['labelText2', 7, 'labelText2 must be a string'],
    ['labelIcon', 7, 'labelIcon must be a string or null'],
    ['quantity', 0, 'quantity must be an integer of at least 1'],
    ['status', 'done', 'status must be "queued" or "printed"'],
    ['createdAt', 'yesterday', 'createdAt must be an ISO 8601 timestamp'],
    ['printedAt', 'later', 'printedAt must be an ISO 8601 timestamp'],
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

describe('status transitions', () => {
  it('markEntriesPrinted sets status and printedAt only on the named ids', () => {
    const entries = [entry(), entry({ id: 'b2' })];
    const result = markEntriesPrinted(entries, ['b2'], '2026-07-03T12:00:00.000Z');
    expect(result[0]).toEqual(entry());
    expect(result[1]).toEqual(
      entry({ id: 'b2', status: 'printed', printedAt: '2026-07-03T12:00:00.000Z' }),
    );
  });

  it('requeueEntries returns status to queued and clears printedAt', () => {
    const printed = entry({
      id: 'b2',
      status: 'printed',
      printedAt: '2026-07-03T12:00:00.000Z',
    });
    const result = requeueEntries([printed], ['b2']);
    expect(result[0]).toEqual(entry({ id: 'b2' }));
    expect('printedAt' in result[0]).toBe(false);
  });

  it('a mark-then-requeue round trip restores the original entry', () => {
    const original = entry();
    const back = requeueEntries(
      markEntriesPrinted([original], ['a1'], '2026-07-03T12:00:00.000Z'),
      ['a1'],
    );
    expect(back[0]).toEqual(original);
  });
});
