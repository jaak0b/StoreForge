import { describe, expect, it } from 'vitest';
import {
  composeLabelText,
  computeBinWidthUnits,
  groupBatchRows,
  parseShorthand,
} from '../../src/engine/plan/screwListImport';

describe('parseShorthand', () => {
  it('parses a compact thread-first batch', () => {
    const result = parseShorthand('m3x20 fhcs');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M3', lengthMm: 20, head: 'countersunk screw', quantity: 1 },
    ]);
  });

  it('parses a head-first batch with an mm suffix', () => {
    const result = parseShorthand('fhcs m5x12mm');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M5', lengthMm: 12, head: 'countersunk screw', quantity: 1 },
    ]);
  });

  it('splits comma-separated batches into one row each', () => {
    const result = parseShorthand('fhcs m5x12mm, bhcs m3x10mm');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M5', lengthMm: 12, head: 'countersunk screw', quantity: 1 },
      { thread: 'M3', lengthMm: 10, head: 'pan head screw', quantity: 1 },
    ]);
  });

  it('reads a quantity from a trailing x suffix', () => {
    const result = parseShorthand('m4x40 hex bolt x6');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M4', lengthMm: 40, head: 'hex bolt', quantity: 6 },
    ]);
  });

  it('reads a quantity from a star and from a qty word', () => {
    const star = parseShorthand('m3x20 *4');
    expect(star.batches[0].quantity).toBe(4);
    const word = parseShorthand('m3x20 qty4');
    expect(word.batches[0].quantity).toBe(4);
    const spaced = parseShorthand('m3x20 qty 4');
    expect(spaced.batches[0].quantity).toBe(4);
  });

  it('reads a fully combined token thread x length x quantity', () => {
    const result = parseShorthand('m3x20x6');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M3', lengthMm: 20, head: null, quantity: 6 },
    ]);
  });

  it('accepts spaced separators between thread and length', () => {
    const result = parseShorthand('m3 x 20 shcs');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M3', lengthMm: 20, head: 'cap head screw', quantity: 1 },
    ]);
  });

  it('parses a decimal thread size', () => {
    const result = parseShorthand('m2.5x8 pan');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M2.5', lengthMm: 8, head: 'pan head screw', quantity: 1 },
    ]);
  });

  it('maps every head alias to its canonical head', () => {
    const cases: Array<[string, string]> = [
      ['csk', 'countersunk screw'],
      ['countersunk', 'countersunk screw'],
      ['flat', 'countersunk screw'],
      ['bhcs', 'pan head screw'],
      ['button', 'pan head screw'],
      ['shcs', 'cap head screw'],
      ['cap', 'cap head screw'],
      ['socket', 'cap head screw'],
      ['hex', 'hex bolt'],
      ['hexbolt', 'hex bolt'],
      ['hex bolt', 'hex bolt'],
      ['wood', 'wood screw'],
      ['self-tap', 'self-tapping screw'],
      ['selftap', 'self-tapping screw'],
      ['tek', 'self-tapping screw'],
    ];
    for (const [alias, head] of cases) {
      const result = parseShorthand(`m3x20 ${alias}`);
      expect(result.batches[0].head, alias).toBe(head);
    }
  });

  it('leaves the head unspecified when none is given', () => {
    const result = parseShorthand('m6x30');
    expect(result.errors).toEqual([]);
    expect(result.batches[0].head).toBeNull();
  });

  it('accepts a lengthless nut batch without error', () => {
    const result = parseShorthand('m5 nut');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M5', lengthMm: null, head: 'hex nut', quantity: 1 },
    ]);
  });

  it('reads a marked number after a lengthless head as a quantity', () => {
    const result = parseShorthand('m5 nut x10');
    expect(result.errors).toEqual([]);
    expect(result.batches[0].quantity).toBe(10);
    expect(result.batches[0].lengthMm).toBeNull();
  });

  it('names an unknown head token in the error but still yields the batch', () => {
    const result = parseShorthand('m3x20 flanged');
    expect(result.errors).toEqual([
      "Can't read head type 'flanged'. Pick one from the row's dropdown instead.",
    ]);
    expect(result.batches).toEqual([
      { thread: 'M3', lengthMm: 20, head: null, quantity: 1 },
    ]);
  });

  it('names an out-of-range length in the error and leaves the length unset', () => {
    const result = parseShorthand('m3x150 fhcs');
    expect(result.errors).toEqual([
      "The length '150' is outside the supported 6 to 100 mm range.",
    ]);
    expect(result.batches[0].lengthMm).toBeNull();
  });

  it('rejects a fractional length by name', () => {
    const result = parseShorthand('m3x20.5');
    expect(result.errors).toEqual([
      "The length '20.5' must be a whole number of millimetres.",
    ]);
    expect(result.batches[0].lengthMm).toBeNull();
  });

  it('reports a batch that is missing its thread', () => {
    const result = parseShorthand('20 fhcs');
    expect(result.errors).toEqual([
      "Can't find a thread size (like M3) in '20 fhcs'.",
    ]);
    expect(result.batches).toEqual([
      { thread: null, lengthMm: 20, head: 'countersunk screw', quantity: 1 },
    ]);
  });

  it('reports a screw batch that is missing its length', () => {
    const result = parseShorthand('m3 fhcs');
    expect(result.errors).toEqual([
      "'m3 fhcs' has no length. Add one like 'x20' or fill it in on the row.",
    ]);
    expect(result.batches[0].lengthMm).toBeNull();
  });

  it('ignores empty comma segments', () => {
    const result = parseShorthand('m3x20, ,');
    expect(result.errors).toEqual([]);
    expect(result.batches).toHaveLength(1);
  });

  it('returns nothing for an empty line', () => {
    expect(parseShorthand('')).toEqual({ batches: [], errors: [] });
  });

  it('is case-insensitive and tolerates the multiplication sign', () => {
    const result = parseShorthand('M4×16 FHCS');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M4', lengthMm: 16, head: 'countersunk screw', quantity: 1 },
    ]);
  });
});

