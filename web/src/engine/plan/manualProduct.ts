import type { DividerWall } from '../gridfinity/dividerModel';
import {
  assertNever,
  type Bin,
  type BinProduct,
  type BinWithInsertProduct,
  type LabelContent,
  type ManualBin,
  type Product,
  type ScrewBin,
} from './types';

/**
 * What a designer form produces: a bin plus its matching label insert, a
 * bin with an empty slot, a plain bin without the slot, or a standalone
 * insert for a bin that already exists. Maps onto the plan layer's Product
 * kinds ('bin' and 'plainBin' both save as the bin product, with labelSlot
 * true and false); the flow that builds the product adds its own origin.
 */
export type ProductChoice = 'binWithInsert' | 'bin' | 'plainBin' | 'insert';

/**
 * The inputs of a hand-designed product, as the Manual bin tab collects them.
 * For an insert-only design gridX is the insert's width in cells and the other
 * bin fields are unused.
 */
export interface ManualDesign {
  productChoice: ProductChoice;
  gridX: number;
  gridY: number;
  heightUnits: number;
  magnetHoles: boolean;
  /** Free divider walls in bin-local mm; copied, never shared with the product. */
  walls: readonly DividerWall[];
  /** The label content printed on the insert (or raised on a fused bin). */
  content: LabelContent;
  /** Whether a bin with its insert prints as one fused piece. Ignored for other choices. */
  fused: boolean;
}

/** A product choice that yields a bin: every choice except the standalone insert. */
export type BinProductChoice = Exclude<ProductChoice, 'insert'>;

/** One product choice as the product picker offers it. */
export interface ProductChoiceInfo {
  value: ProductChoice;
  title: string;
  subtitle: string;
}

/** Every product choice in picker order, with the title and subtitle the picker shows. */
export const PRODUCT_CHOICES: readonly ProductChoiceInfo[] = [
  {
    value: 'binWithInsert',
    title: 'Bin + label insert',
    subtitle: 'A bin plus the matching swappable label insert for its slot.',
  },
  {
    value: 'bin',
    title: 'Bin with empty label slot',
    subtitle: 'A bin with the label slot left empty; print inserts for it later.',
  },
  {
    value: 'plainBin',
    title: 'Bin without label slot',
    subtitle: 'A plain bin with no label feature at all.',
  },
  {
    value: 'insert',
    title: 'Label insert only',
    subtitle: 'Just the insert, for a bin you already have.',
  },
];

/**
 * The choices that order a bin without its insert. A screw entry never offers
 * them: a screw bin is printed to carry the label naming its fastener.
 */
export const BIN_ALONE_CHOICES: readonly ProductChoice[] = ['bin', 'plainBin'];

/** Whether a product choice prints label content: the bin with its insert, or the insert alone. */
export function choiceHasLabel(choice: ProductChoice): boolean {
  switch (choice) {
    case 'binWithInsert':
    case 'insert':
      return true;
    case 'bin':
    case 'plainBin':
      return false;
    default:
      return assertNever(choice);
  }
}

/**
 * The design a fresh designer form starts from: a 1 x 1 bin, 6 height units
 * tall, without magnet holes or divider walls, ordered with an empty label
 * insert. The designer store initializes from it, so a new form and any other
 * flow that designs a manual product start from the same values.
 */
export const DEFAULT_MANUAL_DESIGN: Readonly<ManualDesign> = Object.freeze({
  productChoice: 'binWithInsert',
  gridX: 1,
  gridY: 1,
  heightUnits: 6,
  magnetHoles: false,
  walls: Object.freeze([]) as readonly DividerWall[],
  content: Object.freeze({ text: '', text2: '', icon: null }) as LabelContent,
  fused: false,
});

/**
 * The single mapping from a bin product choice to a queue Product, for any
 * already-built bin (manual, screw, traced or cutout): 'binWithInsert' pairs
 * the bin with its insert (fused when asked), 'bin' keeps the empty label
 * slot, 'plainBin' drops it. A screw bin is always ordered with its insert, so
 * it only takes 'binWithInsert'. The bin is used as given; the content is
 * copied, so the product never shares it with the form that designed it.
 */
