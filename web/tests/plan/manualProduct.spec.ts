import { describe, expect, it } from 'vitest';
import { manualProduct, type ManualDesign } from '../../src/engine/plan/manualProduct';

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
