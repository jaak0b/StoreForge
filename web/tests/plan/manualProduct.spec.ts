import { describe, expect, it } from 'vitest';
import {
  binProduct,
  designChoiceOf,
  manualDesignOf,
  manualProduct,
  type ManualDesign,
} from '../../src/engine/plan/manualProduct';
import type { CutoutBin, Product } from '../../src/engine/plan/types';

/** A 2 x 3 x 5 design with magnets, one wall and a label. */
function design(overrides: Partial<ManualDesign> = {}): ManualDesign {
  return {
    productChoice: 'binWithInsert',
    gridX: 2,
    gridY: 3,
    heightUnits: 5,
    magnetHoles: true,
    walls: [{ x1: 0, y1: 20, x2: 70, y2: 20 }],
    content: { text: 'Pliers', text2: 'small', icon: 'wrench' },
    fused: false,
    ...overrides,
  };
}

const BIN = {
  origin: 'manual',
  gridX: 2,
  gridY: 3,
  heightUnits: 5,
  magnetHoles: true,
  walls: [{ x1: 0, y1: 20, x2: 70, y2: 20 }],
};

describe('manualProduct', () => {
  it('maps a bin with insert to a binWithInsert product without the fused flag', () => {
    expect(manualProduct(design())).toEqual({
      kind: 'binWithInsert',
      bin: BIN,
      insert: { text: 'Pliers', text2: 'small', icon: 'wrench' },
    });
  });

  it('sets the fused flag on a fused bin with insert', () => {
    const product = manualProduct(design({ fused: true }));

    expect(product.kind === 'binWithInsert' && product.fused).toBe(true);
  });

  it('maps a bin with an empty slot to a bin product with the label slot', () => {
    expect(manualProduct(design({ productChoice: 'bin' }))).toEqual({
      kind: 'bin',
      bin: BIN,
      labelSlot: true,
    });
  });

  it('maps a plain bin to a bin product without the label slot, ignoring fused', () => {
    expect(manualProduct(design({ productChoice: 'plainBin', fused: true }))).toEqual({
      kind: 'bin',
      bin: BIN,
      labelSlot: false,
    });
  });

  it('maps insert only to a manual insert as wide as gridX', () => {
    expect(manualProduct(design({ productChoice: 'insert' }))).toEqual({
      kind: 'insert',
      origin: 'manual',
      cells: 2,
      content: { text: 'Pliers', text2: 'small', icon: 'wrench' },
    });
  });

  it('detaches the walls and content from the design inputs', () => {
    const input = design();

    const product = manualProduct(input);
    input.walls[0].x1 = 99;
    input.content.text = 'changed';

    if (product.kind !== 'binWithInsert') throw new Error('expected a bin with insert');
    expect(product.bin.origin === 'manual' && product.bin.walls[0].x1).toBe(0);
    expect(product.insert.text).toBe('Pliers');
  });
});

/** A 3 x 2 x 6 cutout bin with no models, as a carve flow builds it. */
function cutoutBin(): CutoutBin {
  return { origin: 'cutout', gridX: 3, gridY: 2, heightUnits: 6, magnetHoles: false, models: [], edits: [] };
}

const LABEL = { text: 'Calipers', text2: '', icon: null };

describe('binProduct', () => {
  it('pairs any bin with a copy of its insert content for a bin with insert', () => {
    const content = { ...LABEL };

    const product = binProduct(cutoutBin(), 'binWithInsert', content, false);
    content.text = 'changed';

    expect(product).toEqual({
      kind: 'binWithInsert',
      bin: cutoutBin(),
      insert: { text: 'Calipers', text2: '', icon: null },
    });
  });

  it('sets the fused flag on a fused bin with insert', () => {
    expect(binProduct(cutoutBin(), 'binWithInsert', LABEL, true)).toEqual({
      kind: 'binWithInsert',
      bin: cutoutBin(),
      insert: { text: 'Calipers', text2: '', icon: null },
      fused: true,
    });
  });

  it('keeps the label slot for a bin and drops it for a plain bin, ignoring fused', () => {
    expect(binProduct(cutoutBin(), 'bin', LABEL, true)).toEqual({
      kind: 'bin',
      bin: cutoutBin(),
      labelSlot: true,
    });
    expect(binProduct(cutoutBin(), 'plainBin', LABEL, true)).toEqual({
      kind: 'bin',
      bin: cutoutBin(),
      labelSlot: false,
    });
  });
});

describe('designChoiceOf', () => {
  it.each<[string, Product, { productChoice: string; fused: boolean }]>([
    [
      'a fused bin with insert',
      { kind: 'binWithInsert', bin: cutoutBin(), insert: LABEL, fused: true },
      { productChoice: 'binWithInsert', fused: true },
    ],
    [
      'a bin with insert without the fused flag',
      { kind: 'binWithInsert', bin: cutoutBin(), insert: LABEL },
      { productChoice: 'binWithInsert', fused: false },
    ],
    [
      'a bin with the label slot',
      { kind: 'bin', bin: cutoutBin(), labelSlot: true },
      { productChoice: 'bin', fused: false },
    ],
    [
      'a bin without the label slot',
      { kind: 'bin', bin: cutoutBin(), labelSlot: false },
      { productChoice: 'plainBin', fused: false },
    ],
    [
      'a standalone insert',
      { kind: 'insert', origin: 'manual', cells: 2, content: LABEL },
      { productChoice: 'insert', fused: false },
    ],
  ])('reads %s back as the choice it was ordered with', (_name, product, expected) => {
    expect(designChoiceOf(product)).toEqual(expected);
  });

  it('throws for a baseplate, which is never designed through a product choice', () => {
    const plate: Product = {
      kind: 'baseplate',
      unitsX: 4,
      unitsY: 2,
      magnets: null,
      screwHoles: false,
      connectable: false,
    };

    expect(() => designChoiceOf(plate)).toThrow('not designed through a product choice');
  });
});

describe('manualDesignOf', () => {
  it.each<[string, ManualDesign]>([
    ['a bin with its insert', design()],
    ['a fused bin with its insert', design({ fused: true })],
    ['a bin with an empty label slot', design({ productChoice: 'bin', content: { text: '', text2: '', icon: null } })],
    ['a bin without the label slot', design({ productChoice: 'plainBin', content: { text: '', text2: '', icon: null } })],
  ])('reads %s back as the design it was built from', (_name, original) => {
    expect(manualDesignOf(manualProduct(original))).toEqual(original);
  });

  it('reads a standalone insert back with the default bin fields', () => {
    const product: Product = {
      kind: 'insert',
      origin: 'manual',
      cells: 3,
      content: { text: 'Bits', text2: '', icon: 'hex nut' },
    };

    expect(manualDesignOf(product)).toEqual({
      productChoice: 'insert',
      gridX: 3,
      gridY: 1,
      heightUnits: 6,
      magnetHoles: false,
      walls: [],
      content: { text: 'Bits', text2: '', icon: 'hex nut' },
      fused: false,
    });
  });

  it('returns a design that shares no walls with the stored product', () => {
    const product = manualProduct(design());

    const loaded = manualDesignOf(product)!;
    loaded.walls[0].x1 = 99;

    expect(product).toMatchObject({ bin: { walls: [{ x1: 0, y1: 20, x2: 70, y2: 20 }] } });
  });

  it('returns null for a bin that was not designed by hand', () => {
    expect(manualDesignOf({ kind: 'bin', bin: cutoutBin(), labelSlot: true })).toBeNull();
  });
});
