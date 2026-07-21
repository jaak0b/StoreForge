import { describe, expect, it } from 'vitest';
import {
  mergeEntries,
  parsePlanFile,
  serializePlanFile,
  validateEntry,
} from '../../src/engine/plan/planFile';
import { partsOf } from '../../src/engine/plan/geometry';
import { baseplateSpanMm } from '../../src/engine/baseplate/generator';
import { fileStem, partFootprint } from '../../src/binDownloads';
import type {
  BaseplateProduct,
  ConnectionClipProduct,
  Product,
  QueueEntry,
} from '../../src/engine/plan/types';
import { PLAN_FILE_VERSION } from '../../src/engine/plan/types';

/** A baseplate with every option on and non-default. */
function fullBaseplate(): BaseplateProduct {
  return {
    kind: 'baseplate',
    unitsX: 4,
    unitsY: 2,
    magnets: { diameterMm: 8.2, heightMm: 1 },
    screwHoles: true,
    connectable: true,
  };
}

/** A baseplate with every option off. */
function plainBaseplate(): BaseplateProduct {
  return {
    kind: 'baseplate',
    unitsX: 4,
    unitsY: 2,
    magnets: null,
    screwHoles: false,
    connectable: false,
  };
}

function clip(toleranceMm: number): ConnectionClipProduct {
  return { kind: 'clip', toleranceMm };
}

function entry(id: string, product: Product): QueueEntry {
  return {
    id,
    quantity: 1,
    createdAt: '2026-07-20T10:00:00.000Z',
    product,
  };
}

/** Parses a serialized plan or fails the test with the parser's error. */
function roundTrip(entries: QueueEntry[]): QueueEntry[] {
  const result = parsePlanFile(serializePlanFile(entries, []));
  if (!result.ok) throw new Error(result.error);
  expect(result.warnings).toEqual([]);
  return result.plan.entries;
}

describe('baseplate round trip', () => {
  it('round-trips a fully optioned baseplate with every field intact', () => {
    const back = roundTrip([entry('a1', fullBaseplate())]);
    expect(back).toHaveLength(1);
    expect(back[0].product).toEqual(fullBaseplate());
  });

  it('round-trips an all-off baseplate with its nulls surviving as null', () => {
    const back = roundTrip([entry('a1', plainBaseplate())]);
    const product = back[0].product;
    if (product.kind !== 'baseplate') throw new Error('expected a baseplate');
    // Explicit null, never undefined: undefined would serialize away entirely
    // on the next persist and quietly corrupt the stored plan.
    expect(product.magnets).toBeNull();
    expect(product).toEqual(plainBaseplate());
  });

  it('round-trips clips at the nominal and at a raised tolerance exactly', () => {
    const back = roundTrip([entry('c1', clip(0)), entry('c2', clip(0.25))]);
    expect(back.map((e) => e.product)).toEqual([clip(0), clip(0.25)]);
  });

  it('keeps all five product kinds in order through a round trip', () => {
    const entries = [
      entry('e1', {
        kind: 'bin',
        labelSlot: true,
        bin: { origin: 'manual', gridX: 2, gridY: 1, heightUnits: 3, magnetHoles: false, walls: [] },
      }),
      entry('e2', {
        kind: 'binWithInsert',
        bin: { origin: 'manual', gridX: 2, gridY: 1, heightUnits: 3, magnetHoles: false, walls: [] },
        insert: { text: 'M3', text2: '', icon: null },
      }),
      entry('e3', {
        kind: 'insert',
        origin: 'manual',
        cells: 2,
        content: { text: 'M4', text2: '', icon: null },
      }),
      entry('e4', plainBaseplate()),
      entry('e5', clip(0.2)),
    ];
    const back = roundTrip(entries);
    expect(back.map((e) => e.product.kind)).toEqual([
      'bin',
      'binWithInsert',
      'insert',
      'baseplate',
      'clip',
    ]);
    expect(back).toEqual(entries);
  });
});

/** A baseplate with a brim on two adjacent edges, as a drawer-fill edge plate would carry. */
function brimmedBaseplate(): BaseplateProduct {
  return {
    kind: 'baseplate',
    unitsX: 6,
    unitsY: 7,
    magnets: null,
    screwHoles: false,
    connectable: false,
    brim: { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6 },
  };
}

