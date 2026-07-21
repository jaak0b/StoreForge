import { describe, expect, it } from 'vitest';
import { groupDrawerFillPlanRows } from '../../src/engine/baseplate/drawerFillPlan';
import type { DrawerFillPlate } from '../../src/engine/baseplate/drawerFill';

const ZERO = { leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 };

function plate(over: Partial<DrawerFillPlate>): DrawerFillPlate {
  return { unitsX: 2, unitsY: 2, brim: { ...ZERO }, column: 0, row: 0, ...over };
}

describe('groupDrawerFillPlanRows', () => {
  it('collapses identical plates into one row with a count', () => {
    const rows = groupDrawerFillPlanRows([
      plate({ column: 0, row: 0 }),
      plate({ column: 1, row: 0 }),
      plate({ column: 2, row: 0 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].plates).toHaveLength(3);
    expect(rows[0].unitsLabel).toBe('2×2');
  });

  it('separates plates that differ in units or brim', () => {
    const rows = groupDrawerFillPlanRows([
      plate({ unitsX: 3, column: 0 }),
      plate({ unitsX: 2, column: 1 }),
      plate({ unitsX: 2, column: 2, brim: { ...ZERO, rightMm: 5 } }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it('formats the outer size in mm and the brim by side, zero sides omitted', () => {
    const rows = groupDrawerFillPlanRows([
      plate({ unitsX: 2, unitsY: 2, brim: { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6 } }),
    ]);
    // 2 cells × 42 mm pitch = 84 mm, plus 4 mm left brim on width and 6 mm back on depth.
    expect(rows[0].outerLabel).toBe('88.0 × 90.0');
    expect(rows[0].brimLabel).toBe('L 4.0, B 6.0');
  });

  it('leaves the brim label empty for a plate with no brim', () => {
    const rows = groupDrawerFillPlanRows([plate({})]);
    expect(rows[0].brimLabel).toBe('');
  });
});
