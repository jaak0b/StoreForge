import { LABEL_ICONS, type LabelIcon } from './engine/label/icons';
import type { LabeledBinParams } from './engine/gridfinity/types';
import { useCustomIcons } from './stores/customIcons';

/**
 * Single source of label icon resolution for the UI: built-in icons first,
 * then the user's custom icons from the customIcons store. Components render
 * the returned icon's path in its own viewBox; the engine never imports this
 * module (custom paths reach the worker via LabeledBinParams.labelIconPath).
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
 * Attach the resolved path for a custom labelIcon so the geometry worker
 * (which cannot reach localStorage) can build it. Built-in names pass
 * through unchanged; an unknown name also passes through, so the worker
 * reports it as an unknown icon instead of failing silently here.
 */
export function withResolvedIconPath(params: LabeledBinParams): LabeledBinParams {
  if (params.labelIcon === null) return params;
  if (LABEL_ICONS.some((icon) => icon.name === params.labelIcon)) return params;
  const custom = useCustomIcons().iconByName(params.labelIcon);
  if (custom === null) return params;
  return { ...params, labelIconPath: custom.path };
}
