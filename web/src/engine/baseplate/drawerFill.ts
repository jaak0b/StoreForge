import { PITCH } from '../gridfinity/constants';
import { BASEPLATE_UNITS_MAX, type BaseplateBrim } from './constants';
import { connectorSlotCentres } from './generator';

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

/**
 * Brim extension per edge, in mm. The one brim shape in the codebase: a plate's
 * planned brim is exactly the brim its stored BaseplateProduct carries, so this
 * is BaseplateBrim itself (declared in baseplate/constants.ts) rather than a
 * parallel copy that could drift from it.
 */
export type { BaseplateBrim };

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
  brim: BaseplateBrim;
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
 * that every group stays within BASEPLATE_UNITS_MAX units and every group's
 * outer size (its units times PITCH, plus its brim where it sits on the low
 * or high edge) fits `buildDimMm`. Tries 1 group, then 2, and so on, each
 * time splitting as evenly as possible (evenSplit), because an uneven split
 * never fits when the even one does not: the even split minimizes the
 * largest group. The unit cap keeps every planned plate a valid stored
 * baseplate even when the mm span would fit the build plate. Returns null
 * when no group count up to totalUnits succeeds, meaning the low or high
 * edge's brim alone is incompatible with buildDimMm (the brim does not
 * shrink as the split grows).
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
      if (sizes[i] > BASEPLATE_UNITS_MAX || outerMm > buildDimMm) {
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

/**
 * Counts the connection clips a planned drawer layout needs, derived from the
 * exact connector-slot placement rule the generator uses (connectorSlotCentres),
 * never a separate guess. A clip joins one matching slot pair on an interior
 * edge where two plates meet: for each pair of horizontally adjacent plates the
 * shared vertical edge carries connectorSlotCentres(unitsY) slots (plates in one
 * row share unitsY), and for each pair of vertically adjacent plates the shared
 * horizontal edge carries connectorSlotCentres(unitsX) slots (plates in one
 * column share unitsX). Drawer-wall (outer) edges and brimmed edges sit against
 * no neighbour and so contribute no clips: only interior shared edges are
 * counted, each exactly once. Returns 0 for a single-plate layout.
 */
export function drawerFillClipCount(plates: DrawerFillPlate[]): number {
  const byPosition = new Map<string, DrawerFillPlate>();
  for (const plate of plates) byPosition.set(`${plate.column},${plate.row}`, plate);
  let clips = 0;
  for (const plate of plates) {
    // The right neighbour shares this plate's vertical edge; its slots run along
    // Y over the shared unitsY. Counted from the left plate so each interior
    // edge is counted once.
    if (byPosition.has(`${plate.column + 1},${plate.row}`)) {
      clips += connectorSlotCentres(plate.unitsY).length;
    }
    // The back neighbour shares this plate's horizontal edge; its slots run along
    // X over the shared unitsX. Counted from the front plate.
    if (byPosition.has(`${plate.column},${plate.row + 1}`)) {
      clips += connectorSlotCentres(plate.unitsX).length;
    }
  }
  return clips;
}

/**
 * One rectangle of the top-down drawer-fill layout: a full socket cell or a
 * shaded brim strip, in drawer-local mm. brim is false for a full cell and true
 * for a brim strip, so a renderer can style the two differently.
 */
export interface DrawerFillLayoutRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  brim: boolean;
  /** 0-based column of the plate this rectangle belongs to, for hover linking. */
  column: number;
  /** 0-based row of the plate this rectangle belongs to, for hover linking. */
  row: number;
}

/**
 * The top-down layout rectangles for a planned plate grid, in drawer-local mm:
 * one square cell (PITCH by PITCH) per full socket, plus one shaded strip per
 * brimmed side spanning that plate's outer edge. Built only from the plates'
 * own unitsX/unitsY/brim/column/row fields and PITCH, the same inputs the plan
 * itself is built from, so no size is recomputed independently.
 *
 * The plan's Y runs front to back (row 0 at the drawer opening), but a top-down
 * view shows the back wall at the top, so every rectangle's Y is flipped within
 * drawerDepthMm. The X mapping is unmirrored. The single source of this layout;
 * the Baseplate tab's SVG preview consumes it rather than recomputing it.
 */
export function drawerFillLayoutRects(
  plates: DrawerFillPlate[],
  drawerDepthMm: number,
): DrawerFillLayoutRect[] {
  const rects: DrawerFillLayoutRect[] = [];
  // Running left/front-edge offsets per column/row, since columns and rows
  // can have different unit counts (the near-even split). The cell grid starts
  // after the left brim, so every rectangle (including the leftmost plate's
  // brim strip) lands inside the 0-based drawer box.
  const colOffsets: number[] = [];
  let runningX = plates[0]?.brim.leftMm ?? 0;
  for (const plate of plates) {
    if (plate.row === 0) {
      colOffsets[plate.column] = runningX;
      runningX += plate.unitsX * PITCH;
    }
  }
  const rowOffsets: number[] = [];
  let runningY = 0;
  for (const plate of plates) {
    if (plate.column === 0) {
      rowOffsets[plate.row] = runningY;
      runningY += plate.unitsY * PITCH;
    }
  }
  for (const plate of plates) {
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
          column: plate.column,
          row: plate.row,
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
        column: plate.column,
        row: plate.row,
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
        column: plate.column,
        row: plate.row,
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
        column: plate.column,
        row: plate.row,
      });
    }
  }
  return rects.map((rect) => ({ ...rect, y: drawerDepthMm - rect.y - rect.height }));
}
