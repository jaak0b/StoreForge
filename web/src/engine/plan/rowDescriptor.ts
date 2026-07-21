import { describeMissingModels, missingCutoutModels } from './missingModels';
import { baseplateOuterMm } from '../baseplate/generator';
import {
  assertNever,
  binOf,
  type Bin,
  type BinEnvelope,
  type CutoutBin,
  type DrawerPlate,
  type Group,
  type ManualBin,
  type PrintBatch,
  type Product,
  type QueueEntry,
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
  /**
   * A sentence naming the model files this device does not have, so a bin
   * imported from another machine states what it needs without being opened.
   * Empty when nothing is missing, and empty whenever the caller did not say
   * which models are stored (an unread model store must not read as missing).
   */
  missingModels: string;
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

/**
 * The one interior detail a bin's caption carries, or an empty token. Switched
 * over every origin rather than tested for one: an origin whose interior is
 * described by something other than divider walls must be named here, or it
 * would read another origin's field.
 */
function detailToken(bin: Bin): string {
  switch (bin.origin) {
    case 'traced': {
      const pockets = bin.pockets.placements.length;
      return pockets === 0 ? '' : countPhrase(pockets, 'pocket');
    }
    case 'cutout': {
      const cutouts = bin.models.length;
      return cutouts === 0 ? '' : countPhrase(cutouts, 'cutout');
    }
    case 'manual':
    case 'screw': {
      const dividers = bin.walls.length;
      return dividers === 0 ? '' : countPhrase(dividers, 'divider');
    }
    default:
      return assertNever(bin);
  }
}

/**
 * The title of a bin ordered without an insert, synthesized from the bin's own
 * fields. There is no label to name the row by, so the row is named by what it
 * actually is. Exhaustive over the origin for the same reason detailToken is.
 */
function synthesizedTitle(bin: ManualBin | TracedBin | CutoutBin): string {
  switch (bin.origin) {
    case 'traced': {
      const pockets = bin.pockets.placements.length;
      return pockets === 0 ? 'Traced bin' : `Traced bin, ${countPhrase(pockets, 'pocket')}`;
    }
    case 'cutout': {
      const cutouts = bin.models.length;
      return cutouts === 0 ? 'Cutout bin' : `Cutout bin, ${countPhrase(cutouts, 'cutout')}`;
    }
    case 'manual': {
      const parts = ['Bin'];
      const dividers = bin.walls.length;
      if (dividers > 0) parts.push(countPhrase(dividers, 'divider'));
      if (bin.magnetHoles) parts.push('magnet holes');
      return parts.join(', ');
    }
    default:
      return assertNever(bin);
  }
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
    case 'baseplate': {
      // Two dimensions, not three: a baseplate has no height units to state.
      // The brim, when present, is named by the plate's exact outer size in
      // mm (baseplateOuterMm), never recomputed here.
      const outer = product.brim === undefined ? null : baseplateOuterMm(product);
      return joinCaption([
        'baseplate',
        `${product.unitsX}×${product.unitsY}`,
        outer === null ? '' : `${outer.widthMm.toFixed(1)}×${outer.depthMm.toFixed(1)} mm outer`,
        product.magnets !== null ? 'magnets' : '',
        product.screwHoles ? 'screw holes' : '',
        product.connectable ? 'connectable' : '',
      ]);
    }
    case 'clip':
      // The tolerance token appears only when non-zero, so two clip rows that
      // print differently are distinguishable in the queue.
      return joinCaption([
        'connection clip',
        product.toleranceMm !== 0 ? `tolerance ${product.toleranceMm} mm` : '',
      ]);
    default:
      return assertNever(product);
  }
}

/**
 * What the row says about model files this device does not have. Exhaustive
 * over the origin for the same reason detailToken is: an origin that comes to
 * depend on stored blobs has to answer this question for itself.
 */
function missingModelsOf(bin: Bin, storedModelIds: ReadonlySet<string>): string {
  switch (bin.origin) {
    case 'cutout':
      return describeMissingModels(missingCutoutModels(bin, storedModelIds));
    case 'traced':
    case 'manual':
    case 'screw':
      return '';
    default:
      return assertNever(bin);
  }
}

/**
 * Describes one plan row's product as a title line and a caption line.
 *
 * `storedModelIds` is the set of cutout model ids this device actually holds,
 * which only a caller that has read the model store can know. Leaving it out
 * means the question was never asked, and no row then claims a missing model.
 */
