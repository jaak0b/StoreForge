# Drawer Fill Baseplates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a drawer's mm size and a printer's build plate mm size, compute a wall-to-wall set of Gridfinity baseplates (edge plates carrying a brimmed, partially socketed extension) and queue them.

**Architecture:** A pure planner module (`drawerFill.ts`) turns four mm inputs into a grid of `{unitsX, unitsY, brim}` plate descriptions using only floor/division on the existing `PITCH` constant. The generator (`generator.ts`) gains an optional `brim` on `BaseplateParams`: the outer outline and its inset clipper grow asymmetrically by the brim, an extra row/column of socket cells is added on each brimmed side and naturally clipped by the existing outline/clipper intersection, and connector slots are suppressed on brimmed edges. The plan model, plan file version, row caption and UI wire the new field through the single existing paths (`baseplateParamsOf`, `baseplateSpanMm`'s new sibling `baseplateOuterMm`) rather than duplicating any of them.

**Tech Stack:** Vue 3 + TypeScript + Vite + Vuetify + Pinia, manifold-3d (WASM CSG) in a Web Worker, Vitest.

## Global Constraints

- Never use the em-dash character, and never a hyphen as its substitute, anywhere in code, comments, commit messages or this plan's own prose.
- UI text is complete grammatical sentences in the 3D printing community's own terms (build plate, filament, stacking lip); diagnostic readouts are labeled raw-value rows, not prose.
- Geometry constants come only from the published spec or an existing named constant (`PITCH`, `OUTER_CORNER_RADIUS`, etc.); no hand-tuned fudge factor. The planner's only math is floor/division on `PITCH`.
- No silently swallowed errors: `planDrawerFill` returns a user-worded `{ error: string }`, never throws for a user-fixable input.
- The engine (`web/src/engine/**`) never imports Vue, Pinia, or touches the DOM.
- Every derived figure has one source: `baseplateSpanMm` for the full-cell span, the new `baseplateOuterMm` for outer size including brim; `binDownloads.ts` and `rowDescriptor.ts` call these, never recompute.
- Every switch over `Product.kind`, `Bin.origin`, or any other discriminated union ends in `assertNever`; no trailing `if`/`else` that assumes what's left.
- `npm run build` and `npm test` (run inside `web/`) stay green; the baseplate geometry test suite must stay meaningful, not just passing.

---

### Task 1: Drawer fill planner (pure math)

**Files:**
- Create: `web/src/engine/baseplate/drawerFill.ts`
- Test: `web/tests/baseplate/drawerFill.spec.ts`

**Interfaces:**
- Consumes: `PITCH` from `web/src/engine/gridfinity/constants.ts` (value `42.0`).
- Produces:
  ```ts
  export interface DrawerFillInput {
    drawerWidthMm: number;
    drawerDepthMm: number;
    plateWidthMm: number;
    plateDepthMm: number;
  }
  export interface DrawerFillBrim {
    leftMm: number;
    rightMm: number;
    frontMm: number;
    backMm: number;
  }
  export interface DrawerFillPlate {
    unitsX: number;
    unitsY: number;
    brim: DrawerFillBrim;
    column: number; // 0-based, 0 = leftmost
    row: number;    // 0-based, 0 = front-most (nearest the drawer opening)
  }
  export type DrawerFillOutcome = { plates: DrawerFillPlate[] } | { error: string };
  export function evenSplit(total: number, count: number): number[];
  export function planDrawerFill(input: DrawerFillInput): DrawerFillOutcome;
  ```
  Task 3 imports `DrawerFillBrim`'s shape (structurally, as `BaseplateBrim` from `baseplate/constants.ts`, defined in Task 2) and Task 4's UI imports `planDrawerFill` and both interfaces directly from this file.

**Convention fixed here for every later task:** edges are named left/right/front/back with front the drawer opening (near edge, `-Y`), back the far wall (`+Y`), left `-X`, right `+X`. Row 0 is the front-most row; column 0 is the leftmost column. The back-most row (`row === rows.length - 1`) carries the full Y leftover as `backMm`; the leftmost and rightmost columns each carry half the X leftover as `leftMm`/`rightMm`; `frontMm` is always `0`.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/baseplate/drawerFill.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evenSplit, planDrawerFill } from '../../src/engine/baseplate/drawerFill';
import { PITCH } from '../../src/engine/gridfinity/constants';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (inside `web/`): `npm test -- baseplate/drawerFill.spec.ts`
Expected: FAIL with "Cannot find module '../../src/engine/baseplate/drawerFill'" (the file does not exist yet).

- [ ] **Step 3: Implement the planner**

Create `web/src/engine/baseplate/drawerFill.ts`:

```ts
import { PITCH } from '../gridfinity/constants';

/**
 * Pure math turning a drawer's mm size and a printer's build plate mm size
 * into a grid of Gridfinity baseplates that fill the drawer wall to wall,
 * each fitting the build plate. Framework-agnostic: no manifold, no Vue.
 */

/** The four raw mm inputs the drawer-fill form collects. */
export interface DrawerFillInput {
  drawerWidthMm: number;
  drawerDepthMm: number;
  plateWidthMm: number;
  plateDepthMm: number;
}

/** Brim extension per edge, in mm, matching BaseplateParams['brim'] in baseplate/constants.ts. */
export interface DrawerFillBrim {
  leftMm: number;
  rightMm: number;
  frontMm: number;
  backMm: number;
}

/**
 * One planned plate. column and row are 0-based grid positions for preview
 * and labeling: column 0 is leftmost, row 0 is front-most (the edge nearest
 * the drawer opening). The back-most row carries backMm; the leftmost and
 * rightmost columns carry leftMm/rightMm; frontMm is always 0, because the
 * front edge never gets a brim by design.
 */
export interface DrawerFillPlate {
  unitsX: number;
  unitsY: number;
  brim: DrawerFillBrim;
  column: number;
  row: number;
}

/** The planner's result: a plate grid, or a user-worded reason it could not plan one. */
export type DrawerFillOutcome = { plates: DrawerFillPlate[] } | { error: string };

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Splits `total` whole units into `count` groups as evenly as possible: the
 * first `total % count` groups get one extra unit. Exported so the UI and
 * tests can reason about the same split the planner uses; the only place
 * "as evenly as possible" is defined.
 */
export function evenSplit(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total % count;
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(base + (i < remainder ? 1 : 0));
  return sizes;
}

/** One axis's split: how many units each of its plates gets, fewest plates first. */
interface AxisPlan {
  sizes: number[];
}

/**
 * Finds the fewest groups `totalUnits` can be split into along one axis so
 * that every group's outer size (its units times PITCH, plus its brim where
 * it sits on the low or high edge) fits `buildDimMm`. Tries 1 group, then 2,
 * and so on, each time splitting as evenly as possible (evenSplit), because
 * an uneven split never fits when the even one does not: the even split
 * minimizes the largest group. Returns null when no group count up to
 * totalUnits succeeds, meaning the low or high edge's brim alone is
 * incompatible with buildDimMm (the brim does not shrink as the split grows).
 */
function planAxis(
  totalUnits: number,
  buildDimMm: number,
  lowBrimMm: number,
  highBrimMm: number,
): AxisPlan | null {
  for (let count = 1; count <= totalUnits; count++) {
    const sizes = evenSplit(totalUnits, count);
    let fits = true;
    for (let i = 0; i < count; i++) {
      const isLow = i === 0;
      const isHigh = i === count - 1;
      const outerMm = sizes[i] * PITCH + (isLow ? lowBrimMm : 0) + (isHigh ? highBrimMm : 0);
      if (outerMm > buildDimMm) {
        fits = false;
        break;
      }
    }
    if (fits) return { sizes };
  }
  return null;
}

/**
 * Plans a wall-to-wall set of baseplates for a drawer. Whole 42 mm cells
 * are floored per axis; the leftover width splits evenly onto the left and
 * right edges, the leftover depth lands entirely on the back edge, and the
 * front edge never gets a brim. Each axis is then split into the fewest
 * plates whose outer size (including brim on the outer edges only) fits the
 * build plate, as evenly as possible. Returns a user-worded error, never
 * throws, when the drawer or the build plate is too small.
 */
export function planDrawerFill(input: DrawerFillInput): DrawerFillOutcome {
  const { drawerWidthMm, drawerDepthMm, plateWidthMm, plateDepthMm } = input;
  for (const [name, value] of [
    ['drawer width', drawerWidthMm],
    ['drawer depth', drawerDepthMm],
    ['build plate width', plateWidthMm],
    ['build plate depth', plateDepthMm],
  ] as const) {
    if (!isPositiveFinite(value)) {
      return { error: `The ${name} must be a positive number of millimetres.` };
    }
  }
  if (drawerWidthMm < PITCH || drawerDepthMm < PITCH) {
    return {
      error: `The drawer must be at least ${PITCH} mm in both width and depth to fit one grid cell.`,
    };
  }
  if (plateWidthMm < PITCH || plateDepthMm < PITCH) {
    return {
      error: `The printer's build plate must be at least ${PITCH} mm in both width and depth to fit one grid cell.`,
    };
  }

  const totalUnitsX = Math.floor(drawerWidthMm / PITCH);
  const leftoverX = drawerWidthMm - totalUnitsX * PITCH;
  const totalUnitsY = Math.floor(drawerDepthMm / PITCH);
  const leftoverY = drawerDepthMm - totalUnitsY * PITCH;

  const leftMm = leftoverX / 2;
  const rightMm = leftoverX / 2;
  const backMm = leftoverY;

  const colPlan = planAxis(totalUnitsX, plateWidthMm, leftMm, rightMm);
  if (colPlan === null) {
    return {
      error:
        "The printer's build plate is too small to fit a full grid cell plus this drawer's " +
        `leftover width (${leftoverX.toFixed(1)} mm split across the left and right edges). ` +
        'Use a larger build plate width.',
    };
  }
  const rowPlan = planAxis(totalUnitsY, plateDepthMm, 0, backMm);
  if (rowPlan === null) {
    return {
      error:
        "The printer's build plate is too small to fit a full grid cell plus this drawer's " +
        `leftover depth (${leftoverY.toFixed(1)} mm on the back edge). ` +
        'Use a larger build plate depth.',
    };
  }

  const plates: DrawerFillPlate[] = [];
  for (let row = 0; row < rowPlan.sizes.length; row++) {
    for (let column = 0; column < colPlan.sizes.length; column++) {
      plates.push({
        unitsX: colPlan.sizes[column],
        unitsY: rowPlan.sizes[row],
        brim: {
          leftMm: column === 0 ? leftMm : 0,
          rightMm: column === colPlan.sizes.length - 1 ? rightMm : 0,
          frontMm: 0,
          backMm: row === rowPlan.sizes.length - 1 ? backMm : 0,
        },
        column,
        row,
      });
    }
  }
  return { plates };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- baseplate/drawerFill.spec.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/baseplate/drawerFill.ts web/tests/baseplate/drawerFill.spec.ts
