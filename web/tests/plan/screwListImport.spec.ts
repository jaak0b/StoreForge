import { describe, expect, it } from 'vitest';
import {
  composeLabelText,
  computeBinWidthUnits,
  groupBatchRows,
  headHeightMm,
  overallLengthMm,
  parseShorthand,
  threadDiameterMm,
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
    const result = parseShorthand('m3x1500 fhcs');
    expect(result.errors).toEqual([
      "The length '1500' is outside the supported 1 to 1000 mm range.",
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
    const result = parseShorthand('#8 x 44-1/2"');
    expect(result.errors).toEqual([
      `The length '44-1/2"' (1130 mm) is outside the supported 1 to 1000 mm range.`,
    ]);
    expect(result.batches[0].lengthMm).toBeNull();
    expect(result.batches[0].enteredUnit).toBe('imperial');
  });

  it('maps the brad, dowel and pocket screw aliases with lengths and labels', () => {
    const cases: Array<[string, string]> = [
      ['brad', 'brad'],
      ['dowel', 'dowel'],
      ['pocket', 'pocket screw'],
      ['pocket screw', 'pocket screw'],
    ];
    for (const [alias, head] of cases) {
      const result = parseShorthand(`m4x30 ${alias}`);
      expect(result.batches[0].head, alias).toBe(head);
      expect(result.batches[0].lengthMm, alias).toBe(30);
      expect(composeLabelText('M4', 30, result.batches[0].head)).toBe('M4 x 30');
    }
  });
});

describe('composeLabelText', () => {
  it('composes thread and length, dropping the head abbreviation', () => {
    expect(composeLabelText('M3', 20, 'countersunk screw')).toBe('M3 x 20');
  });

  it('omits the head part when unspecified', () => {
    expect(composeLabelText('M3', 20, null)).toBe('M3 x 20');
  });

  it('keeps the head abbreviation for a lengthless head, since it is the only label text', () => {
    expect(composeLabelText('M5', null, 'hex nut')).toBe('M5 NUT');
    expect(composeLabelText('M5', 10, 'hex nut')).toBe('M5 NUT');
    expect(composeLabelText('M4', null, 'washer')).toBe('M4 WASHER');
    expect(composeLabelText('M4', null, 'threaded insert')).toBe('M4 INSERT');
  });

  it('drops the wood and self-tapping abbreviations once a length is present', () => {
    expect(composeLabelText('M4', 30, 'wood screw')).toBe('M4 x 30');
    expect(composeLabelText('M4', 30, 'self-tapping screw')).toBe('M4 x 30');
  });

  it('prints an imperial batch with its length as entered, no head abbreviation', () => {
    expect(composeLabelText('#8', 38, 'wood screw', '1-1/2"')).toBe('#8 x 1-1/2"');
    expect(composeLabelText('1/4-20', 25, 'hex bolt', '1"')).toBe('1/4-20 x 1"');
  });
});

describe('computeBinWidthUnits', () => {
  // Sizing uses the clear top opening under the stacking lip, not the wider
  // interior below: the lip tip overhangs 2.6 mm per side (kennetek
  // STACKING_LIP_SIZE.x), so a one-unit opening is 36.3 mm (41.5 - 2 * 2.6).
  // With the 4 mm handling clearance, 32 mm is the longest one-unit screw
  // (35 mm fitted before the lip seat narrowed the drop-in opening).
  it('fits a 32 mm screw in one unit', () => {
    expect(computeBinWidthUnits(32)).toBe(1);
  });

  it('forces two units at 33 mm', () => {
    expect(computeBinWidthUnits(33)).toBe(2);
  });

  // The two-unit opening is 78.3 mm (83.5 - 2 * 2.6), so 74 mm still fits
  // two units (77 mm fitted before the lip seat narrowed the opening).
  it('fits a 74 mm screw in two units', () => {
    expect(computeBinWidthUnits(74)).toBe(2);
  });

  it('forces three units at 75 mm', () => {
    expect(computeBinWidthUnits(75)).toBe(3);
  });

  it('fits the shortest supported screw in one unit', () => {
    expect(computeBinWidthUnits(6)).toBe(1);
  });
});

describe('threadDiameterMm', () => {
  it('reads a metric diameter directly', () => {
    expect(threadDiameterMm('M5')).toBe(5);
    expect(threadDiameterMm('M2.5')).toBe(2.5);
  });

  it('derives a number size from the ANSI unified formula', () => {
    // #8: (0.060 + 0.013 * 8) in = 0.164 in.
    expect(threadDiameterMm('#8')).toBeCloseTo(0.164 * 25.4, 6);
  });

  it('reads a fractional size in inches', () => {
    expect(threadDiameterMm('1/4-20')).toBeCloseTo(6.35, 6);
  });

  it('returns null for an absent or unreadable thread', () => {
    expect(threadDiameterMm(null)).toBeNull();
    expect(threadDiameterMm('nonsense')).toBeNull();
  });
});

describe('headHeightMm', () => {
  it('adds the socket cap head height as the diameter (ISO 4762)', () => {
    expect(headHeightMm('cap head screw', 5)).toBe(5);
  });

  it('adds 0.55 d for a button head (ISO 7380-1)', () => {
    expect(headHeightMm('pan head screw', 5)).toBeCloseTo(2.75, 6);
  });

  it('adds nothing for a countersunk screw (measured overall)', () => {
    expect(headHeightMm('countersunk screw', 5)).toBe(0);
  });

  it('uses the ISO 4014/4017 table for a hex bolt', () => {
    expect(headHeightMm('hex bolt', 5)).toBe(3.5);
    expect(headHeightMm('hex bolt', 8)).toBe(5.3);
  });

  it('adds nothing when the head or diameter is unknown', () => {
    expect(headHeightMm(null, 5)).toBe(0);
    expect(headHeightMm('cap head screw', null)).toBe(0);
  });
});

describe('overallLengthMm', () => {
  it('adds the head height for a socket cap screw', () => {
    // m5x50 shcs: 50 + 5 = 55.
    expect(overallLengthMm({ thread: 'M5', lengthMm: 50, head: 'cap head screw' })).toBe(55);
  });

  it('adds the button head height', () => {
    // m5x50 bhcs: 50 + 0.55 * 5 = 52.75.
    expect(overallLengthMm({ thread: 'M5', lengthMm: 50, head: 'pan head screw' })).toBeCloseTo(
      52.75,
      6,
    );
  });

  it('leaves a countersunk length as the overall length', () => {
    // m5x50 fhcs: nominal length is already overall.
    expect(overallLengthMm({ thread: 'M5', lengthMm: 50, head: 'countersunk screw' })).toBe(50);
  });

  it('is null without a length', () => {
    expect(overallLengthMm({ thread: 'M5', lengthMm: null, head: 'cap head screw' })).toBeNull();
  });

  it('pushes an M5x28 cap screw into two units the nominal length would not need', () => {
    // Nominal 28 mm fits one unit (32 mm boundary); the 5 mm head takes the
    // overall length to 33 mm, which forces two units.
    expect(computeBinWidthUnits(28)).toBe(1);
    expect(
      computeBinWidthUnits(overallLengthMm({ thread: 'M5', lengthMm: 28, head: 'cap head screw' })!),
    ).toBe(2);
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
