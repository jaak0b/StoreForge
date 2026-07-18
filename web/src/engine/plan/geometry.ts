import type {
  InsertParams,
  SlottedBinParams,
} from '../gridfinity/types';
import { assertNever, insertOf, type Bin, type BinPockets, type Product } from './types';

/**
 * The single mapping from the plan layer's Product to the geometry layer's
 * parameter shapes. Preview and every download path expand a product through
 * partsOf, so what the user sees and what gets exported always agree.
 */

/** One printable part of a product: a bin body or a label insert. */
export type PrintablePart =
  | {
      part: 'bin';
      bin: SlottedBinParams;
      pockets?: BinPockets;
      /** Display name source: the paired insert's text, for slicer object names. */
      labelText?: string;
    }
  | { part: 'insert'; insert: InsertParams };

/** The geometry parameters of a bin, with the slot flag and paired insert content given. */
export function toSlottedBinParams(
  bin: Bin,
  labelSlot: boolean,
  insert: SlottedBinParams['insert'],
): SlottedBinParams {
  return {
    gridX: bin.gridX,
    gridY: bin.gridY,
    heightUnits: bin.heightUnits,
    stackingLip: bin.stackingLip,
    magnetHoles: bin.magnetHoles,
    // The pocket generator rejects divider walls, so a traced bin has none.
    dividerCountX: bin.origin === 'traced' ? 0 : bin.dividerCountX,
    dividerCountY: bin.origin === 'traced' ? 0 : bin.dividerCountY,
    labelSlot,
    insert,
  };
}

/**
 * Expand a product into the parts it prints. A bin ordered with its insert
 * expands into the bin (previewless of the insert) plus the insert as its
 * own placed part; the insert's width comes from insertOf, the single
 * derivation from the bin's gridX.
 */
export function partsOf(product: Product): PrintablePart[] {
  switch (product.kind) {
    case 'bin': {
      const pockets = product.bin.origin === 'traced' ? product.bin.pockets : undefined;
      return [
        { part: 'bin', bin: toSlottedBinParams(product.bin, product.labelSlot, null), pockets },
      ];
    }
    case 'binWithInsert': {
      const pockets = product.bin.origin === 'traced' ? product.bin.pockets : undefined;
      const insert = insertOf(product)!;
      const bin: PrintablePart = {
        part: 'bin',
        bin: toSlottedBinParams(product.bin, true, null),
        pockets,
      };
      if (insert.content.text !== '') bin.labelText = insert.content.text;
      return [
        bin,
        { part: 'insert', insert: { cells: insert.cells, content: insert.content } },
      ];
    }
    case 'insert': {
      const insert = insertOf(product)!;
      return [{ part: 'insert', insert: { cells: insert.cells, content: insert.content } }];
    }
    default:
      return assertNever(product);
  }
}

/**
 * The geometry parameters the live preview of a product uses: the bin with
 * its paired insert content riding along (shown resting in the slot), or
 * null when the product is a standalone insert (previewed through the insert
 * generator instead).
 */
export function previewBinParams(product: Product): SlottedBinParams | null {
  switch (product.kind) {
    case 'bin':
      return toSlottedBinParams(product.bin, product.labelSlot, null);
    case 'binWithInsert':
      return toSlottedBinParams(product.bin, true, product.insert);
    case 'insert':
      return null;
    default:
      return assertNever(product);
  }
}