describe('baseplate brim round trip and validation', () => {
  it('round-trips a brimmed baseplate with its brim intact', () => {
    const back = roundTrip([entry('a1', brimmedBaseplate())]);
    expect(back[0].product).toEqual(brimmedBaseplate());
  });

  it('round-trips a brim-less baseplate with brim staying absent, not zeroed', () => {
    const back = roundTrip([entry('a1', plainBaseplate())]);
    const product = back[0].product;
    if (product.kind !== 'baseplate') throw new Error('expected a baseplate');
    expect(product.brim).toBeUndefined();
    expect(product).toEqual(plainBaseplate());
  });

  it.each([
    [{ brim: 5 }, 'entry a1: brim must be an object'],
    [
      { brim: { leftMm: -1, rightMm: 0, frontMm: 0, backMm: 0 } },
      `entry a1: brim leftMm must be a number from 0 up to (not including) ${42}`,
    ],
    [
      { brim: { leftMm: 42, rightMm: 0, frontMm: 0, backMm: 0 } },
      `entry a1: brim leftMm must be a number from 0 up to (not including) ${42}`,
    ],
    [
      { brim: { leftMm: 0, rightMm: 'x', frontMm: 0, backMm: 0 } },
      `entry a1: brim rightMm must be a number from 0 up to (not including) ${42}`,
    ],
  ])('rejects a brimmed baseplate with %j', (overrides, message) => {
    const bad = entry('a1', { ...brimmedBaseplate(), ...overrides } as unknown as Product);
    expect(validateEntry(bad)).toBe(message);
  });

  it.each([
    [{ leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 }],
    [{ leftMm: 41.9, rightMm: 0, frontMm: 0, backMm: 0 }],
  ])('accepts the inclusive brim boundary %j', (brim) => {
    const good = entry('a1', { ...brimmedBaseplate(), brim } as unknown as Product);
    expect(validateEntry(good)).toBeNull();
  });
});

describe('baseplate and clip validation messages', () => {
  function baseplateEntry(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
    return { ...entry('a1', { ...fullBaseplate(), ...overrides } as unknown as Product) };
  }

  it.each([
    [{ unitsX: 0 }, 'entry a1: unitsX must be an integer from 1 to 20'],
    [{ unitsX: 21 }, 'entry a1: unitsX must be an integer from 1 to 20'],
    [{ unitsX: 2.5 }, 'entry a1: unitsX must be an integer from 1 to 20'],
    [{ unitsY: 0 }, 'entry a1: unitsY must be an integer from 1 to 20'],
    [{ magnets: 5 }, 'entry a1: magnets must be an object or null'],
    [{ magnets: { diameterMm: 1.9, heightMm: 2 } }, 'entry a1: magnet diameterMm must be a number from 2 to 8.2'],
    [{ magnets: { diameterMm: 8.3, heightMm: 2 } }, 'entry a1: magnet diameterMm must be a number from 2 to 8.2'],
    [{ magnets: { diameterMm: 6.5, heightMm: 0.5 } }, 'entry a1: magnet heightMm must be a number from 1 to 4'],
    [{ magnets: { diameterMm: 6.5, heightMm: 4.1 } }, 'entry a1: magnet heightMm must be a number from 1 to 4'],
    [{ screwHoles: 'yes' }, 'entry a1: screwHoles must be true or false'],
    [{ connectable: null }, 'entry a1: connectable must be true or false'],
  ])('rejects a baseplate with %j', (overrides, message) => {
    expect(validateEntry(baseplateEntry(overrides))).toBe(message);
  });

  it.each([
    [-0.1],
    [0.35],
    [0.6],
    ['0.2'],
  ])('rejects a clip whose toleranceMm is %j', (toleranceMm) => {
    const bad = entry('a1', { kind: 'clip', toleranceMm } as unknown as Product);
    expect(validateEntry(bad)).toBe('entry a1: toleranceMm must be a number from 0 to 0.3');
  });

  it.each([
    [{ unitsX: 1 }],
    [{ unitsX: 20 }],
    [{ magnets: { diameterMm: 2, heightMm: 2 } }],
    [{ magnets: { diameterMm: 8.2, heightMm: 2 } }],
    [{ magnets: { diameterMm: 6.5, heightMm: 1 } }],
    [{ magnets: { diameterMm: 6.5, heightMm: 4 } }],
  ])('accepts the inclusive baseplate boundary %j', (overrides) => {
    expect(validateEntry(baseplateEntry(overrides))).toBeNull();
  });

  it.each([[0], [0.3]])('accepts the inclusive clip tolerance boundary %d', (toleranceMm) => {
    expect(validateEntry(entry('a1', clip(toleranceMm)))).toBeNull();
  });

  it('rejects an unknown product kind with the full list of kinds', () => {
    expect(validateEntry({ ...entry('a1', plainBaseplate()), product: { kind: 'plate' } })).toBe(
      'entry a1: product kind must be bin, binWithInsert, insert, baseplate or clip',
    );
  });

  it('accepts an unknown extra key on a baseplate and drops it on load', () => {
    const withExtra = {
      ...entry('a1', plainBaseplate()),
      product: { ...plainBaseplate(), mysteryKey: 12 },
    };
    expect(validateEntry(withExtra)).toBeNull();
    const result = parsePlanFile(
      JSON.stringify({ version: PLAN_FILE_VERSION, entries: [withExtra], batches: [] }),
    );
    expect(result).toEqual({
      ok: true,
      plan: { version: PLAN_FILE_VERSION, entries: [entry('a1', plainBaseplate())], batches: [] },
      warnings: [],
    });
  });
});

