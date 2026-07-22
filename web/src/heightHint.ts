import { HEIGHT_UNIT } from './engine/gridfinity/constants';

/**
 * The overall printed height of a bin in mm, derived from its height units
 * (never a hardcoded 7). Formatted with up to one decimal and a trimmed
 * trailing ".0". Returns null when the height is not a finite number, so a
 * caller can hide the readout while the field is empty or mid-edit.
 */
export function overallHeightMm(heightUnits: number): string | null {
  if (!Number.isFinite(heightUnits)) return null;
  return (heightUnits * HEIGHT_UNIT).toFixed(1).replace(/\.0$/, '');
}
