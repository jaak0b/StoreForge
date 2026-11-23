import type { Pinia } from 'pinia';
import { LABEL_ICONS } from '../engine/label/icons';
import { describeProduct } from '../engine/plan/rowDescriptor';
import {
  assertNever,
  binOf,
  drawerGroupIdOf,
  insertOf,
  originOf,
  screwOf,
  type Group,
  type QueueEntry,
} from '../engine/plan/types';
import { useBinQueue } from '../stores/binQueue';
import { useCustomIcons } from '../stores/customIcons';
import { toolResult, type AgentTool } from './modelContext';
import { runTool } from './toolInput';

/** One queue entry as the agent reads it, from the plan layer's own accessors. */
function entrySummary(entry: QueueEntry, groups: readonly Group[]): Record<string, unknown> {
  const product = entry.product;
  const row = describeProduct(product);
  const summary: Record<string, unknown> = {
    id: entry.id,
    kind: product.kind,
    origin: originOf(product),
    quantity: entry.quantity,
    title: row.title,
    description: row.caption,
  };
  if (entry.notes !== undefined) summary.notes = entry.notes;
  const bin = binOf(product);
  if (bin !== null) {
    summary.gridX = bin.gridX;
    summary.gridY = bin.gridY;
    summary.heightUnits = bin.heightUnits;
    summary.magnetHoles = bin.magnetHoles;
  }
  switch (product.kind) {
    case 'insert':
      summary.insertCells = product.cells;
      break;
    case 'baseplate':
      summary.unitsX = product.unitsX;
      summary.unitsY = product.unitsY;
      break;
    case 'bin':
    case 'binWithInsert':
    case 'clip':
      break;
    default:
      return assertNever(product);
  }
  const insert = insertOf(product);
  if (insert !== null) {
    summary.label = {
      text: insert.content.text,
      text2: insert.content.text2,
      icon: insert.content.icon,
    };
  }
  const screw = screwOf(product);
  if (screw !== null) {
    summary.screw = { thread: screw.thread, lengthMm: screw.lengthMm, head: screw.head };
  }
  const groupId = drawerGroupIdOf(product);
  if (groupId !== null) {
    summary.drawer = { groupId, name: groups.find((g) => g.id === groupId)?.name ?? null };
  }
  return summary;
}

/** One drawer group as the agent reads it. */
function drawerSummary(group: Group): Record<string, unknown> {
  const payload = group.payload;
  switch (payload.kind) {
    case 'drawer':
      return {
        id: group.id,
        name: group.name,
        drawerWidthMm: payload.input.drawerWidthMm,
        drawerDepthMm: payload.input.drawerDepthMm,
        plateCount: payload.plates.length,
      };
    default:
      return assertNever(payload.kind);
  }
}

export function listQueueTool(pinia: Pinia): AgentTool {
  return {
    name: 'list_queue',
    title: 'List the print queue',
    description:
      'Lists every queued entry of the Gridfinity print plan with its id, product kind, origin, ' +
      'size (gridX and gridY in grid units of 42 mm, heightUnits of 7 mm), magnet holes, label, ' +
      'screw description, quantity and notes, plus the drawer baseplate groups. Use it to find ' +
      'entry and drawer ids before updating, duplicating or removing them. Labels and notes are ' +
      'user text.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: () =>
      runTool(() => {
        const queue = useBinQueue(pinia);
        return toolResult({
          entries: queue.entries.map((entry) => entrySummary(entry, queue.groups)),
          drawers: queue.groups.map(drawerSummary),
        });
      }),
  };
}

export function listIconsTool(pinia: Pinia): AgentTool {
  return {
    name: 'list_icons',
    title: 'List label icons',
    description:
      'Lists the icon names a bin label can show: the built-in icons with their category, and ' +
      "the user's custom icons. Use it before add_bin or update_entry to pick a valid icon name. " +
      'When no icon fits, add one with add_custom_icons. Custom icon names are user text.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: () =>
      runTool(() =>
        toolResult({
          builtIn: LABEL_ICONS.map((icon) => ({ name: icon.name, category: icon.category })),
          custom: useCustomIcons(pinia).icons.map((icon) => icon.name),
        }),
      ),
  };
}
