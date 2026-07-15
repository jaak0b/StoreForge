/**
 * Deterministic shelf packing of rectangular bin footprints onto a build
 * plate. Items are placed in rows (shelves) from the back of the plate to
 * the front, sorted by footprint depth so each row is as flat as possible.
 * Rotation is not attempted: Gridfinity bins are near-square (n x 42 mm),
 * so rotating a footprint rarely changes whether it fits.
 */

/** One rectangular footprint to place, identified by the caller's key. */
export interface FootprintItem {
  /** Caller-chosen identifier, echoed back in the placement. */
  id: string;
  /** Footprint size along X in millimetres. */
  widthMm: number;
  /** Footprint size along Y in millimetres. */
  depthMm: number;
}

/** Packing options; all lengths in millimetres. */
export interface ArrangeOptions {
  /** Plate size along X. */
  plateWidthMm: number;
  /** Plate size along Y. */
  plateDepthMm: number;
  /** Clear distance kept between any two placed footprints. Default 4. */
  spacingMm?: number;
  /** Clear distance kept between a footprint and the plate edge. Default 5. */
  marginMm?: number;
}

/** Where one item's footprint centre ended up on the plate. */
export interface Placement {
  /** The identifier of the placed item. */
  id: string;
  /** Footprint centre X, measured from the plate's front-left corner. */
  xMm: number;
  /** Footprint centre Y, measured from the plate's front-left corner. */
  yMm: number;
  /** Footprint size along X in millimetres. */
  widthMm: number;
  /** Footprint size along Y in millimetres. */
  depthMm: number;
}

/** The packing outcome: placed items plus the ones that did not fit. */
export interface ArrangeResult {
  /** Successfully placed items with their centre positions. */
  placed: Placement[];
  /** Items that did not fit on the plate, in input order. */
  overflow: FootprintItem[];
}

/** Default clear distance between placed footprints in millimetres. */
export const DEFAULT_SPACING_MM = 4;

/** Default clear distance between a footprint and the plate edge in millimetres. */
export const DEFAULT_MARGIN_MM = 5;

/**
 * Pack the given footprints onto the plate and centre the resulting layout.
 * The algorithm is a plain shelf packer: items sorted by depth (then width,
 * then id) descending, filled left to right into rows whose height is the
 * first (deepest) item of the row. Items that fit nowhere are reported in
 * `overflow`, never dropped.
 */
export function arrangePlate(
  items: FootprintItem[],
  options: ArrangeOptions,
): ArrangeResult {
  const spacing = options.spacingMm ?? DEFAULT_SPACING_MM;
  const margin = options.marginMm ?? DEFAULT_MARGIN_MM;
  const usableW = options.plateWidthMm - 2 * margin;
  const usableD = options.plateDepthMm - 2 * margin;

  const sorted = [...items].sort(
    (a, b) =>
      b.depthMm - a.depthMm || b.widthMm - a.widthMm || a.id.localeCompare(b.id),
  );

  interface RawPlacement extends Placement {}
  const placed: RawPlacement[] = [];
  const overflowIds = new Set<string>();

  let rowY = 0; // Top edge (min Y) of the current row, growing downward in layout space.
  let rowDepth = 0; // Depth of the current row (its deepest item).
  let cursorX = 0; // Next free X in the current row.
  let started = false;

  for (const item of sorted) {
    if (item.widthMm > usableW || item.depthMm > usableD) {
      overflowIds.add(item.id);
      continue;
    }
    const needsNewRow =
      !started || cursorX + (cursorX > 0 ? spacing : 0) + item.widthMm > usableW;
    if (needsNewRow) {
      const nextRowY = started ? rowY + rowDepth + spacing : 0;
      if (nextRowY + item.depthMm > usableD) {
        overflowIds.add(item.id);
        continue;
      }
      rowY = nextRowY;
      rowDepth = item.depthMm;
      cursorX = 0;
      started = true;
    }
    const x = cursorX + (cursorX > 0 ? spacing : 0);
    placed.push({
      id: item.id,
      xMm: x + item.widthMm / 2,
      yMm: rowY + item.depthMm / 2,
      widthMm: item.widthMm,
      depthMm: item.depthMm,
    });
    cursorX = x + item.widthMm;
  }

  // Centre the packed layout on the plate.
  if (placed.length > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of placed) {
      minX = Math.min(minX, p.xMm - p.widthMm / 2);
      maxX = Math.max(maxX, p.xMm + p.widthMm / 2);
      minY = Math.min(minY, p.yMm - p.depthMm / 2);
      maxY = Math.max(maxY, p.yMm + p.depthMm / 2);
    }
    const shiftX = (options.plateWidthMm - (maxX - minX)) / 2 - minX;
    const shiftY = (options.plateDepthMm - (maxY - minY)) / 2 - minY;
    for (const p of placed) {
      p.xMm += shiftX;
      p.yMm += shiftY;
    }
  }

  return {
    placed,
    overflow: items.filter((item) => overflowIds.has(item.id)),
  };
}