export function binProduct(
  bin: ScrewBin,
  choice: 'binWithInsert',
  content: LabelContent,
  fused: boolean,
): BinWithInsertProduct;
export function binProduct(
  bin: BinProduct['bin'],
  choice: BinProductChoice,
  content: LabelContent,
  fused: boolean,
): BinProduct | BinWithInsertProduct;
export function binProduct(
  bin: Bin,
  choice: BinProductChoice,
  content: LabelContent,
  fused: boolean,
): BinProduct | BinWithInsertProduct {
  switch (choice) {
    case 'binWithInsert': {
      const product: BinWithInsertProduct = { kind: 'binWithInsert', bin, insert: { ...content } };
      if (fused) product.fused = true;
      return product;
    }
    case 'bin':
      return { kind: 'bin', bin: withoutInsertBin(bin), labelSlot: true };
    case 'plainBin':
      return { kind: 'bin', bin: withoutInsertBin(bin), labelSlot: false };
    default:
      return assertNever(choice);
  }
}

/**
 * A bin that may be ordered without its insert. The overloads of binProduct
 * never pass a screw bin here, so one arriving is a broken invariant and throws.
 */
function withoutInsertBin(bin: Bin): BinProduct['bin'] {
  if (bin.origin === 'screw') {
    throw new Error('A screw bin is always ordered with its insert.');
  }
  return bin;
}

/** The designer state a stored product was ordered with. */
export interface DesignChoice {
  productChoice: ProductChoice;
  /** Whether a bin with its insert prints as one fused piece; false for other choices. */
  fused: boolean;
}

/**
 * The inverse of binProduct and the insert case of manualProduct: the product
 * choice and fused flag a stored product was ordered with, for loading a queue
 * entry back into a designer. A baseplate or clip is never designed through a
 * product choice, so passing one is a broken invariant and throws.
 */
export function designChoiceOf(product: Product): DesignChoice {
  switch (product.kind) {
    case 'insert':
      return { productChoice: 'insert', fused: false };
    case 'binWithInsert':
      return { productChoice: 'binWithInsert', fused: product.fused ?? false };
    case 'bin':
      return { productChoice: product.labelSlot ? 'bin' : 'plainBin', fused: false };
    case 'baseplate':
    case 'clip':
      throw new Error(`A ${product.kind} product is not designed through a product choice.`);
    default:
      return assertNever(product);
  }
}

/**
 * The single home for turning manual design inputs into a queue Product. The
 * result holds detached copies of the walls and content, so a stored entry
 * never shares state with the form that designed it.
 */
export function manualProduct(design: ManualDesign): Product {
  switch (design.productChoice) {
    case 'insert':
      return { kind: 'insert', origin: 'manual', cells: design.gridX, content: { ...design.content } };
    case 'binWithInsert':
    case 'bin':
    case 'plainBin': {
      const bin: ManualBin = {
        origin: 'manual',
        gridX: design.gridX,
        gridY: design.gridY,
        heightUnits: design.heightUnits,
        magnetHoles: design.magnetHoles,
        walls: design.walls.map((wall) => ({ ...wall })),
      };
      return binProduct(bin, design.productChoice, design.content, design.fused);
    }
    default:
      return assertNever(design.productChoice);
  }
}

/**
 * The inverse of manualProduct: the design a stored manual product was made
 * from, for loading a queue entry back into a designer. Fields a standalone
 * insert does not carry (depth, height, magnet holes, walls) take the
 * DEFAULT_MANUAL_DESIGN values, and a bin ordered without its insert carries
 * empty label content. The walls and content are detached copies. Returns null
 * for a product that was not designed by hand (screw, traced or cutout bins,
 * baseplates and clips).
 */
export function manualDesignOf(product: Product): ManualDesign | null {
  switch (product.kind) {
    case 'insert':
      if (product.origin !== 'manual') return null;
      return {
        ...DEFAULT_MANUAL_DESIGN,
        ...designChoiceOf(product),
        gridX: product.cells,
        walls: [],
        content: { ...product.content },
      };
    case 'bin':
    case 'binWithInsert': {
      const bin = product.bin;
      if (bin.origin !== 'manual') return null;
      return {
        ...designChoiceOf(product),
        gridX: bin.gridX,
        gridY: bin.gridY,
        heightUnits: bin.heightUnits,
        magnetHoles: bin.magnetHoles,
        walls: bin.walls.map((wall) => ({ ...wall })),
        content:
          product.kind === 'binWithInsert'
            ? { ...product.insert }
            : { ...DEFAULT_MANUAL_DESIGN.content },
      };
    }
    case 'baseplate':
    case 'clip':
      return null;
    default:
      return assertNever(product);
  }
}