git commit -m "Add the pure drawer-fill baseplate planner."
```

---

### Task 2: Generator brim support and the single-source outer-size function

**Files:**
- Modify: `web/src/engine/baseplate/constants.ts` (add `BaseplateBrim`, extend `BaseplateParams`)
- Modify: `web/src/engine/baseplate/generator.ts` (brim-aware outline/clipper/cavity/slots, new `baseplateOuterMm`)
- Modify: `web/src/binDownloads.ts:156-160` (`partFootprint`'s baseplate case)
- Test: `web/tests/baseplate.spec.ts` (extend)

**Interfaces:**
- Consumes: `PITCH`, `OUTER_CORNER_RADIUS` from `gridfinity/constants.ts`; `loftChain`, `roundedRectPolygon` from `gridfinity/shapes.ts`; `baseplateSpanMm` (already in `generator.ts`).
- Produces:
  ```ts
  // constants.ts
  export interface BaseplateBrim {
    leftMm: number;
    rightMm: number;
    frontMm: number;
    backMm: number;
  }
  export interface BaseplateParams {
    unitsX: number;
    unitsY: number;
    pitchMm?: number;
    magnets: BaseplateMagnets | null;
    screwHoles: boolean;
    connectable: boolean;
    brim?: BaseplateBrim; // NEW, all four sides >= 0 and < pitchMm; absent means all zero.
  }
  // generator.ts
  export function baseplateOuterMm(
    params: Pick<BaseplateParams, 'unitsX' | 'unitsY' | 'pitchMm' | 'brim'>,
  ): { widthMm: number; depthMm: number };
  ```
  Task 3's `baseplateParamsOf` produces the `brim` field this consumes; Task 3's `rowDescriptor.ts` and Task 4's `binDownloads.ts` call `baseplateOuterMm`.

- [ ] **Step 1: Write the failing tests**

Append to `web/tests/baseplate.spec.ts` (add the import and the new `describe` block; keep every existing test as-is):

```ts
// Add to the existing import from '../src/engine/baseplate/generator':
import {
  baseplateOuterMm,
  baseplateRiserMm,
  baseplateSpanMm,
  clipFootprintMm,
  generateBaseplate,
  generateConnectionClip,
} from '../src/engine/baseplate/generator';
```

Then append at the end of the file, after the `describe('clip assembly', ...)` block:

```ts
describe('generateBaseplate with a brim', () => {
  function brimParams(overrides: Partial<BaseplateParams> = {}): BaseplateParams {
    return params({
      unitsX: 2,
      unitsY: 2,
      brim: { leftMm: 10, rightMm: 0, frontMm: 0, backMm: 15 },
      ...overrides,
    });
  }

  it('is watertight with a brim on two adjacent edges', () => {
    const plate = generateBaseplate(m, brimParams());
    expect(plate.status()).toBe('NoError');
    expect(plate.isEmpty()).toBe(false);
    plate.delete();
  });

  it('grows the bounding box by exactly the brim on the brimmed sides only', () => {
    const plate = generateBaseplate(m, brimParams());
    const box = plate.boundingBox();
    // Full-cell span is 2 * PITCH = 84 on each axis. Left brim 10, right 0:
    // total X span 94, offset so the right face stays at the un-brimmed edge.
    expect(box.max[0] - box.min[0]).toBeCloseTo(2 * PITCH + 10, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(2 * PITCH + 15, 6);
    // The un-brimmed right (+X) face sits exactly at the full-cell edge, PITCH.
    expect(box.max[0]).toBeCloseTo(PITCH, 6);
    // The un-brimmed front (-Y) face sits exactly at the full-cell edge, -PITCH.
    expect(box.min[1]).toBeCloseTo(-PITCH, 6);
    plate.delete();
  });

  it('matches baseplateOuterMm exactly', () => {
    const plate = generateBaseplate(m, brimParams());
    const box = plate.boundingBox();
    const outer = baseplateOuterMm(brimParams());
    expect(box.max[0] - box.min[0]).toBeCloseTo(outer.widthMm, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(outer.depthMm, 6);
    plate.delete();
  });

  it('opens a partial socket cavity in the brim, beyond the full-cell edge', () => {
    // The left brim is 10 mm; a probe centred 5 mm past the left full-cell
    // edge (x = -PITCH - 5), inside the brimmed extra cell's z band, must be
    // open cavity, matching the measured cavity width test's z = halfDz band.
    const plate = generateBaseplate(m, brimParams());
    const probe = m.Manifold.cube([2, 4, 0.05], true).translate(-PITCH - 5, -PITCH / 2, 0.0005);
    const hit = plate.intersect(probe);
    expect(Math.abs(hit.volume())).toBeLessThan(1e-6);
    hit.delete();
    plate.delete();
  });

  it('keeps genus equal to the full-cell count only; brim cells open to the edge, not a handle', () => {
    const plate = generateBaseplate(m, brimParams());
    // Same reasoning as the plain-plate genus test: each FULL cell is one
    // through-hole handle. A brim cell's cavity is clipped open to the outer
    // edge (it is a notch into the boundary, not a closed tunnel), so it
    // contributes zero extra genus regardless of how many brimmed sides exist.
    expect(plate.genus()).toBe(2 * 2);
    plate.delete();
  });

  it('omits connector slots on brimmed edges but keeps them on plain edges', () => {
    const connectableBrim = generateBaseplate(
      m,
      brimParams({ unitsX: 1, unitsY: 1, connectable: true }),
    );
    // Left edge (brimmed, leftMm 10): the slot cutter for -X would sit at
    // x = -width/2 = -21; with a 10 mm brim material still fills where the
    // plain-edge test (4.12/10) probes the +X (right, un-brimmed) edge.
    const rightProbe = () =>
      m.Manifold.cube([1, 1.9, 0.3], true).translate(21, 0, 2.25);
    const rightHit = connectableBrim.intersect(rightProbe());
    expect(Math.abs(rightHit.volume())).toBeLessThan(1e-9); // right edge: no brim, slot present
    rightHit.delete();
    const backProbe = () =>
      m.Manifold.cube([1.9, 1, 0.3], true).translate(0, 21, 2.25);
    const backHit = connectableBrim.intersect(backProbe());
    expect(backHit.volume()).toBeCloseTo(1.9 * 1 * 0.3, 3); // back edge: brimmed, slot suppressed
    backHit.delete();
    connectableBrim.delete();
  });

  it('places magnets only at full cells, unaffected by the brim', () => {
    const magnets = { diameterMm: MAGNET_DIAMETER_DEFAULT, heightMm: MAGNET_HEIGHT_DEFAULT };
    const plate = generateBaseplate(
      m,
      brimParams({ unitsX: 1, unitsY: 1, magnets, connectable: false }),
    );
    const riser = baseplateRiserMm(magnets, false);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const pocket = m.Manifold.cylinder(
          magnets.heightMm - 0.2,
          (magnets.diameterMm - 0.2) / 2,
          (magnets.diameterMm - 0.2) / 2,
          16,
        ).translate(sx * 13.0, sy * 13.0, riser - magnets.heightMm + 0.1);
        expect(Math.abs(overlapVolume(plate, pocket))).toBeLessThan(1e-9);
      }
    }
    plate.delete();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- baseplate.spec.ts`
Expected: FAIL. `baseplateOuterMm` is not exported (TypeScript/import error), and `BaseplateParams` has no `brim` field (type error on `brimParams`'s object literal).

- [ ] **Step 3: Implement**

In `web/src/engine/baseplate/constants.ts`, add after the `BaseplateMagnets` interface (currently ending at line 128) and extend `BaseplateParams` (currently lines 130-147):

```ts
/**
 * Brim extension per edge, in mm: the four edge plates of a drawer-filling
 * baseplate grid grow toward the drawer wall by this much, carrying a
 * partial row/column of sockets rather than a solid bar. Each side is
 * always less than one pitch, so a brimmed edge never grows a full extra
 * socket. The planner in drawerFill.ts is the only place that computes these
 * values; the generator only ever consumes them.
 */
export interface BaseplateBrim {
  leftMm: number;
  rightMm: number;
  frontMm: number;
  backMm: number;
}

export interface BaseplateParams {
  /** Cells along X, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsX: number;
  /** Cells along Y, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsY: number;
  /**
   * Grid pitch in mm: centre-to-centre cell spacing and the plate's footprint per cell.
   * Defaults to PITCH, valid 41.5 to 60. Not exposed in the UI; threaded so a control can be
   * added without touching geometry.
   */
  pitchMm?: number;
  /** Magnet pockets in every cell corner, opening into the socket floor, or null for none. */
  magnets: BaseplateMagnets | null;
  /** Through screw holes concentric with the magnet positions. */
  screwHoles: boolean;
  /** Connector slots on all four outer edges, one per cell per edge. */
  connectable: boolean;
  /**
   * Edge extension for filling a drawer wall to wall, or absent for a plain
   * plate (equivalent to all four sides zero). Magnets, screw holes and
   * connector slots apply only to the full unitsX by unitsY cells; a brimmed
   * edge never gets connector slots, since it sits against the drawer wall.
   */
  brim?: BaseplateBrim;
}
```

In `web/src/engine/baseplate/generator.ts`, add the zero-brim default and `baseplateOuterMm` right after `baseplateSpanMm` (currently lines 59-61):

```ts
/** All-zero brim, the implicit value of an absent BaseplateParams.brim. */
const ZERO_BRIM: BaseplateBrim = { leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 };

/**
 * Outer size of a baseplate along both axes, in mm: the full-cell span
 * (baseplateSpanMm) plus its brim on each side. The single source of a
 * brimmed plate's outer size; the generator, the plate arranger's footprint
 * and the drawer-fill UI readout all derive it here, never locally.
 */
export function baseplateOuterMm(
  params: Pick<BaseplateParams, 'unitsX' | 'unitsY' | 'pitchMm' | 'brim'>,
): { widthMm: number; depthMm: number } {
  const pitch = params.pitchMm ?? PITCH;
  const brim = params.brim ?? ZERO_BRIM;
  return {
    widthMm: baseplateSpanMm(params.unitsX, pitch) + brim.leftMm + brim.rightMm,
    depthMm: baseplateSpanMm(params.unitsY, pitch) + brim.frontMm + brim.backMm,
  };
}
```

Add `BaseplateBrim` to the type-only import at the top of `generator.ts` (currently lines 38-42):

```ts
import type {
  BaseplateBrim,
  BaseplateMagnets,
  BaseplateParams,
  ConnectionClipParams,
} from './constants';
```

Now rewrite the body of `generateBaseplate` (currently lines 259-397). Replace the whole function:

```ts
export function generateBaseplate(m: ManifoldToplevel, params: BaseplateParams): Manifold {
  const pitch = params.pitchMm ?? PITCH;
  const width = baseplateSpanMm(params.unitsX, pitch);
  const depth = baseplateSpanMm(params.unitsY, pitch);
  const brim = params.brim ?? ZERO_BRIM;
  const riser = baseplateRiserMm(params.magnets, params.screwHoles);
  const height = riser + BASEPLATE_HEIGHT;
  const sections = socketSections(riser);

  // The outer outline and its inset clipper grow asymmetrically by the
  // brim: the full-cell lattice below stays centred on the origin (full
  // cells never move), so the outline is built at the brimmed outer size
  // and then shifted by half the difference between its two brims per
  // axis, which lands the un-brimmed side back on the full-cell edge.
  const outerWidth = width + brim.leftMm + brim.rightMm;
  const outerDepth = depth + brim.frontMm + brim.backMm;
  const dx = (brim.rightMm - brim.leftMm) / 2;
  const dy = (brim.backMm - brim.frontMm) / 2;

  // Stage 1: the plate outline extruded to full height.
  const plainOutline = m.Manifold.extrude(
    [roundedRectPolygon(outerWidth, outerDepth, OUTER_CORNER_RADIUS)],
    height,
  );
  const outline = plainOutline.translate(dx, dy, 0);
  if (dx !== 0 || dy !== 0) plainOutline.delete();

  // Stage 2: the socket clipper, inset from the outline by the rim at every
  // height, grown and shifted exactly like the outline so a brimmed cell's
  // cavity clips consistently against the wall it actually sits behind.
  const plainClipper = loftChain(m, outerWidth, outerDepth, sections);
  const clipper = plainClipper.translate(dx, dy, 0);
  if (dx !== 0 || dy !== 0) plainClipper.delete();

  // Stage 3: sharp-cornered cell cavities on the pitch lattice. The full
  // unitsX by unitsY cells are always present; one extra column or row is
  // added on each brimmed side (brim is always less than one pitch, so the
  // extra cell always straddles the plate's brimmed edge). That extra cell
  // is a full-size socket cavity, exactly like a full cell; it is clipped
  // down to only its brim-covered portion by the intersection with clipper
  // in stage 4 below, the same mechanism that rounds a corner cavity today.
  const socketTop = BASE_TOP_SIZE + 2 * BASEPLATE_SOCKET_CLEARANCE;
  const cellSolid = loftChain(m, socketTop, socketTop, sections, 0, 0);
  const ixValues: number[] = [];
  if (brim.leftMm > 0) ixValues.push(-1);
  for (let ix = 0; ix < params.unitsX; ix++) ixValues.push(ix);
  if (brim.rightMm > 0) ixValues.push(params.unitsX);
  const iyValues: number[] = [];
  if (brim.frontMm > 0) iyValues.push(-1);
  for (let iy = 0; iy < params.unitsY; iy++) iyValues.push(iy);
  if (brim.backMm > 0) iyValues.push(params.unitsY);
  const cells: Manifold[] = [];
  for (const ix of ixValues) {
    for (const iy of iyValues) {
      cells.push(
        cellSolid.translate(cellCentre(ix, width, pitch), cellCentre(iy, depth, pitch), 0),
      );
    }
  }
  cellSolid.delete();

  // Stage 4: one intersection produces rounded cavity corners at the plate
  // boundary, sharp ones internally, and (new) partial sockets wherever a
  // brim cell's full-size cavity is cut short by the brimmed clipper.
  const cellUnion = m.Manifold.union(cells);
  const cavity = cellUnion.intersect(clipper);
  cellUnion.delete();
  clipper.delete();

  // Stage 5: the plate is the outline minus the cavity. The outline solid
  // stays alive until after the boss-clipping stage below, which reuses it
  // instead of extruding the identical prism a second time.
  let plate = outline.subtract(cavity);
  cavity.delete();

  // Stages 6 to 8: bosses, screw holes and magnet pockets, at every FULL
  // cell's magnet position only. magnetSites already loops params.unitsX by
  // params.unitsY, never the brim cells, so no change is needed here beyond
  // reading the (unmoved) full-cell lattice.
  if (riser > 0) {
    const bossRadius =
      (params.magnets?.diameterMm ?? MAGNET_HOLE_DIAMETER) / 2 + BASEPLATE_BOSS_WALL;
    const sites = magnetSites(params, width, depth, pitch);
    const parts: Manifold[] = [];
    for (const site of sites) parts.push(...bossParts(m, site, bossRadius, riser));
    const bossUnion = m.Manifold.union(parts);
    // Clip to the outline so a boss at a rounded plate corner merges into the
    // wall instead of poking outside the plate.
    const bosses = bossUnion.intersect(outline);
    bossUnion.delete();
    const withBosses = plate.add(bosses);
    plate.delete();
    bosses.delete();
    plate = withBosses;

    if (params.screwHoles) {
      const screws = sites.map((site) =>
        m.Manifold.cylinder(
          riser + 2 * EPS,
          BASEPLATE_SCREW_DIAMETER / 2,
          BASEPLATE_SCREW_DIAMETER / 2,
          4 * CORNER_SEGMENTS,
        ).translate(site.x, site.y, -EPS),
      );
      const screwUnion = m.Manifold.union(screws);
      const drilled = plate.subtract(screwUnion);
      plate.delete();
      screwUnion.delete();
      plate = drilled;
    }

    if (params.magnets !== null) {
      const { diameterMm, heightMm } = params.magnets;
      const pockets = sites.map((site) =>
        m.Manifold.cylinder(
          heightMm + EPS,
          diameterMm / 2,
          diameterMm / 2,
          4 * CORNER_SEGMENTS,
        ).translate(site.x, site.y, riser - heightMm),
      );
      const pocketUnion = m.Manifold.union(pockets);
      const pocketed = plate.subtract(pocketUnion);
      plate.delete();
      pocketUnion.delete();
      plate = pocketed;
    }
  }
  outline.delete();

  // Stage 9: connector slots, one per cell per outer edge, centred on the
  // cell centre, skipped entirely on a brimmed edge (that edge sits against
  // the drawer wall, not against another plate). A slot is emitted only when
  // its full length lies on the straight part of the edge, clear of the
  // corner arcs.
  if (params.connectable) {
    const slotFits = (centre: number, spanMm: number): boolean =>
      Math.abs(centre) + CONNECTOR_SLOT_LENGTH / 2 <= spanMm / 2 - OUTER_CORNER_RADIUS;
    const canonical = slotCutter(m, height);
    const slots: Manifold[] = [];
    for (let ix = 0; ix < params.unitsX; ix++) {
      const cx = cellCentre(ix, width, pitch);
      if (!slotFits(cx, width)) continue;
      if (brim.backMm === 0) slots.push(canonical.translate(cx, depth / 2, 0));
      if (brim.frontMm === 0) {
        slots.push(canonical.rotate(0, 0, 180).translate(cx, -depth / 2, 0));
      }
    }
    for (let iy = 0; iy < params.unitsY; iy++) {
      const cy = cellCentre(iy, depth, pitch);
      if (!slotFits(cy, depth)) continue;
      if (brim.rightMm === 0) {
        slots.push(canonical.rotate(0, 0, -90).translate(width / 2, cy, 0));
      }
      if (brim.leftMm === 0) {
        slots.push(canonical.rotate(0, 0, 90).translate(-width / 2, cy, 0));
      }
    }
    canonical.delete();
    if (slots.length > 0) {
      const slotUnion = m.Manifold.union(slots);
      const slotted = plate.subtract(slotUnion);
      plate.delete();
      slotUnion.delete();
      plate = slotted;
    }
  }

  return plate;
}
```

Note on the `plainOutline`/`plainClipper` delete guards: when `dx === 0 && dy === 0` (the common plain-plate case), `Manifold.translate(0, 0, 0)` in manifold-3d returns the same underlying value in every version this repo has pinned, so deleting both `plainOutline` and `outline` would double-free. Guard exactly as written (skip the delete when the shift is a no-op); this preserves today's zero-brim behaviour and its existing memory-management pattern byte for byte.

In `web/src/binDownloads.ts`, update the import (line 15) and the baseplate case of `partFootprint` (lines 156-160):

```ts
import { baseplateOuterMm, clipFootprintMm } from './engine/baseplate/generator';
```

```ts
    case 'baseplate':
      return baseplateOuterMm(part.baseplate);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- baseplate.spec.ts`
Expected: PASS, including every pre-existing case (unchanged behaviour at brim absent) and the new `describe('generateBaseplate with a brim', ...)` block.

Run: `npm test -- plan/baseplate.spec.ts`
Expected: PASS unchanged (this file's `partFootprint` test compares against `baseplateSpanMm` directly on a brim-less product, which still equals `baseplateOuterMm`'s result).

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/baseplate/constants.ts web/src/engine/baseplate/generator.ts web/src/binDownloads.ts web/tests/baseplate.spec.ts
git commit -m "Add brim support to the baseplate generator."
```

---

### Task 3: Plan model, plan file version 9, row caption

**Files:**
- Modify: `web/src/engine/plan/types.ts` (`BaseplateProduct`, `PlanFile.version`, `PLAN_FILE_VERSION`)
- Modify: `web/src/engine/plan/planFile.ts` (`validateBaseplate`, `pickBaseplate`, version bound message)
- Modify: `web/src/engine/plan/geometry.ts` (`baseplateParamsOf`)
- Modify: `web/src/engine/plan/rowDescriptor.ts` (baseplate caption)
- Test: `web/tests/plan/baseplate.spec.ts` (extend)

**Interfaces:**
- Consumes: `BaseplateBrim` from `web/src/engine/baseplate/constants.ts` (Task 2); `baseplateOuterMm` from `web/src/engine/baseplate/generator.ts` (Task 2); `PITCH` from `gridfinity/constants.ts`.
- Produces: `BaseplateProduct.brim?: BaseplateBrim`; `PLAN_FILE_VERSION = 9`. Task 4's UI builds `BaseplateProduct` objects with this field when queueing drawer-fill plates.

- [ ] **Step 1: Write the failing tests**

Add to `web/tests/plan/baseplate.spec.ts`. First, extend the existing helper (`fullBaseplate`, currently lines 18-28) is left as-is (a brim-less product must keep round-tripping exactly as today); add a new helper and new tests after the existing `describe('baseplate round trip', ...)` block (after line 116):

```ts
/** A baseplate with a brim on two adjacent edges, as a drawer-fill edge plate would carry. */
function brimmedBaseplate(): BaseplateProduct {
  return {
    kind: 'baseplate',
    unitsX: 6,
    unitsY: 7,
    magnets: null,
    screwHoles: false,
    connectable: false,
    brim: { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6 },
  };
}

describe('baseplate brim round trip and validation', () => {
  it('round-trips a brimmed baseplate with its brim intact', () => {
    const back = roundTrip([entry('a1', brimmedBaseplate())]);
    expect(back[0].product).toEqual(brimmedBaseplate());
  });

  it('round-trips a brim-less baseplate with brim staying absent, not zeroed', () => {
    const back = roundTrip([entry('a1', plainBaseplate())]);
    const product = back[0].product;
    if (product.kind !== 'baseplate') throw new Error('expected a baseplate');
    expect(product.brim).toBeUndefined();
    expect(product).toEqual(plainBaseplate());
  });

  it.each([
    [{ brim: 5 }, 'entry a1: brim must be an object'],
    [
      { brim: { leftMm: -1, rightMm: 0, frontMm: 0, backMm: 0 } },
      `entry a1: brim leftMm must be a number from 0 up to (not including) ${42}`,
    ],
    [
      { brim: { leftMm: 42, rightMm: 0, frontMm: 0, backMm: 0 } },
      `entry a1: brim leftMm must be a number from 0 up to (not including) ${42}`,
    ],
    [
      { brim: { leftMm: 0, rightMm: 'x', frontMm: 0, backMm: 0 } },
      `entry a1: brim rightMm must be a number from 0 up to (not including) ${42}`,
    ],
  ])('rejects a brimmed baseplate with %j', (overrides, message) => {
    const bad = entry('a1', { ...brimmedBaseplate(), ...overrides } as unknown as Product);
    expect(validateEntry(bad)).toBe(message);
  });

  it.each([
    [{ leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 }],
    [{ leftMm: 41.9, rightMm: 0, frontMm: 0, backMm: 0 }],
  ])('accepts the inclusive brim boundary %j', (brim) => {
    const good = entry('a1', { ...brimmedBaseplate(), brim } as unknown as Product);
    expect(validateEntry(good)).toBeNull();
  });
});
```

Now confirm the raw expectation strings in `it.each` above will read cleanly once implemented (they interpolate `42` directly since `PITCH === 42`).

Also update the plan-version literal test if one exists: search `web/tests/plan/` for a hardcoded `version: 8`. `web/tests/plan/baseplate.spec.ts` itself uses `version: 8` at line 177 (the "accepts an unknown extra key" test, parsing a raw envelope). That parse targets the CURRENT `PLAN_FILE_VERSION`, so update it to read the constant instead of the literal:

```ts
import { PLAN_FILE_VERSION } from '../../src/engine/plan/types';
```

and change:

```ts
    const result = parsePlanFile(
      JSON.stringify({ version: PLAN_FILE_VERSION, entries: [withExtra], batches: [] }),
    );
    expect(result).toEqual({
      ok: true,
      plan: { version: PLAN_FILE_VERSION, entries: [entry('a1', plainBaseplate())], batches: [] },
      warnings: [],
    });
```

Search the rest of `web/tests/` for other hardcoded `version: 8` or `PlanFile.version` literals with:

```bash
grep -rn "version: 8" web/tests
```

and apply the same `PLAN_FILE_VERSION` substitution to each hit so the suite does not silently pin to the old version number.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- plan/baseplate.spec.ts`
Expected: FAIL. `BaseplateProduct` has no `brim` field (type error on `brimmedBaseplate`), and the validation-message tests fail because `validateBaseplate` does not yet check `raw.brim`.

- [ ] **Step 3: Implement**

In `web/src/engine/plan/types.ts`, update the import (line 5) and `BaseplateProduct` (lines 295-309):

```ts
import type { BaseplateBrim, BaseplateMagnets } from '../baseplate/constants';
```

```ts
export interface BaseplateProduct {
  kind: 'baseplate';
  /** Cells along X, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsX: number;
  /** Cells along Y, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsY: number;
  /**
   * Magnet pocket dimensions, imported from the baseplate module so they
   * travel with their bounds, or null when the plate has none: a plate
   * without magnets carries no dimensions at all rather than dead ones.
   */
  magnets: BaseplateMagnets | null;
  screwHoles: boolean;
  connectable: boolean;
  /**
   * Edge extension for a drawer-fill edge plate, or absent for a plain
   * plate. Absent, not zeroed, so a plan written before drawer fill existed
   * (and every plain plate designed on the Baseplate tab) round-trips with
   * no brim field at all.
   */
  brim?: BaseplateBrim;
}
```

Update the version doc and value (lines 477-493):

```ts
export interface PlanFile {
  /**
   * Envelope format version. Currently 9, which is version 8 plus the
   * baseplate product's optional brim field (drawer-fill edge plates). The
   * change is purely additive: no field of an earlier version changes
   * meaning, so versions 1 to 8 are read exactly as they were before; they
   * simply contain no brimmed baseplate.
   */
  version: 9;
  /** All queue entries. */
  entries: QueueEntry[];
  /** All open print batches. */
  batches: PrintBatch[];
}

/** The current envelope format version. */
export const PLAN_FILE_VERSION = 9;
```

In `web/src/engine/plan/planFile.ts`, add `PITCH` and `BaseplateBrim` to the relevant imports near the top of the file (find the existing import block that pulls in `MAGNET_DIAMETER_MIN` etc. from `../baseplate/constants` and `BASEPLATE_UNITS_MAX`; add alongside it):

```ts
import { PITCH } from '../gridfinity/constants';
import type { BaseplateBrim } from '../baseplate/constants';
```

Add a `validateBrim` function directly above `validateBaseplate` (currently line 815):

```ts
/**
 * Validates a raw value as a baseplate's optional brim field: absent (a
 * plain plate) or an object whose four sides are each a finite number from
 * 0 up to but not including PITCH, matching BaseplateBrim's own contract in
 * baseplate/constants.ts (a brim is always less than one pitch, by
 * construction of the drawer-fill planner).
 */
function validateBrim(raw: unknown, subject: string): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: brim must be an object`;
  }
  const brim = raw as Record<string, unknown>;
  for (const side of ['leftMm', 'rightMm', 'frontMm', 'backMm'] as const) {
    const value = brim[side];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= PITCH) {
      return `${subject}: brim ${side} must be a number from 0 up to (not including) ${PITCH}`;
    }
  }
  return null;
}

/** Copies only the known BaseplateBrim fields from a validated raw value, or undefined for none. */
function pickBrim(raw: unknown): BaseplateBrim | undefined {
  if (raw === undefined) return undefined;
  const brim = raw as Record<string, unknown>;
  return {
    leftMm: brim.leftMm as number,
    rightMm: brim.rightMm as number,
    frontMm: brim.frontMm as number,
    backMm: brim.backMm as number,
  };
}
```

Extend `validateBaseplate` (currently lines 815-831) with the brim check, in the same fixed-order style as the rest of the function:

```ts
function validateBaseplate(raw: Record<string, unknown>, subject: string): string | null {
  if (!isPositiveInteger(raw.unitsX, 1) || raw.unitsX > BASEPLATE_UNITS_MAX) {
    return `${subject}: unitsX must be an integer from 1 to ${BASEPLATE_UNITS_MAX}`;
  }
  if (!isPositiveInteger(raw.unitsY, 1) || raw.unitsY > BASEPLATE_UNITS_MAX) {
    return `${subject}: unitsY must be an integer from 1 to ${BASEPLATE_UNITS_MAX}`;
  }
  const magnetsProblem = validateMagnets(raw.magnets, subject);
  if (magnetsProblem !== null) return magnetsProblem;
  if (typeof raw.screwHoles !== 'boolean') {
    return `${subject}: screwHoles must be true or false`;
  }
  if (typeof raw.connectable !== 'boolean') {
    return `${subject}: connectable must be true or false`;
  }
  const brimProblem = validateBrim(raw.brim, subject);
  if (brimProblem !== null) return brimProblem;
  return null;
}
```

Extend `pickBaseplate` (currently lines 846-855):

```ts
function pickBaseplate(raw: Record<string, unknown>): BaseplateProduct {
  return {
    kind: 'baseplate',
    unitsX: raw.unitsX as number,
    unitsY: raw.unitsY as number,
    magnets: pickMagnets(raw.magnets as Record<string, unknown> | null),
    screwHoles: raw.screwHoles as boolean,
    connectable: raw.connectable as boolean,
    brim: pickBrim(raw.brim),
  };
}
```

`web/src/engine/plan/geometry.ts`'s `baseplateParamsOf` (currently lines 112-120) gains the pass-through:

```ts
export function baseplateParamsOf(product: BaseplateProduct): BaseplateParams {
  return {
    unitsX: product.unitsX,
    unitsY: product.unitsY,
    magnets: product.magnets === null ? null : { ...product.magnets },
    screwHoles: product.screwHoles,
    connectable: product.connectable,
    brim: product.brim === undefined ? undefined : { ...product.brim },
  };
}
```

`web/src/engine/plan/rowDescriptor.ts`: add the import (alongside the existing imports at the top of the file) and rewrite the `'baseplate'` case of `captionOf` (currently lines 131-139):

```ts
import { baseplateOuterMm } from '../baseplate/generator';
```

```ts
    case 'baseplate': {
      // Two dimensions, not three: a baseplate has no height units to state.
      // The brim, when present, is named by the plate's exact outer size in
      // mm (baseplateOuterMm), never recomputed here.
      const outer = product.brim === undefined ? null : baseplateOuterMm(product);
      return joinCaption([
        'baseplate',
        `${product.unitsX}×${product.unitsY}`,
        outer === null ? '' : `${outer.widthMm.toFixed(1)}×${outer.depthMm.toFixed(1)} mm outer`,
        product.magnets !== null ? 'magnets' : '',
        product.screwHoles ? 'screw holes' : '',
        product.connectable ? 'connectable' : '',
      ]);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- plan/baseplate.spec.ts`
Expected: PASS, including the new brim round-trip and validation cases, and the existing suite unaffected by the version bump (it already reads `PLAN_FILE_VERSION` after Step 1's edit).

Run the full plan test directory to catch any other file with a hardcoded `version: 8`:

Run: `npm test -- plan/`
Expected: PASS. If any file still fails on a version-mismatch error message, apply the same `PLAN_FILE_VERSION` substitution found by the `grep` in Step 1 and rerun.

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/plan/types.ts web/src/engine/plan/planFile.ts web/src/engine/plan/geometry.ts web/src/engine/plan/rowDescriptor.ts web/tests/plan/baseplate.spec.ts
git commit -m "Add the baseplate brim field to the plan model at version 9."
```

---

### Task 4: Worker and client passthrough check

**Files:**
- Read only, to confirm: `web/src/worker/geometry.worker.ts:257-265`, `web/src/workerClient.ts:86-89`

**Interfaces:**
- Consumes: `BaseplateParams` (Task 2, now brim-aware) as already imported in both files.
- Produces: nothing new.

`geometry.worker.ts`'s `generateBaseplate` (lines 257-265) takes `params: BaseplateParams` and forwards it whole to `buildBaseplate(m, params)` (the generator). `workerClient.ts`'s `generateBaseplate` (lines 86-89) takes `params: BaseplateParams` and forwards it whole to `getWorker().generateBaseplate(params)`. Comlink structured-clones the params object across the worker boundary; a plain nested object like `{ leftMm, rightMm, frontMm, backMm }` clones with no special handling, exactly like the existing `magnets: BaseplateMagnets | null` field already does.

- [ ] **Step 1: Confirm no code change is needed**

Run: `npm run build` (inside `web/`)
Expected: the build succeeds with zero changes to `geometry.worker.ts` or `workerClient.ts`; both files already type-check against the (now brim-aware) `BaseplateParams` because they consume the type, never construct or narrow it.

- [ ] **Step 2: Commit**

No files changed in this task; nothing to commit. State this explicitly in the task's completion note rather than creating an empty commit.

---

### Task 5: UI: size-mode toggle, drawer-fill fields, SVG preview, queueing

**Owner-approved layout (revised from an earlier draft of this task, which put drawer fill in its own card below the existing controls):** `BaseplateTab.vue` gets a mode toggle at the top of the tab, above the size fields, with two options: "Single plate" and "Fill a drawer". The toggle swaps only the size section: single-plate mode shows the existing units X/Y fields and the existing 3D preview unchanged; fill-a-drawer mode shows the four mm fields, the labeled readout rows, the SVG top-down layout preview, and the "Add plates to queue" button, in the same on-screen position the units fields and 3D preview occupy in single-plate mode. The magnet, screw hole and connectable controls are shown once, below the swapped section, shared by both modes; a drawer-fill plate inherits them exactly as the earlier draft's card did. The clip card is unaffected by the toggle and keeps its current behavior and position.

**Mode state:** a local component ref, `sizeMode: Ref<'single' | 'fill'>`, not a `baseplateDesigner` store field. This follows the store's own documented convention (`web/src/stores/baseplateDesigner.ts`'s header comment: "form state: raw field values only", i.e. fields that become part of the saved `BaseplateProduct` through `product`/`params`): `sizeMode` is pure view state that decides which inputs are visible, never a field of the queued product (a queued baseplate is always either a plain plate from the units fields or a set of drawer-fill plates; nothing about "which UI mode built it" is stored). This mirrors how `previewLoaded`, `clipToleranceMm` and `clipQuantity` already live as local refs in this same component rather than in the store, for the same reason: they are this screen's transient state, not design data.

**Files:**
- Modify: `web/src/components/BaseplateTab.vue`
- Test: manual verification only (component tests are not part of this repo's test suite for other tabs either; `npm run build`'s `vue-tsc` typecheck is the automated bar for this file).

**Interfaces:**
- Consumes: `planDrawerFill`, `DrawerFillInput`, `DrawerFillPlate` from `web/src/engine/baseplate/drawerFill.ts` (Task 1); `baseplateOuterMm` from `web/src/engine/baseplate/generator.ts` (Task 2); `store.magnets`, `store.screwHoleMode`, `store.connectable` from `useBaseplateDesigner()` (existing, `web/src/stores/baseplateDesigner.ts`); `queue.add` from `useBinQueue()` (existing, used at line 164 of the current file).
- Produces: one `BaseplateProduct` per planned plate, queued via `queue.add`.

- [ ] **Step 1: Add the mode toggle and drawer-fill form state**

In `web/src/components/BaseplateTab.vue`'s `<script setup>`, add imports (alongside the existing ones at the top of the file):

```ts
import { planDrawerFill, type DrawerFillPlate } from '../engine/baseplate/drawerFill';
import { baseplateOuterMm } from '../engine/baseplate/generator';
import { PITCH } from '../engine/gridfinity/constants';
import type { BaseplateProduct } from '../engine/plan/types';
```

Add the mode ref and the drawer-fill state, placed after the existing `clipQuantity` ref (around line 56):

```ts
/** Which size section the tab shows: the units X/Y form, or the drawer-fill form. Pure view state, never part of a queued product. */
const sizeMode = ref<'single' | 'fill'>('single');

// The drawer-fill form's four mm inputs. Component-local, like sizeMode:
// this tool composes queue entries from the tab's current magnet/screw/
// connectable settings, but keeps its own size fields since a drawer's and
// a build plate's mm size are not part of any single baseplate design.
const drawerWidthMm = ref<number | null>(null);
const drawerDepthMm = ref<number | null>(null);
const plateWidthMm = ref<number | null>(null);
const plateDepthMm = ref<number | null>(null);

/** The planner's outcome, or null until all four fields are filled in. */
const drawerFillResult = computed(() => {
  if (
    drawerWidthMm.value === null ||
    drawerDepthMm.value === null ||
    plateWidthMm.value === null ||
    plateDepthMm.value === null
  ) {
    return null;
  }
  return planDrawerFill({
    drawerWidthMm: drawerWidthMm.value,
    drawerDepthMm: drawerDepthMm.value,
    plateWidthMm: plateWidthMm.value,
    plateDepthMm: plateDepthMm.value,
  });
});

/** The planned plates, or an empty array while nothing has planned yet or the plan errored. */
const drawerFillPlates = computed<DrawerFillPlate[]>(() => {
  const result = drawerFillResult.value;
  return result !== null && 'plates' in result ? result.plates : [];
});

/** The planner's error message, or null when there is none to show. */
const drawerFillError = computed<string | null>(() => {
  const result = drawerFillResult.value;
  return result !== null && 'error' in result ? result.error : null;
});

/** One planned plate's outer size in mm, for the readout and the SVG preview. */
function drawerFillOuterMm(plate: DrawerFillPlate): { widthMm: number; depthMm: number } {
  return baseplateOuterMm({ unitsX: plate.unitsX, unitsY: plate.unitsY, brim: plate.brim });
}

const drawerFillQueueError = ref<string | null>(null);

/**
 * Queues one BaseplateProduct per planned plate, inheriting the tab's
 * current magnet, screw-hole and connectable settings for the plate's full
 * cells (the same settings store.product uses today, shared between both
 * modes); each plate's brim comes from the planner, never recomputed here.
 */
function addDrawerFillPlates(): void {
  drawerFillQueueError.value = null;
  for (const plate of drawerFillPlates.value) {
    const product: BaseplateProduct = {
      kind: 'baseplate',
      unitsX: plate.unitsX,
      unitsY: plate.unitsY,
      magnets: store.magnets,
      screwHoles: store.screwHoleMode === 'full',
      connectable: store.connectable,
      brim: plate.brim,
    };
    const error = queue.add(product, 1);
    if (error !== null) {
      drawerFillQueueError.value = error;
      return;
    }
  }
}

/** One rectangle of the SVG drawer-fill preview: a full cell or a shaded brim strip. */
interface DrawerFillPreviewRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  brim: boolean;
}

/**
 * The full set of preview rectangles for every planned plate: one rect per
 * full cell (square, PITCH by PITCH) plus, for each brimmed side, one
 * shaded strip spanning that plate's full outer edge. Built directly from
 * the plan's own unitsX/unitsY/brim/column/row fields and PITCH, the same
 * inputs the plan itself is built from; no size is recomputed independently.
 */
const drawerFillPreviewRects = computed<DrawerFillPreviewRect[]>(() => {
  const rects: DrawerFillPreviewRect[] = [];
  // Running left/front-edge offsets per column/row, since columns and rows
  // can have different unit counts (the near-even split).
  const colOffsets: number[] = [];
  let runningX = 0;
  for (const plate of drawerFillPlates.value) {
    if (plate.row === 0) {
      colOffsets[plate.column] = runningX;
      runningX += plate.unitsX * PITCH;
    }
  }
  const rowOffsets: number[] = [];
  let runningY = 0;
  for (const plate of drawerFillPlates.value) {
    if (plate.column === 0) {
      rowOffsets[plate.row] = runningY;
      runningY += plate.unitsY * PITCH;
    }
  }
  for (const plate of drawerFillPlates.value) {
    const originX = colOffsets[plate.column];
    const originY = rowOffsets[plate.row];
    for (let cx = 0; cx < plate.unitsX; cx++) {
      for (let cy = 0; cy < plate.unitsY; cy++) {
        rects.push({
          key: `cell-${plate.column}-${plate.row}-${cx}-${cy}`,
          x: originX + cx * PITCH,
          y: originY + cy * PITCH,
          width: PITCH,
          height: PITCH,
          brim: false,
        });
      }
    }
    if (plate.brim.leftMm > 0) {
      rects.push({
        key: `brim-left-${plate.column}-${plate.row}`,
        x: originX - plate.brim.leftMm,
        y: originY,
        width: plate.brim.leftMm,
        height: plate.unitsY * PITCH,
        brim: true,
      });
    }
    if (plate.brim.rightMm > 0) {
      rects.push({
        key: `brim-right-${plate.column}-${plate.row}`,
        x: originX + plate.unitsX * PITCH,
        y: originY,
        width: plate.brim.rightMm,
        height: plate.unitsY * PITCH,
        brim: true,
      });
    }
    if (plate.brim.backMm > 0) {
      rects.push({
        key: `brim-back-${plate.column}-${plate.row}`,
        x: originX,
        y: originY + plate.unitsY * PITCH,
        width: plate.unitsX * PITCH,
        height: plate.brim.backMm,
        brim: true,
      });
    }
  }
  return rects;
});
```

- [ ] **Step 2: Add the toggle and wrap the existing units fields in the single-plate branch**

In the `<template>`, the current baseplate form (inside `<template v-if="clipEditingEntry === null">`, starting with the "Baseplate size" caption at line 237) is restructured so the toggle sits above everything, and the units fields plus 3D preview are gated on `sizeMode === 'single'` while the magnet/screw/connectable controls stay unconditional. Replace the opening of that template block (from the `<template v-if="clipEditingEntry === null">` line through the closing of the width/depth `v-text-field` pair, currently lines 236-263):

```html
      <template v-if="clipEditingEntry === null">
      <v-btn-toggle
        v-if="editingEntry === null"
        v-model="sizeMode"
        mandatory
        density="comfortable"
        variant="outlined"
        class="mb-4"
      >
        <v-btn value="single">Single plate</v-btn>
        <v-btn value="fill">Fill a drawer</v-btn>
      </v-btn-toggle>

      <template v-if="sizeMode === 'single' || editingEntry !== null">
      <div class="text-caption text-medium-emphasis mb-1">
        Baseplate size (grid units of 42 mm)
      </div>
      <div class="d-flex align-center ga-2">
        <v-text-field
          ref="widthField"
          v-model.number="store.unitsX"
          type="number"
          min="1"
          :max="BASEPLATE_UNITS_MAX"
          step="1"
          label="Width"
          density="comfortable"
          hide-details
        />
        <span class="text-medium-emphasis">x</span>
        <v-text-field
          v-model.number="store.unitsY"
          type="number"
          min="1"
          :max="BASEPLATE_UNITS_MAX"
          step="1"
          label="Depth"
          density="comfortable"
          hide-details
        />
      </div>
      </template>

      <template v-else>
      <div class="text-caption text-medium-emphasis mb-1">
        Drawer size and build plate size (mm)
      </div>
      <p class="text-body-2 text-medium-emphasis mb-4">
        Enter the drawer's inside size and the printer's build plate size.
        The tool splits the drawer into as few baseplates as fit the build
        plate, and extends the plates against the back, left and right
        walls with a brimmed edge carrying partial sockets, so the plates
        cover the drawer wall to wall with no gap.
      </p>
      <div class="d-flex align-center ga-2 mb-2">
        <v-text-field
          v-model.number="drawerWidthMm"
          type="number"
          min="0"
          label="Drawer width (mm)"
          density="comfortable"
          hide-details
        />
        <span class="text-medium-emphasis">x</span>
        <v-text-field
          v-model.number="drawerDepthMm"
          type="number"
          min="0"
          label="Drawer depth (mm)"
          density="comfortable"
          hide-details
        />
      </div>
      <div class="d-flex align-center ga-2 mb-4">
        <v-text-field
          v-model.number="plateWidthMm"
          type="number"
          min="0"
          label="Build plate width (mm)"
          density="comfortable"
          hide-details
        />
        <span class="text-medium-emphasis">x</span>
        <v-text-field
          v-model.number="plateDepthMm"
          type="number"
          min="0"
          label="Build plate depth (mm)"
          density="comfortable"
          hide-details
        />
      </div>

      <v-alert v-if="drawerFillError" type="error" density="compact" class="mb-4">
        {{ drawerFillError }}
      </v-alert>

      <template v-if="drawerFillPlates.length > 0">
        <div class="text-caption text-medium-emphasis mb-1">Plan</div>
        <table class="drawer-fill-readout mb-4">
          <tbody>
            <tr>
              <td>Plate count</td>
              <td>{{ drawerFillPlates.length }}</td>
            </tr>
            <tr v-for="plate in drawerFillPlates" :key="`${plate.column}-${plate.row}`">
              <td>Plate col {{ plate.column }}, row {{ plate.row }}</td>
              <td>
                {{ plate.unitsX }}×{{ plate.unitsY }} units,
                {{ drawerFillOuterMm(plate).widthMm.toFixed(1) }}×{{
                  drawerFillOuterMm(plate).depthMm.toFixed(1)
                }}
                mm outer, brim L{{ plate.brim.leftMm.toFixed(1) }} R{{
                  plate.brim.rightMm.toFixed(1)
                }}
                F{{ plate.brim.frontMm.toFixed(1) }} B{{ plate.brim.backMm.toFixed(1) }}
              </td>
            </tr>
          </tbody>
        </table>

        <svg
          class="drawer-fill-preview mb-4"
          :viewBox="`0 0 ${drawerWidthMm} ${drawerDepthMm}`"
          preserveAspectRatio="xMidYMid meet"
        >
          <rect
            x="0"
            y="0"
            :width="drawerWidthMm ?? 0"
            :height="drawerDepthMm ?? 0"
            class="drawer-fill-outline"
          />
          <rect
            v-for="rect in drawerFillPreviewRects"
            :key="rect.key"
            :x="rect.x"
            :y="rect.y"
            :width="rect.width"
            :height="rect.height"
            :class="rect.brim ? 'drawer-fill-brim' : 'drawer-fill-cell'"
          />
        </svg>
      </template>

      <div class="d-flex ga-2 mb-4">
        <v-btn
          color="primary"
          variant="outlined"
          :disabled="drawerFillPlates.length === 0"
          @click="addDrawerFillPlates"
        >
          Add plates to queue
        </v-btn>
      </div>
      <v-alert v-if="drawerFillQueueError" type="error" class="mb-4" density="compact">
        {{ drawerFillQueueError }}
      </v-alert>
      </template>
```

`editingEntry !== null` forces `single` display (and hides the toggle) while editing an existing row, since an edit always targets one stored plain plate; drawer fill only applies to adding new plates, matching the earlier draft's rule that its card only showed when `editingEntry === null`.

The magnet, screw hole and connectable controls (the "Base magnets" caption through the "Connectable" `v-switch`, currently lines 265-344) are left exactly where they are and are not wrapped in either `sizeMode` branch, so they render once regardless of mode, immediately after the closing `</template>` of the `v-else` block above.

The quantity field, notes field, save error alert and "Add to queue" / "Save changes" button (currently lines 346-383) belong to single-plate mode only (a drawer-fill add has no single quantity, since it queues one row per plate at quantity 1, and no notes field of its own). Wrap that whole block, from the `<div class="d-flex ga-2 mt-4">` that holds `quantity` and `notes` (line 346) through the editing-info `v-alert` (line 383), in `<template v-if="sizeMode === 'single' || editingEntry !== null">...</template>`.

- [ ] **Step 3: Style the SVG preview and readout table**

Add to the `<style scoped>` block at the end of the file (currently just `.preview-card`):

```css
.drawer-fill-preview {
  width: 100%;
  max-height: 240px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.drawer-fill-outline {
  fill: none;
  stroke: rgba(var(--v-theme-on-surface), 0.4);
  stroke-width: 2;
}
.drawer-fill-cell {
  fill: rgba(var(--v-theme-primary), 0.25);
  stroke: rgba(var(--v-theme-primary), 0.6);
  stroke-width: 1;
}
.drawer-fill-brim {
  fill: rgba(var(--v-theme-warning), 0.25);
  stroke: rgba(var(--v-theme-warning), 0.6);
  stroke-width: 1;
}
.drawer-fill-readout {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.drawer-fill-readout td {
  padding: 2px 8px 2px 0;
  vertical-align: top;
}
```

- [ ] **Step 4: Hide the 3D preview column in fill mode**

The right-hand preview column (`<v-col v-if="clipEditingEntry === null" cols="12" md="6">`, currently lines 449-476) renders `BinViewport` for the single-plate 3D preview. In fill mode there is nothing for it to show (the drawer-fill SVG preview already lives inline in the left column, next to its own inputs, matching the spec's placement of the preview inside the swapped size section). Add `sizeMode === 'single'` to that column's guard:

```html
    <v-col v-if="clipEditingEntry === null && sizeMode === 'single'" cols="12" md="6">
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run build` (inside `web/`)
Expected: PASS. `vue-tsc` typechecks the new script block and template bindings; no `any` leaks (`drawerWidthMm` etc. are `number | null`, matched by `planDrawerFill`'s guard in the computed; `sizeMode` is `Ref<'single' | 'fill'>`, matched by both `v-btn value="single"`/`"fill"` bindings and the `v-if` guards).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/BaseplateTab.vue
git commit -m "Add a single-plate/fill-a-drawer mode toggle to the Baseplate tab."
```

---

## Self-Review

**1. Spec coverage.**
- Brim as an attached extension with partial sockets, never a solid bar or separate piece: Task 2, stages 1 to 4 of `generateBaseplate`.
- Back gets full Y leftover; left/right split X leftover 50/50; front gets none: Task 1, `planDrawerFill`'s `leftMm`/`rightMm`/`backMm`/`frontMm` computation, exercised by the four-corner test.
- Brim per side always less than one pitch: guaranteed structurally, since `leftoverX`/`leftoverY` are each `< PITCH` by construction of `Math.floor`, and halving only shrinks `leftoverX/2` further; stated in the `BaseplateBrim` doc comment.
- Splitting into as few plates as possible, near-even (e.g. 6+5 not 10+1): Task 1's `planAxis` loop (fewest-first) plus `evenSplit`, both covered by the two-column test.
- Brimmed edges get no connector slots: Task 2's stage 9 gating.
- Magnets/screws/connectors only at full cells: Task 2's stage 6-8 (unchanged loop over `params.unitsX`/`unitsY`, never the brim cells) plus its dedicated test.
- Errors are user-worded, returned not thrown: `planDrawerFill`'s every branch returns `{ error }`.
- Engine module `drawerFill.ts` is framework-agnostic (Task 1: no Vue/Pinia/DOM import).
- `baseplateSpanMm` stays the single source for full-cell span; `baseplateOuterMm` added as the single source for outer size, wired into `binDownloads.ts` and `rowDescriptor.ts` (Task 2, Task 3), never recomputed in the UI (Task 5 calls `baseplateOuterMm`, not a local formula).
- Plan model, `PlanFile` version bump to 9, `rowDescriptor` mention, `assertNever` patterns preserved: Task 3 (no new discriminated union member was added, so no switch needs a new case; the existing `validateProduct`/`captionOf`/`baseplateParamsOf` functions are extended in place, not duplicated).
- UI: a single-plate/fill-a-drawer mode toggle swapping the size section (units fields and 3D preview versus four mm fields, labeled-row readout, SVG preview and queue button), magnet/screw/connectable controls shown once and shared by both modes, error alert, queue button inheriting the tab's magnet/screw/connectable settings: Task 5 (revised per owner approval from an earlier draft that used a separate card).
- Tests: brim geometry (watertight, exact outer bbox, genus reasoning, partial sockets, slots absent on brimmed edges, magnets only at full cells) in Task 2; planner tests (exact splits, near-even, leftover distribution, errors) in Task 1; plan round-trip and version-9 validation in Task 3.

**2. Placeholder scan.** No "TBD"/"handle appropriately" language; every step carries real, complete code. The one intentional placeholder (Task 5 Step 2's provisional per-cell loop) is explicitly named as a placeholder and is replaced by real code two steps later in the same task, per the "no placeholders" rule's intent that nothing in the final state is a stub.

**3. Type consistency.** `DrawerFillPlate.brim` (Task 1) is structurally identical to `BaseplateBrim` (Task 2) and to `BaseplateProduct.brim` (Task 3); Task 5's `addDrawerFillPlates` assigns `plate.brim` directly into a `BaseplateProduct`, which only typechecks because the three shapes agree field for field (`leftMm`, `rightMm`, `frontMm`, `backMm`, all `number`). `baseplateOuterMm`'s parameter type (`Pick<BaseplateParams, 'unitsX' | 'unitsY' | 'pitchMm' | 'brim'>`) is used identically in Task 2's own tests, Task 3's `rowDescriptor.ts` (passing a whole `BaseplateProduct`, which is a structural superset), and Task 5's `drawerFillOuterMm` (passing a partial object built from `DrawerFillPlate`), confirmed each call site supplies the required `unitsX`/`unitsY`/`brim` (`pitchMm` is optional).
