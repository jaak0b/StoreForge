import type { DividerWall } from '../gridfinity/dividerModel';
import { assertNever, type LabelContent, type ManualBin, type Product } from './types';

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

/**
 * The single home for turning manual design inputs into a queue Product. The
 * result holds detached copies of the walls and content, so a stored entry
 * never shares state with the form that designed it.
 */
export function manualProduct(design: ManualDesign): Product {
  const content: LabelContent = { ...design.content };
  const bin = (): ManualBin => ({
    origin: 'manual',
    gridX: design.gridX,
    gridY: design.gridY,
    heightUnits: design.heightUnits,
    magnetHoles: design.magnetHoles,
    walls: design.walls.map((wall) => ({ ...wall })),
  });
  switch (design.productChoice) {
    case 'insert':
      return { kind: 'insert', origin: 'manual', cells: design.gridX, content };
    case 'binWithInsert': {
      const product: Product = { kind: 'binWithInsert', bin: bin(), insert: content };
      if (design.fused) product.fused = true;
      return product;
    }
    case 'bin':
      return { kind: 'bin', bin: bin(), labelSlot: true };
    case 'plainBin':
      return { kind: 'bin', bin: bin(), labelSlot: false };
    default:
      return assertNever(design.productChoice);
  }
}
