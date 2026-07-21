import { baseplateOuterMm } from './generator';
import type { BaseplateBrim } from './constants';
import type { DrawerFillPlate } from './drawerFill';

/**
 * Presentation helpers for the drawer-fill plan table: identical plates group
 * into one row with a count, and each column's cell renders from the plate's
 * own fields (unit counts, outer mm from baseplateOuterMm, brim by side). Pure
 * and framework-agnostic, so the Baseplate tab's plan table and its tests read
 * the same rows and strings rather than each composing their own.
 */

/** One plan-table row: a run of identical plates, the count, and the plates themselves. */
export interface DrawerFillPlanRow {
  /** How many plates this row stands for. */
  count: number;
  /** Grid unit counts, like "2×2". */
  unitsLabel: string;
  /** Outer size in mm, like "97.0 × 90.0". */
  outerLabel: string;
  /** Brim by side, compact, zero sides omitted; empty when the plate has no brim. */
  brimLabel: string;
  /**
   * The member plates, so a hovered row can highlight exactly its plates in the
   * top-down preview by their column and row.
   */
  plates: DrawerFillPlate[];
}

/** Whether two brims match on all four sides. */
function sameBrim(a: BaseplateBrim, b: BaseplateBrim): boolean {
  return a.leftMm === b.leftMm && a.rightMm === b.rightMm && a.frontMm === b.frontMm && a.backMm === b.backMm;
}

/** The grid unit counts of a plate, like "2×2". */
function unitsLabel(plate: DrawerFillPlate): string {
  return `${plate.unitsX}×${plate.unitsY}`;
}

/** A plate's outer size in mm, like "97.0 × 90.0", from the single outer-size source. */
function outerLabel(plate: DrawerFillPlate): string {
  const outer = baseplateOuterMm({ unitsX: plate.unitsX, unitsY: plate.unitsY, brim: plate.brim });
  return `${outer.widthMm.toFixed(1)} × ${outer.depthMm.toFixed(1)}`;
}

/** The brimmed sides of a plate, compact and zero sides omitted; empty for no brim. */
function brimLabel(plate: DrawerFillPlate): string {
  const sides: string[] = [];
  if (plate.brim.leftMm > 0) sides.push(`L ${plate.brim.leftMm.toFixed(1)}`);
  if (plate.brim.rightMm > 0) sides.push(`R ${plate.brim.rightMm.toFixed(1)}`);
  if (plate.brim.frontMm > 0) sides.push(`F ${plate.brim.frontMm.toFixed(1)}`);
  if (plate.brim.backMm > 0) sides.push(`B ${plate.brim.backMm.toFixed(1)}`);
  return sides.join(', ');
}

/**
 * Groups a planned plate grid into plan-table rows: plates with the same unit
 * counts and the same brim on all four sides collapse into one row with a
 * count, in first-seen order. Presentation only; the plates queued are still
 * the planner's own, one product per plate.
 */
export function groupDrawerFillPlanRows(plates: DrawerFillPlate[]): DrawerFillPlanRow[] {
  const rows: DrawerFillPlanRow[] = [];
  for (const plate of plates) {
    const match = rows.find(
      (row) =>
        row.plates[0].unitsX === plate.unitsX &&
        row.plates[0].unitsY === plate.unitsY &&
        sameBrim(row.plates[0].brim, plate.brim),
    );
    if (match !== undefined) {
      match.count += 1;
      match.plates.push(plate);
    } else {
      rows.push({
        count: 1,
        unitsLabel: unitsLabel(plate),
        outerLabel: outerLabel(plate),
        brimLabel: brimLabel(plate),
        plates: [plate],
      });
    }
  }
  return rows;
}
