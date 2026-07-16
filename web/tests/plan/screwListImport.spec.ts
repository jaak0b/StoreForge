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
      { thread: 'M3', lengthMm: 20, head: 'countersunk screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
    ]);
  });

  it('parses a head-first batch with an mm suffix', () => {
    const result = parseShorthand('fhcs m5x12mm');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M5', lengthMm: 12, head: 'countersunk screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
    ]);
  });

  it('splits comma-separated batches into one row each', () => {
    const result = parseShorthand('fhcs m5x12mm, bhcs m3x10mm');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M5', lengthMm: 12, head: 'countersunk screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
      { thread: 'M3', lengthMm: 10, head: 'pan head screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
    ]);
  });

  it('reads a quantity from a trailing x suffix', () => {
    const result = parseShorthand('m4x40 hex bolt x6');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M4', lengthMm: 40, head: 'hex bolt', quantity: 6, enteredUnit: 'metric', enteredLengthText: null },
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
      { thread: 'M3', lengthMm: 20, head: null, quantity: 6, enteredUnit: 'metric', enteredLengthText: null },
    ]);
  });

  it('accepts spaced separators between thread and length', () => {
    const result = parseShorthand('m3 x 20 shcs');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M3', lengthMm: 20, head: 'cap head screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
    ]);
  });

  it('parses a decimal thread size', () => {
    const result = parseShorthand('m2.5x8 pan');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      { thread: 'M2.5', lengthMm: 8, head: 'pan head screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
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
      { thread: 'M5', lengthMm: null, head: 'hex nut', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
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
      { thread: 'M3', lengthMm: 20, head: null, quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
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
      "Can't find a thread size (like M3 or #8) in '20 fhcs'.",
    ]);
    expect(result.batches).toEqual([
      { thread: null, lengthMm: 20, head: 'countersunk screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
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
      { thread: 'M4', lengthMm: 16, head: 'countersunk screw', quantity: 1, enteredUnit: 'metric', enteredLengthText: null },
    ]);
  });
});

describe('parseShorthand imperial', () => {
  it('parses a combined number-series token with a fractional inch length', () => {
    const result = parseShorthand('#8x1-1/2 wood');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      {
        thread: '#8',
        lengthMm: 38,
        head: 'wood screw',
        quantity: 1,
        enteredUnit: 'imperial',
        enteredLengthText: '1-1/2"',
      },
    ]);
  });

  it('parses a fractional thread with an inch length using the in suffix', () => {
    const result = parseShorthand('1/4-20x1in hex');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      {
        thread: '1/4-20',
        lengthMm: 25,
        head: 'hex bolt',
        quantity: 1,
        enteredUnit: 'imperial',
        enteredLengthText: '1"',
      },
    ]);
  });

  it('drops the TPI from a number-series thread but keeps it on a fractional one', () => {
    expect(parseShorthand('#8-32 x 1"').batches[0].thread).toBe('#8');
    expect(parseShorthand('5/16-18 x 1"').batches[0].thread).toBe('5/16-18');
  });

  it('parses spaced imperial lengths with a quote suffix and a bare fraction', () => {
    const quoted = parseShorthand('#8 x 1-1/2" x4');
    expect(quoted.errors).toEqual([]);
    expect(quoted.batches[0].lengthMm).toBe(38);
    expect(quoted.batches[0].quantity).toBe(4);
    const fraction = parseShorthand('#6 x 1/2');
    expect(fraction.errors).toEqual([]);
    expect(fraction.batches[0].lengthMm).toBe(13);
    expect(fraction.batches[0].enteredLengthText).toBe('1/2"');
  });

  it('rounds the converted length to the nearest whole millimetre', () => {
    // 3/4" = 19.05 mm -> 19; 1-1/4" = 31.75 mm -> 32.
    expect(parseShorthand('#8 x 3/4"').batches[0].lengthMm).toBe(19);
    expect(parseShorthand('#8 x 1-1/4"').batches[0].lengthMm).toBe(32);
  });

  it('keeps metric and imperial batches independent on one line', () => {
    const result = parseShorthand('m3x20 fhcs, #8x1-1/2 wood x6');
    expect(result.errors).toEqual([]);
    expect(result.batches).toEqual([
      {
        thread: 'M3',
        lengthMm: 20,
        head: 'countersunk screw',
        quantity: 1,
        enteredUnit: 'metric',
        enteredLengthText: null,
      },
      {
        thread: '#8',
        lengthMm: 38,
        head: 'wood screw',
        quantity: 6,
        enteredUnit: 'imperial',
        enteredLengthText: '1-1/2"',
      },
    ]);
  });

  it('rejects an imperial length whose conversion falls outside the range', () => {
    const result = parseShorthand('#8 x 4-1/2"');
    expect(result.errors).toEqual([
      `The length '4-1/2"' (114 mm) is outside the supported 6 to 100 mm range.`,
    ]);
    expect(result.batches[0].lengthMm).toBeNull();
    expect(result.batches[0].enteredUnit).toBe('imperial');
  });

  it('maps the brad, dowel and pocket screw aliases with lengths and labels', () => {
    const cases: Array<[string, string, string]> = [
      ['brad', 'brad', 'BRAD'],
      ['dowel', 'dowel', 'DOWEL'],
      ['pocket', 'pocket screw', 'POCKET'],
      ['pocket screw', 'pocket screw', 'POCKET'],
    ];
    for (const [alias, head, abbrev] of cases) {
      const result = parseShorthand(`m4x30 ${alias}`);
      expect(result.batches[0].head, alias).toBe(head);
      expect(result.batches[0].lengthMm, alias).toBe(30);
      expect(composeLabelText('M4', 30, result.batches[0].head)).toBe(`M4 x 30 ${abbrev}`);
    }
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

  it('prints an imperial batch with its length as entered', () => {
    expect(composeLabelText('#8', 38, 'wood screw', '1-1/2"')).toBe('#8 x 1-1/2" WOOD');
    expect(composeLabelText('1/4-20', 25, 'hex bolt', '1"')).toBe('1/4-20 x 1" HEX');
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
        enteredLengthText: null,
      },
      { thread: 'M4', lengthMm: 40, head: null, quantity: 1, widthUnits: 2, rowCount: 1, enteredLengthText: null },
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
      { thread: 'M3', lengthMm: 20, head: null, quantity: 2, widthUnits: 2, rowCount: 2, enteredLengthText: null },
    ]);
  });
});
