import type { DrawerPlateOptions } from '../plan/types';
import type { BaseplateMagnets } from './constants';

/** Whether an optional hole feature is stamped into every cell or absent. */
export type HoleMode = 'none' | 'full';

/** Every hole mode, in the order a form offers them. */
export const HOLE_MODES: readonly HoleMode[] = ['none', 'full'];

/** The hole mode a new baseplate form starts with, for both magnets and screw holes. */
export const HOLE_MODE_DEFAULT: HoleMode = 'none';

/**
 * Whether a new drawer fill starts connectable. Filling a drawer wall to wall
 * is exactly the case connecting plates is for, so a new drawer starts
 * connectable (the single-plate designer keeps its own separate default).
 */
export const DRAWER_CONNECTABLE_DEFAULT = true;

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