export function describeProduct(
  product: Product,
  storedModelIds?: ReadonlySet<string>,
): RowDescriptor {
  const caption = captionOf(product);
  const bin = binOf(product);
  const missingModels =
    storedModelIds === undefined || bin === null ? '' : missingModelsOf(bin, storedModelIds);
  if (product.kind === 'bin') {
    return {
      title: synthesizedTitle(product.bin),
      titleLine2: '',
      titlePlaceholder: false,
      iconName: null,
      caption,
      missingModels,
    };
  }
  // The baseplate and clip branches must stay above the label-content
  // fallthrough below, which dereferences an insert or content neither kind
  // carries. titlePlaceholder stays false: true renders italic and dimmed,
  // meaning "this row has no label yet", and a baseplate is not missing one.
  if (product.kind === 'baseplate') {
    return {
      title: 'Baseplate',
      titleLine2: '',
      titlePlaceholder: false,
      iconName: null,
      caption,
      missingModels,
    };
  }
  if (product.kind === 'clip') {
    return {
      title: 'Connection clip',
      titleLine2: '',
      titlePlaceholder: false,
      iconName: null,
      caption,
      missingModels,
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
    missingModels,
  };
}

// ---------------------------------------------------------------------------
// Group status derivation
// ---------------------------------------------------------------------------

/**
 * One plate's place in the print cycle, most-advanced first: it has printed
 * successfully (done), it is in an open print batch (printing), it is still a
 * queue row waiting to be batched (queued), or it exists only in the group's
 * plan with no plate ordered yet (planned). The four are mutually exclusive
 * and derived in this precedence.
 */
export type GroupPlateStatus = 'done' | 'printing' | 'queued' | 'planned';

/** One plate of a group with the status derived for it. */
export interface GroupPlateDescriptor {
  plate: DrawerPlate;
  status: GroupPlateStatus;
}

/** A group's plates with their statuses and the roll-up counts per status. */
export interface GroupDescriptor {
  /** The group's display name. */
  name: string;
  /** Each plate with its derived status, in the group's plate order. */
  plates: GroupPlateDescriptor[];
  /** How many plates fall in each status, plus the total. */
  counts: { done: number; printing: number; queued: number; planned: number; total: number };
  /**
   * Summed quantity of the group's still-queued linked connection clip rows.
   * Zero when the drawer is not connectable or its clip row was already
   * batched or confirmed.
   */
  queuedClipCount: number;
}

/** Whether a product is a linked baseplate that stands for the given plate in the given group. */
function isPlateProduct(product: Product, groupId: string, plateId: string): boolean {
  return (
    product.kind === 'baseplate' &&
    product.group !== undefined &&
    product.group.groupId === groupId &&
    product.group.plateIds.includes(plateId)
  );
}

/**
 * Derives the status of every plate in a group and the roll-up counts, from the
 * group's own done list and the plan's queue entries and batches. Precedence is
 * done, then printing (a linked batch item exists), then queued (a linked queue
 * entry exists), then planned. Framework-agnostic: the queue and group views
 * both read their status here rather than each deriving it.
 */
export function describeGroup(
  group: Group,
  entries: QueueEntry[],
  batches: PrintBatch[],
): GroupDescriptor {
  const payload = group.payload;
  switch (payload.kind) {
    case 'drawer': {
      const done = new Set(payload.donePlateIds);
      const counts = { done: 0, printing: 0, queued: 0, planned: 0, total: payload.plates.length };
      const plates = payload.plates.map((plate): GroupPlateDescriptor => {
        let status: GroupPlateStatus;
        if (done.has(plate.id)) {
          status = 'done';
        } else if (
          batches.some((batch) =>
            batch.items.some((item) => isPlateProduct(item.product, group.id, plate.id)),
          )
        ) {
          status = 'printing';
        } else if (
          entries.some((entry) => isPlateProduct(entry.product, group.id, plate.id))
        ) {
          status = 'queued';
        } else {
          status = 'planned';
        }
        counts[status] += 1;
        return { plate, status };
      });
      const queuedClipCount = entries.reduce(
        (sum, entry) =>
          entry.product.kind === 'clip' && entry.product.group?.groupId === group.id
            ? sum + entry.quantity
            : sum,
        0,
      );
      return { name: group.name, plates, counts, queuedClipCount };
    }
    default:
      return assertNever(payload.kind);
  }
}

/** The download menu's per-kind strings: two subtitles and the 3MF entry's title. */
export interface DownloadMenuText {
  /** Subtitle of the STL entry. */
  stl: string;
  /** Title of the 3MF entry: names the filament count honestly per kind. */
  threeMfTitle: string;
  /** Subtitle of the 3MF entry. */
  threeMf: string;
}

/**
 * The download-menu strings of a row, derived per product kind: the two-slot
 * bin wording is false on a part that has no label, so the strings live here
 * beside the row's other user-facing text rather than hardcoded in a
 * template.
 */
export function downloadSubtitles(product: Product): DownloadMenuText {
  switch (product.kind) {
    case 'bin':
    case 'binWithInsert':
      return {
        stl: 'One mesh, label merged into the bin.',
        threeMfTitle: '3MF, two filaments',
        threeMf: 'Body and label slots for toolchanger printing.',
      };
    case 'insert':
      return {
        stl: 'One mesh, label merged into the insert.',
        threeMfTitle: '3MF, two filaments',
        threeMf: 'Body and label slots for toolchanger printing.',
      };
    case 'baseplate':
      return {
        stl: 'One mesh.',
        threeMfTitle: '3MF',
        threeMf: 'Single filament; a baseplate has no label.',
      };
    case 'clip':
      return {
        stl: 'One mesh.',
        threeMfTitle: '3MF',
        threeMf: 'Single filament; a connection clip has no label.',
      };
    default:
      return assertNever(product);
  }
}
