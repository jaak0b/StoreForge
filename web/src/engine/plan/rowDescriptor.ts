import {
  assertNever,
  type Bin,
  type BinEnvelope,
  type ManualBin,
  type Product,
  type TracedBin,
} from './types';

/**
 * The scannable two-line description of one plan row (a queue entry or a batch
 * item). Every concept gets exactly one slot: the title says what the row is
 * called, the caption says what it physically is. The size never appears in
 * the title, so a labeled and an unlabeled row line their columns up.
 *
 * This is the single source of both strings; queue rows, batch rows and any
 * other listing derive their text here rather than composing their own.
 */
export interface RowDescriptor {
  /** Label line 1, the synthesized bin description, or the placeholder. */
  title: string;
  /** Label line 2, shown after the title in a secondary color. Empty for none. */
  titleLine2: string;
  /** True when the title stands in for a label the row does not have yet. */
  titlePlaceholder: boolean;
  /** Name of the label icon shown before the title, or null for none. */
  iconName: string | null;
  /** The physical description: kind, size, origin and one detail. */
  caption: string;
}

/** Title of a row whose insert carries no text to name it by. */
const PLACEHOLDER_TITLE = 'Insert with no text';

/** Separator between caption tokens. */
const CAPTION_SEPARATOR = ' · ';

/** "1 divider", "3 dividers": a count with its noun in the matching number. */
function countPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The bin size as grid unit counts, never millimetres: 1×1×6 is one cell wide,
 * one cell deep and six height units tall.
 */
function sizeToken(bin: BinEnvelope): string {
  return `${bin.gridX}×${bin.gridY}×${bin.heightUnits}`;
}

/** The one interior detail a bin's caption carries, or an empty token. */
function detailToken(bin: Bin): string {
  if (bin.origin === 'traced') {
    const pockets = bin.pockets.placements.length;
    return pockets === 0 ? '' : countPhrase(pockets, 'pocket');
  }
  const dividers = bin.dividerCountX + bin.dividerCountY;
  return dividers === 0 ? '' : countPhrase(dividers, 'divider');
}

/**
 * The title of a bin ordered without an insert, synthesized from the bin's own
 * fields. There is no label to name the row by, so the row is named by what it
 * actually is.
 */
function synthesizedTitle(bin: ManualBin | TracedBin): string {
  if (bin.origin === 'traced') {
    const pockets = bin.pockets.placements.length;
    return pockets === 0 ? 'Traced bin' : `Traced bin, ${countPhrase(pockets, 'pocket')}`;
  }
  const parts = ['Bin'];
  const dividers = bin.dividerCountX + bin.dividerCountY;
  if (dividers > 0) parts.push(countPhrase(dividers, 'divider'));
  if (bin.magnetHoles) parts.push('magnet holes');
  return parts.join(', ');
}

/** Joins the caption tokens in their fixed order, dropping the empty ones. */
function joinCaption(tokens: string[]): string {
  return tokens.filter((token) => token !== '').join(CAPTION_SEPARATOR);
}

/** The caption of a product: kind, size, origin and one detail. */
function captionOf(product: Product): string {
  switch (product.kind) {
    case 'insert':
      // An insert is sized only by its cell width; it has no depth or height.
      return joinCaption(['insert', countPhrase(product.cells, 'cell'), product.origin]);
    case 'bin':
    case 'binWithInsert': {
      const kind = product.kind === 'binWithInsert' ? 'bin + insert' : 'bin';
      const bin = product.bin;
      return joinCaption([kind, sizeToken(bin), bin.origin, detailToken(bin)]);
    }
    default:
      return assertNever(product);
  }
}

/** Describes one plan row's product as a title line and a caption line. */
export function describeProduct(product: Product): RowDescriptor {
  const caption = captionOf(product);
  if (product.kind === 'bin') {
    return {
      title: synthesizedTitle(product.bin),
      titleLine2: '',
      titlePlaceholder: false,
      iconName: null,
      caption,
    };
  }
  const content = product.kind === 'binWithInsert' ? product.insert : product.content;
  const hasText = content.text !== '';
  return {
    title: hasText ? content.text : PLACEHOLDER_TITLE,
    titleLine2: content.text2,
    titlePlaceholder: !hasText,
    iconName: content.icon,
    caption,
  };
}