describe('merge semantics with the new kinds', () => {
  it('replaces an existing bin entry with an imported baseplate sharing its id', () => {
    const existing = [
      entry('a1', {
        kind: 'bin',
        labelSlot: true,
        bin: { origin: 'manual', gridX: 2, gridY: 1, heightUnits: 3, magnetHoles: false, walls: [] },
      }),
    ];
    const merged = mergeEntries(existing, [entry('a1', fullBaseplate())]);
    expect(merged).toEqual([entry('a1', fullBaseplate())]);
  });

  it('appends an imported clip entry with a new id in file order', () => {
    const existing = [entry('a1', plainBaseplate())];
    const merged = mergeEntries(existing, [entry('c1', clip(0.2))]);
    expect(merged).toEqual([entry('a1', plainBaseplate()), entry('c1', clip(0.2))]);
  });
});

describe('part deduplication keys across clip tolerances', () => {
  it('gives clips at different tolerances distinct keys and identical ones the same key', () => {
    // partKey is JSON.stringify of the part, so this asserts the exact
    // property the batch arranger's dedupe map relies on.
    const nominal = JSON.stringify(partsOf(clip(0))[0]);
    const nominalAgain = JSON.stringify(partsOf(clip(0))[0]);
    const loosened = JSON.stringify(partsOf(clip(0.2))[0]);
    expect(nominal).toBe(nominalAgain);
    expect(nominal).not.toBe(loosened);
  });
});

describe('export plumbing for the new kinds', () => {
  it('takes the plate footprint from baseplateSpanMm on both axes', () => {
    const product = fullBaseplate();
    const part = partsOf(product)[0];
    // Compared against the geometry module's function, not a hardcoded
    // number: the arranger must agree with the generator by construction.
    expect(partFootprint(part)).toEqual({
      widthMm: baseplateSpanMm(product.unitsX),
      depthMm: baseplateSpanMm(product.unitsY),
    });
  });

  it('names baseplate downloads by grid size', () => {
    expect(fileStem(plainBaseplate())).toBe('gridfinity_baseplate_4x2');
    expect(fileStem(fullBaseplate())).toBe('gridfinity_baseplate_4x2');
  });

  it('gives clips at different tolerances distinct file stems', () => {
    expect(fileStem(clip(0))).toBe('gridfinity_connection_clip');
    expect(fileStem(clip(0.2))).toBe('gridfinity_connection_clip_tol0p2');
    expect(fileStem(clip(0))).not.toBe(fileStem(clip(0.2)));
  });
});