describe('composeLabelText', () => {
  it('composes thread, length and head abbreviation', () => {
    expect(composeLabelText('M3', 20, 'countersunk screw')).toBe('M3 x 20 FHCS');
  });

  it('omits the head part when unspecified', () => {
    expect(composeLabelText('M3', 20, null)).toBe('M3 x 20');
  });

  it('drops the length for a lengthless head', () => {
    expect(composeLabelText('M5', null, 'hex nut')).toBe('M5 NUT');
    expect(composeLabelText('M5', 10, 'hex nut')).toBe('M5 NUT');
    expect(composeLabelText('M4', null, 'washer')).toBe('M4 WASHER');
    expect(composeLabelText('M4', null, 'threaded insert')).toBe('M4 INSERT');
  });

  it('uses the distinct wood and self-tapping abbreviations', () => {
    expect(composeLabelText('M4', 30, 'wood screw')).toBe('M4 x 30 WOOD');
    expect(composeLabelText('M4', 30, 'self-tapping screw')).toBe('M4 x 30 ST');
  });
});

describe('computeBinWidthUnits', () => {
  // One-unit interior width is 39.1 mm (42 - 0.5 - 2 * 1.2) and the handling
  // clearance is 4 mm, so 35 mm is the longest screw a one-unit bin fits.
  it('fits a 35 mm screw in one unit', () => {
    expect(computeBinWidthUnits(35)).toBe(1);
  });

  it('forces two units at 36 mm', () => {
    expect(computeBinWidthUnits(36)).toBe(2);
  });

  // Two-unit interior width is 81.1 mm, so 77 mm still fits two units.
  it('fits a 77 mm screw in two units', () => {
    expect(computeBinWidthUnits(77)).toBe(2);
  });

  it('forces three units at 78 mm', () => {
    expect(computeBinWidthUnits(78)).toBe(3);
  });

  it('fits the shortest supported screw in one unit', () => {
    expect(computeBinWidthUnits(6)).toBe(1);
  });
});

describe('groupBatchRows', () => {
  it('merges rows with identical thread, length and head, summing quantities', () => {
    const groups = groupBatchRows([
      { thread: 'M3', lengthMm: 20, head: 'countersunk screw', quantity: 2, widthUnits: 1 },
      { thread: 'M4', lengthMm: 40, head: null, quantity: 1, widthUnits: 2 },
      { thread: 'M3', lengthMm: 20, head: 'countersunk screw', quantity: 5, widthUnits: 1 },
    ]);
    expect(groups).toEqual([
      {
        thread: 'M3',
        lengthMm: 20,
        head: 'countersunk screw',
        quantity: 7,
        widthUnits: 1,
        rowCount: 2,
      },
      { thread: 'M4', lengthMm: 40, head: null, quantity: 1, widthUnits: 2, rowCount: 1 },
    ]);
  });

  it('keeps rows that differ only in head separate', () => {
    const groups = groupBatchRows([
      { thread: 'M3', lengthMm: 20, head: 'countersunk screw', quantity: 1, widthUnits: 1 },
      { thread: 'M3', lengthMm: 20, head: 'cap head screw', quantity: 1, widthUnits: 1 },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps the widest width when merged rows disagree', () => {
    const groups = groupBatchRows([
      { thread: 'M3', lengthMm: 20, head: null, quantity: 1, widthUnits: 1 },
      { thread: 'M3', lengthMm: 20, head: null, quantity: 1, widthUnits: 2 },
    ]);
    expect(groups).toEqual([
      { thread: 'M3', lengthMm: 20, head: null, quantity: 2, widthUnits: 2, rowCount: 2 },
    ]);
  });
});
