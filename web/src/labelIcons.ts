import { LABEL_ICONS, type LabelIcon } from './engine/label/icons';
import type {
  InsertContentParams,
  InsertParams,
  SlottedBinParams,
} from './engine/gridfinity/types';
import { useCustomIcons } from './stores/customIcons';

/**
 * Single source of label icon resolution for the UI: built-in icons first,
 * then the user's custom icons from the customIcons store. Components render
 * the returned icon's path in its own viewBox; the engine never imports this
 * module (custom paths reach the worker via InsertContentParams.iconPath).
 */

/** Resolve an icon name to its drawable icon, or null when it is unknown. */
export function resolveLabelIcon(name: string): LabelIcon | null {
  const builtin = LABEL_ICONS.find((icon) => icon.name === name);
  if (builtin !== undefined) return builtin;
  const custom = useCustomIcons().iconByName(name);
  if (custom === null) return null;
  return {
    name: custom.name,
    path: custom.path,
    viewBox: custom.viewBox,
    category: 'custom',
  };
}

/**
 * Attach the resolved path for a custom icon so the geometry worker (which
 * cannot reach localStorage) can build it. Built-in names pass through
 * unchanged; an unknown name also passes through, so the worker reports it
 * as an unknown icon instead of failing silently here.
 */
export function withResolvedContent(content: InsertContentParams): InsertContentParams {
  if (content.icon === null) return content;
  if (LABEL_ICONS.some((icon) => icon.name === content.icon)) return content;
  const custom = useCustomIcons().iconByName(content.icon);
  if (custom === null) return content;
  return { ...content, iconPath: custom.path };
}

/**
 * withResolvedContent applied to a bin's paired insert content and its fused
 * label content, when either is set: the single place that resolves custom
 * icon paths for a bin's label, so both the swappable-insert and the fused
 * flows (preview and STL union) reach the worker with the icon path attached.
 */
export function withResolvedBinInsert<T extends SlottedBinParams>(params: T): T {
  let resolved = params;
  if (resolved.insert !== null) {
    resolved = { ...resolved, insert: withResolvedContent(resolved.insert) };
  }
  if (resolved.fusedLabel != null) {
    resolved = { ...resolved, fusedLabel: withResolvedContent(resolved.fusedLabel) };
  }
  return resolved;
}

/** withResolvedContent applied to a standalone insert's content. */
export function withResolvedInsertContent(params: InsertParams): InsertParams {
  return { ...params, content: withResolvedContent(params.content) };
}
