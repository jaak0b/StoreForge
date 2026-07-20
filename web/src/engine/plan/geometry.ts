import type {
  InsertParams,
  SlottedBinParams,
} from '../gridfinity/types';
import type { BaseplateParams, ConnectionClipParams } from '../baseplate/constants';
import {
  assertNever,
  insertOf,
  type BaseplateProduct,
  type Bin,
  type BinPockets,
  type CutoutModel,
  type Product,
} from './types';

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
      /** The models carved out of the interior, for a cutout-origin bin. */
      models?: CutoutModel[];
      /** Display name source: the paired insert's text, for slicer object names. */
      labelText?: string;
    }
  | { part: 'insert'; insert: InsertParams }
  | { part: 'baseplate'; baseplate: BaseplateParams }
  | { part: 'clip'; clip: ConnectionClipParams };

/** A printable part that is a bin body, narrowed off the part union. */
export type PrintableBinPart = Extract<PrintablePart, { part: 'bin' }>;

/**
 * Which interior a printable bin part carries, as a tagged union: models to
 * carve out, tool pockets to subtract, or an interior described by divider
 * walls alone (which travel inside the bin's own geometry parameters).
 */
export type BinInterior =
  | { interior: 'models'; models: CutoutModel[] }
  | { interior: 'pockets'; pockets: BinPockets }
  | { interior: 'walls' };

/**
 * Reads a bin part's interior into that tagged form. This is the read side of
 * what interiorFeaturesOf writes, kept beside it so the two cannot drift, and
 * it exists so that choosing a generator is an exhaustive switch rather than a
 * chain of presence checks whose last branch assumes whatever is left. That
 * assumption is what would let a cutout bin be generated as a plain one and
 * exported as an uncarved solid, which looks correct and wastes a real print.
 */
export function binInteriorOf(part: PrintableBinPart): BinInterior {
  if (part.models !== undefined) return { interior: 'models', models: part.models };
  if (part.pockets !== undefined) return { interior: 'pockets', pockets: part.pockets };
  return { interior: 'walls' };
}

/**
 * The interior features a bin carries beyond its envelope, keyed by the origin
 * that owns them: tool pockets for a traced bin, carved models for a cutout
 * bin, and neither for a bin whose interior is described by divider walls. The
 * single place a bin's interior features are read off its origin, so every
 * part a product expands into carries the same ones.
 */
function interiorFeaturesOf(bin: Bin): { pockets?: BinPockets; models?: CutoutModel[] } {
  switch (bin.origin) {
    case 'traced':
      return { pockets: bin.pockets };
    case 'cutout':
      return { models: bin.models };
    case 'manual':
    case 'screw':
      return {};
    default:
      return assertNever(bin);
  }
}

/** The geometry parameters of a bin, with the slot flag and paired insert content given. */
export function toSlottedBinParams(
  bin: Bin,
  labelSlot: boolean,
  insert: SlottedBinParams['insert'],
  fusedLabel: SlottedBinParams['fusedLabel'] = null,
): SlottedBinParams {
  return {
    gridX: bin.gridX,
    gridY: bin.gridY,
    heightUnits: bin.heightUnits,
    magnetHoles: bin.magnetHoles,
    // Both carve flows fill the interior solid before subtracting, so neither a
    // traced nor a cutout bin has divider walls for the walls to divide.
    walls: bin.origin === 'traced' || bin.origin === 'cutout' ? [] : bin.walls,
    labelSlot,
    insert,
    fusedLabel,
  };
}

/**
 * The single place a stored baseplate becomes geometry: the preview, the STL
 * path and the 3MF path all go through here, so what the user sees and what
 * gets exported agree. A null custom span means the axis's last cell keeps
 * the full pitch, which the generator resolves from its own pitch parameter
 * rather than a stored 42. The magnets object is copied so the returned
 * params are detached from the (possibly reactive) product.
 */
export function baseplateParamsOf(product: BaseplateProduct): BaseplateParams {
  return {
    unitsX: product.unitsX,
    unitsY: product.unitsY,
    customXMm: product.customXMm,
    customYMm: product.customYMm,
    magnets: product.magnets === null ? null : { ...product.magnets },
    screwHoles: product.screwHoles,
    connectable: product.connectable,
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
      const interior = interiorFeaturesOf(product.bin);
      return [
        {
          part: 'bin',
          bin: toSlottedBinParams(product.bin, product.labelSlot, null),
          ...interior,
        },
      ];
    }
    case 'binWithInsert': {
      const interior = interiorFeaturesOf(product.bin);
      const insert = insertOf(product)!;
      if (product.fused) {
        // Fused: one part only, the bin with the label raised on its top face
        // (no slot, no separate insert).
        const bin: PrintablePart = {
          part: 'bin',
          bin: toSlottedBinParams(product.bin, false, null, insert.content),
          ...interior,
        };
        if (insert.content.text !== '') bin.labelText = insert.content.text;
        return [bin];
      }
      const bin: PrintablePart = {
        part: 'bin',
        bin: toSlottedBinParams(product.bin, true, null),
        ...interior,
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
    // Exactly one part each: a baseplate and a clip are single solids and
    // never expand into two parts the way binWithInsert does.
    case 'baseplate':
      return [{ part: 'baseplate', baseplate: baseplateParamsOf(product) }];
    case 'clip':
      return [{ part: 'clip', clip: { toleranceMm: product.toleranceMm } }];
    default:
      return assertNever(product);
  }
}

/**
 * The geometry parameters the live preview of a product uses: the bin with
 * its paired insert content riding along (shown resting in the slot), or
 * null when the product is a standalone insert (previewed through the insert
 * generator instead). A baseplate and a clip are also null: each is previewed
 * through its own generator.
 */
export function previewBinParams(product: Product): SlottedBinParams | null {
  switch (product.kind) {
    case 'bin':
      return toSlottedBinParams(product.bin, product.labelSlot, null);
    case 'binWithInsert':
      // Fused shows the raised label on the bin (no slot, no resting insert);
      // otherwise the paired insert rides along resting in the slot.
      return product.fused
        ? toSlottedBinParams(product.bin, false, null, product.insert)
        : toSlottedBinParams(product.bin, true, product.insert);
    case 'insert':
    case 'baseplate':
    case 'clip':
      return null;
    default:
      return assertNever(product);
  }
}
