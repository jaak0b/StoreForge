import { describe, expect, it } from 'vitest';
import { evenSplit, planDrawerFill } from '../../src/engine/baseplate/drawerFill';
import { PITCH } from '../../src/engine/gridfinity/constants';
import { BASEPLATE_UNITS_MAX } from '../../src/engine/baseplate/constants';

describe('evenSplit', () => {
  it('splits evenly when the count divides exactly', () => {
    expect(evenSplit(10, 2)).toEqual([5, 5]);
  });

  it('gives the remainder to the first groups', () => {
    expect(evenSplit(11, 2)).toEqual([6, 5]);
    expect(evenSplit(11, 3)).toEqual([4, 4, 3]);
  });

  it('splits into a single group unchanged', () => {
    expect(evenSplit(7, 1)).toEqual([7]);
  });
});

describe('planDrawerFill', () => {
  it('fits an 11x7-cell drawer on a single plate when it is big enough', () => {
    // drawer 11 cells x 7 cells with an 8 mm and 6 mm leftover: 11*42+8=470, 7*42+6=300.
    const result = planDrawerFill({
      drawerWidthMm: 470,
      drawerDepthMm: 300,
      plateWidthMm: 470,
      plateDepthMm: 300,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.plates).toEqual([
      {
        unitsX: 11,
        unitsY: 7,
        brim: { leftMm: 4, rightMm: 4, frontMm: 0, backMm: 6 },
        column: 0,
        row: 0,
      },
    ]);
  });

  it('splits the same drawer across two columns when the plate is narrower, 6+5 near-even', () => {
    const result = planDrawerFill({
      drawerWidthMm: 470, // 11 cells, 8 mm leftover, 4 mm per side
      drawerDepthMm: 300, // 7 cells, 6 mm leftover, all on the back
      plateWidthMm: 260,
      plateDepthMm: 300,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.plates).toHaveLength(2);
    const left = result.plates.find((p) => p.column === 0)!;
    const right = result.plates.find((p) => p.column === 1)!;
    expect(left.unitsX).toBe(6);
    expect(right.unitsX).toBe(5);
    expect(left.brim).toEqual({ leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6 });
    expect(right.brim).toEqual({ leftMm: 0, rightMm: 4, frontMm: 0, backMm: 6 });
    // Both columns still span the whole single row, so unitsY and the row's
    // backMm agree on every plate.
    expect(left.unitsY).toBe(7);
    expect(right.unitsY).toBe(7);
  });

  it('places brim only on the outer edges of a 2x2 plate grid', () => {
    // 11x11 cells: 11 columns worth of 6 mm leftover (3 mm/side), and rows
    // split the same way in Y so a back row and a front row both exist.
    // drawerWidthMm = 11*42+6=468, drawerDepthMm = 11*42+6=468.
    const result = planDrawerFill({
      drawerWidthMm: 468,
      drawerDepthMm: 468,
      plateWidthMm: 260, // forces 2 columns (6+5)
      plateDepthMm: 260, // forces 2 rows (6+5)
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.plates).toHaveLength(4);
    const at = (column: number, row: number) =>
      result.plates.find((p) => p.column === column && p.row === row)!;
    // Front-left: left brim, no back brim (row 0 is the front row).
    expect(at(0, 0).brim).toEqual({ leftMm: 3, rightMm: 0, frontMm: 0, backMm: 0 });
    // Back-right: right brim and back brim together.
    expect(at(1, 1).brim).toEqual({ leftMm: 0, rightMm: 3, frontMm: 0, backMm: 6 });
    // Front-right: right brim only.
    expect(at(1, 0).brim).toEqual({ leftMm: 0, rightMm: 3, frontMm: 0, backMm: 0 });
    // Back-left: left brim and back brim.
    expect(at(0, 1).brim).toEqual({ leftMm: 3, rightMm: 0, frontMm: 0, backMm: 6 });
  });

  it('rejects a drawer smaller than one grid cell in either axis', () => {
    const result = planDrawerFill({
      drawerWidthMm: 40,
      drawerDepthMm: 200,
      plateWidthMm: 300,
      plateDepthMm: 300,
    });
    expect(result).toEqual({
      error: `The drawer must be at least ${PITCH} mm in both width and depth to fit one grid cell.`,
    });
  });

  it('rejects a build plate smaller than one grid cell', () => {
    const result = planDrawerFill({
      drawerWidthMm: 200,
      drawerDepthMm: 200,
      plateWidthMm: 40,
      plateDepthMm: 300,
    });
    expect(result).toEqual({
      error: `The printer's build plate must be at least ${PITCH} mm in both width and depth to fit one grid cell.`,
    });
  });

  it('rejects a build plate that fits one cell but never fits a cell plus the required brim', () => {
    // 5 cells with a 41 mm leftover (20.5 mm/side); a 42 mm plate never fits
    // a 1-unit edge column plus 20.5 mm of brim, however many columns it is
    // split into, because the brim does not shrink with the split.
    const result = planDrawerFill({
      drawerWidthMm: 5 * PITCH + 41,
      drawerDepthMm: 200,
      plateWidthMm: PITCH,
      plateDepthMm: 300,
    });
    expect(result).toEqual({
      error:
        "The printer's build plate is too small to fit a full grid cell plus this drawer's leftover width (41.0 mm split across the left and right edges). Use a larger build plate width.",
    });
  });

  it('caps every plate at BASEPLATE_UNITS_MAX units even when the mm span fits the build plate', () => {
    // 21 cells per axis (21*42 = 882 mm) on a huge build plate: without the
    // cap this would plan a single 21-unit plate the stored format rejects.
    const result = planDrawerFill({
      drawerWidthMm: 21 * PITCH,
      drawerDepthMm: 21 * PITCH,
      plateWidthMm: 1000,
      plateDepthMm: 1000,
    });
    if ('error' in result) throw new Error(result.error);
    // Each axis splits 21 -> 11 + 10, the near-even split, giving 4 plates.
    expect(result.plates).toHaveLength(4);
    for (const plate of result.plates) {
      expect(plate.unitsX).toBeLessThanOrEqual(BASEPLATE_UNITS_MAX);
      expect(plate.unitsY).toBeLessThanOrEqual(BASEPLATE_UNITS_MAX);
    }
    const at = (column: number, row: number) =>
      result.plates.find((p) => p.column === column && p.row === row)!;
    expect(at(0, 0).unitsX).toBe(11);
    expect(at(1, 0).unitsX).toBe(10);
    expect(at(0, 0).unitsY).toBe(11);
    expect(at(0, 1).unitsY).toBe(10);
  });

  it.each([
    [{ drawerWidthMm: 0 }],
    [{ drawerWidthMm: -100 }],
    [{ drawerWidthMm: NaN }],
    [{ drawerWidthMm: Infinity }],
  ])('rejects a nonpositive or non-finite input %j', (overrides) => {
    const result = planDrawerFill({
      drawerWidthMm: 300,
      drawerDepthMm: 300,
      plateWidthMm: 300,
      plateDepthMm: 300,
      ...overrides,
    });
    expect('error' in result).toBe(true);
  });
});
