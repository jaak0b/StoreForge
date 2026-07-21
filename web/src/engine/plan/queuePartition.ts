import type { Group, QueueEntry } from './types';

/**
 * Partitions the flat queue into drawer group sections and loose entries, so
 * the queue can render a header per group with its plate rows indented under
 * it. Pure and framework-agnostic: the queue page and its tests read the same
 * partition rather than each grouping the entries themselves.
 */

/** One group's section of the queue: the group and its still-queued plate entries, in queue order. */
export interface QueueGroupSection {
  group: Group;
  entries: QueueEntry[];
}

/** The whole queue split into group sections and the loose entries below them. */
export interface QueuePartition {
  /** One section per group, in the groups' own order; a group with no queued plate has an empty entries list. */
  groups: QueueGroupSection[];
  /** Every entry not belonging to a resolvable group, in their original queue order. */
  loose: QueueEntry[];
}

/**
 * Splits entries into group sections and loose entries. An entry belongs to a
 * group when it is a baseplate carrying a group link whose group still exists;
 * a link to a group that is gone renders the entry loose, matching the plan's
 * load-time repair. Every group gets a section even when it has no queued plate
 * left (all of them batched or printed), so its header still opens the drawer
 * view.
 */
export function partitionQueue(entries: QueueEntry[], groups: Group[]): QueuePartition {
  const sections = new Map<string, QueueGroupSection>();
  for (const group of groups) sections.set(group.id, { group, entries: [] });
  const loose: QueueEntry[] = [];
  for (const entry of entries) {
    const product = entry.product;
    const section =
      product.kind === 'baseplate' && product.group !== undefined
        ? sections.get(product.group.groupId)
        : undefined;
    if (section !== undefined) section.entries.push(entry);
    else loose.push(entry);
  }
  return { groups: [...sections.values()], loose };
}
