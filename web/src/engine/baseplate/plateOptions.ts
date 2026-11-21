import type { DrawerPlateOptions } from '../plan/types';
import type { BaseplateMagnets } from './constants';

/** Whether an optional hole feature is stamped into every cell or absent. */
export type HoleMode = 'none' | 'full';

/**
 * The stored magnet dimensions for a magnet mode: the single magnet-mode
 * collapse. Mode none means null magnets, so dimensions the user typed and then
 * toggled off are never stored.
 */
export function magnetsForMode(
  mode: HoleMode,
  diameterMm: number,
  heightMm: number,
): BaseplateMagnets | null {
  return mode === 'full' ? { diameterMm, heightMm } : null;
}

/** The raw baseplate option fields a form collects for a drawer fill. */
export interface DrawerPlateOptionFields {
  magnetMode: HoleMode;
  magnetDiameterMm: number;
  magnetHeightMm: number;
  screwHoleMode: HoleMode;
  connectable: boolean;
}

/** The drawer plate options the form fields describe, with the magnet collapse applied. */
export function drawerPlateOptionsFromFields(fields: DrawerPlateOptionFields): DrawerPlateOptions {
  return {
    magnets: magnetsForMode(fields.magnetMode, fields.magnetDiameterMm, fields.magnetHeightMm),
    screwHoles: fields.screwHoleMode === 'full',
    connectable: fields.connectable,
  };
}
