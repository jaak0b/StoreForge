import { describe, expect, it } from 'vitest';
import { parseShorthand } from '../../src/engine/plan/screwListImport';
import {
  incompleteScrewBatchHint,
  previewScrewProduct,
  screwProducts,
  type ScrewProductOptions,
} from '../../src/engine/plan/screwProducts';
import type { DividerWall } from '../../src/engine/plan/types';

/** Options for a plain bin with insert at height 4, auto-sized, no extras. */
function options(overrides: Partial<ScrewProductOptions> = {}): ScrewProductOptions {
  return {
    productChoice: 'binWithInsert',
    heightUnits: 4,
    sizeOverride: null,
    magnetHoles: false,
    fused: false,
    walls: [],
    ...overrides,
  };
}

describe('screwProducts', () => {
  it('builds a bin with its label insert, sized and labeled from the screw', () => {
    const result = screwProducts(parseShorthand('m3x20 fhcs x5').batches, options());

    expect(result.problem).toBeNull();
    expect(result.skipped).toEqual([]);
    expect(result.products).toEqual([
      {
        quantity: 5,
        product: {
          kind: 'binWithInsert',
          bin: {
            origin: 'screw',
            gridX: 1,
            gridY: 1,
            heightUnits: 4,
            magnetHoles: false,
            walls: [],
            screw: { thread: 'M3', lengthMm: 20, head: 'countersunk screw', enteredLengthText: null },
          },
          insert: { text: 'M3 x 20', text2: '', icon: 'countersunk screw' },
        },
      },
    ]);
  });

  it('sizes a cap screw from its overall length, so an M5x28 cap screw gets two units', () => {
    // 28 mm nominal plus the 5 mm cap head crosses the 32 mm one-unit limit.
    const result = screwProducts(parseShorthand('m5x28 shcs').batches, options());

    const product = result.products[0].product;
    expect(product.kind === 'binWithInsert' && product.bin.gridX).toBe(2);
  });

  it('builds a standalone screw insert when the choice is insert only', () => {
    const result = screwProducts(
      parseShorthand('m5 nut x3').batches,
      options({ productChoice: 'insert' }),
    );

    expect(result.products).toEqual([
      {
        quantity: 3,
        product: {
          kind: 'insert',
          origin: 'screw',
          cells: 1,
          content: { text: 'M5 NUT', text2: '', icon: 'hex nut' },
          screw: { thread: 'M5', lengthMm: null, head: 'hex nut', enteredLengthText: null },
        },
      },
    ]);
  });

  it.each(['bin', 'plainBin'] as const)(
    'still orders a screw bin with its insert when the choice is %s',
    (productChoice) => {
      const result = screwProducts(parseShorthand('m3x20 fhcs').batches, options({ productChoice }));

      expect(result.products[0].product.kind).toBe('binWithInsert');
    },
  );

  it('carries magnet holes, the fused flag and detached copies of the walls', () => {
    const walls: DividerWall[] = [{ x1: 0, y1: 10, x2: 30, y2: 10 }];

    const result = screwProducts(
      parseShorthand('m3x20 fhcs').batches,
      options({ magnetHoles: true, fused: true, walls }),
    );

    const product = result.products[0].product;
    if (product.kind !== 'binWithInsert') throw new Error('expected a bin with insert');
    expect(product.fused).toBe(true);
    expect(product.bin.magnetHoles).toBe(true);
    expect(product.bin.origin === 'screw' && product.bin.walls).toEqual([
      { x1: 0, y1: 10, x2: 30, y2: 10 },
    ]);
    expect(product.bin.origin === 'screw' && product.bin.walls[0]).not.toBe(walls[0]);
  });

  it('uses the given height for a single screw', () => {
    const result = screwProducts(parseShorthand('m3x20 fhcs').batches, options({ heightUnits: 9 }));

    const product = result.products[0].product;
    expect(product.kind === 'binWithInsert' && product.bin.heightUnits).toBe(9);
  });

  it('uses the default height of 6 for every bin of a multi-entry list', () => {
    const result = screwProducts(
      parseShorthand('m3x20 fhcs, m4x12 bhcs').batches,
      options({ heightUnits: 9 }),
    );

    expect(
      result.products.map(({ product }) =>
        product.kind === 'binWithInsert' ? product.bin.heightUnits : null,
      ),
    ).toEqual([6, 6]);
  });

  it('ignores an invalid height for a multi-entry list, which never uses it', () => {
    const result = screwProducts(
      parseShorthand('m3x20 fhcs, m4x12 bhcs').batches,
      options({ heightUnits: 1 }),
    );

    expect(result.problem).toBeNull();
    expect(result.products).toHaveLength(2);
  });

  it('refuses an invalid height for a single screw with a user-worded problem', () => {
    const result = screwProducts(parseShorthand('m3x20 fhcs').batches, options({ heightUnits: 1 }));

    expect(result.products).toEqual([]);
    expect(result.problem).toBe('The height must be a number of at least 2 height units.');
  });

  it('applies the size override to every batch of a list', () => {
    // Auto sizing would give 1 unit for M3x20 and 3 units for M3x80.
    const result = screwProducts(
      parseShorthand('m3x20 fhcs, m3x80 fhcs').batches,
      options({ sizeOverride: { width: 2, depth: 3 } }),
    );

    expect(
      result.products.map(({ product }) =>
        product.kind === 'binWithInsert' ? [product.bin.gridX, product.bin.gridY] : null,
      ),
    ).toEqual([
      [2, 3],
      [2, 3],
    ]);
  });

  it('applies the size override width to a standalone insert', () => {
    const result = screwProducts(
      parseShorthand('m3x80 fhcs').batches,
      options({ productChoice: 'insert', sizeOverride: { width: 2, depth: 1 } }),
    );

    const product = result.products[0].product;
    expect(product.kind === 'insert' && product.cells).toBe(2);
  });

  it('refuses a fractional size override with a user-worded problem', () => {
    const result = screwProducts(
      parseShorthand('m3x20 fhcs').batches,
      options({ sizeOverride: { width: 1.5, depth: 1 } }),
    );

    expect(result.products).toEqual([]);
    expect(result.problem).toBe(
      'The bin width and depth must be whole numbers of at least 1 grid unit.',
    );
  });

  it('lists every incomplete batch as skipped with its reason, keeping the complete ones', () => {
    const result = screwProducts(
      parseShorthand('m3 fhcs, m4x12 bhcs, fhcs 20mm').batches,
      options(),
    );

    expect(result.products).toHaveLength(1);
    expect(result.products[0].quantity).toBe(1);
    expect(result.skipped).toEqual([
      {
        index: 0,
        recognized: 'M3, countersunk screw',
        missing: 'length',
        reason: 'Entry 1 (M3, countersunk screw) has no length.',
      },
      {
        index: 2,
        recognized: 'countersunk screw, 20 mm',
        missing: 'thread',
        reason: 'Entry 3 (countersunk screw, 20 mm) has no thread size.',
      },
    ]);
  });

  it('counts a lengthless head as complete without a length', () => {
    const result = screwProducts(parseShorthand('m5 washer').batches, options());

    expect(result.skipped).toEqual([]);
    expect(result.products).toHaveLength(1);
  });

  it('keeps the edited entry length text while the length is unchanged', () => {
    const edited = {
      thread: 'M3',
      lengthMm: 20,
      head: 'countersunk screw' as const,
      enteredLengthText: '3/4"',
    };

    const result = screwProducts(
      parseShorthand('m3x20 fhcs').batches,
      options({ keepEnteredLengthFrom: edited }),
    );

    const product = result.products[0].product;
    expect(product.kind === 'binWithInsert' && product.insert.text).toBe('M3 x 3/4"');
    expect(product.kind === 'binWithInsert' && product.bin.origin === 'screw' && product.bin.screw.enteredLengthText).toBe('3/4"');
  });

  it('drops the edited entry length text once the length changes', () => {
    const edited = {
      thread: 'M3',
      lengthMm: 20,
      head: 'countersunk screw' as const,
      enteredLengthText: '3/4"',
    };

    const result = screwProducts(
      parseShorthand('m3x25 fhcs').batches,
      options({ keepEnteredLengthFrom: edited }),
    );

    const product = result.products[0].product;
    expect(product.kind === 'binWithInsert' && product.insert.text).toBe('M3 x 25');
  });
});

describe('incompleteScrewBatchHint', () => {
  it('names what is recognized and asks for the missing length', () => {
    const batch = parseShorthand('m3 fhcs').batches[0];

    expect(incompleteScrewBatchHint(batch)).toBe('M3, countersunk screw. Add a length.');
  });

  it('asks only for the thread when nothing else is recognized', () => {
    const batch = parseShorthand('qty5').batches[0];

    expect(incompleteScrewBatchHint(batch)).toBe('Add a thread size.');
  });

  it('is empty for a complete batch', () => {
    const batch = parseShorthand('m3x20 fhcs').batches[0];

    expect(incompleteScrewBatchHint(batch)).toBe('');
  });
});

describe('previewScrewProduct', () => {
  it('previews an incomplete batch with the label text parsed so far', () => {
    const batch = parseShorthand('m3 fhcs').batches[0];

    const product = previewScrewProduct(batch, options());

    expect(product.kind === 'binWithInsert' && product.insert.text).toBe('M3');
  });
});
