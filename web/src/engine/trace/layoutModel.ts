// The layout model of the trace tab: one synchronous, framework-agnostic
// home for footprint sizing and every layout mutation (tool placement,
// transforms, finger holes, manual size). Placements live in a fixed world
// frame: dragging moves a tool and nothing else; the model never shifts,
// recentres, or snaps a placement. The bin follows the layout instead: its
// footprint and world position are derived from the layout's bounding box
// (binPlacement), recomputed live on every change. The UI store delegates
// here; the worker's CSG validation (validatePocketLayout, run by every
// preview generation) remains the final authority on whether a layout
// actually fits the bin's rounded interior. No manifold dependency: sizing
// works on bounding boxes (see layoutBounds), which can disagree with the
// exact rounded-rect containment only within the interior corner radius, in
// practice covered by the AUTO_SIZE_MARGIN_MM margin; a genuine miss still
// surfaces as the preview's validation error.
import type { FingerHole, MmPoint, SamPoint, TracedOutline, TracedTool, ToolPlacement } from './types';
import { boundsOf, transformTool } from './edit';
import { binInteriorSizeMm } from '../gridfinity/constants';

/**
 * Clear interior kept around the pockets when the bin footprint is
 * auto-sized: the gap between the pocket outline and the bin wall so the
 * wall line does not touch the pocket edge.
 */
export const AUTO_SIZE_MARGIN_MM = 2;

/**
 * Default outward clearance for a new tool. 0.5 mm is a typical FDM XY fit
 * clearance: enough to slide the tool into the pocket snugly without binding
 * on printer dimensional error.
 */
export const DEFAULT_CLEARANCE_MM = 0.5;

/** The layout state the model's actions operate on, mutated in place. */
export interface LayoutState {
  tools: TracedTool[];
  /** Tool placements in the fixed world frame, in mm. */
  placements: ToolPlacement[];
  /**
   * Bin footprint in cells. While gridManual is false this tracks the
   * required footprint of the layout; while true it holds the typed size,
   * a floor the derived footprint (binPlacement) never goes below.
   */
  gridX: number;
  gridY: number;
  /** True when the user typed a footprint; the typed size acts as a floor. */
  gridManual: boolean;
}

/** Axis-aligned bounding box of a layout, in world mm. */
export interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The smallest footprint whose interior contains the layout with margin. */
export interface RequiredFootprint {
  gridX: number;
  gridY: number;
}

/**
 * Where the bin sits in the world frame: its footprint in cells plus its
 * interior rectangle in world mm.
 */
export interface BinPlacement {
  gridX: number;
  gridY: number;
  /** World mm of the interior rectangle's minimum corner. */
  minX: number;
  minY: number;
  /** Interior extent in mm (binInteriorSizeMm of the footprint). */
  widthMm: number;
  heightMm: number;
}

/**
 * Bounding box of everything placed: each tool's resolved outline grown by
 * its clearance, plus its finger holes (circle or capsule extents), all in
 * world mm.
 *
 * Synchronous and manifold-free: the tool's clearance (engine-side a
 * CrossSection.offset with Round joins, a Minkowski sum with a disk of
 * radius offsetMm) is accounted for by growing the outline's bounding box by
 * offsetMm on each side. For axis-aligned bounds this is EXACT: the bounding
 * box of a Minkowski sum with a disk is the summand's bounding box grown by
 * exactly the disk radius in every direction. Finger holes get no clearance,
 * matching the pocket generator.
 */
export function layoutBounds(tools: TracedTool[], placements: ToolPlacement[]): LayoutBounds {
  if (placements.length === 0) {
    throw new Error('Place at least one tool before sizing the bin.');
  }
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const placement of placements) {
    const tool = byId.get(placement.toolId);
    if (!tool) {
      throw new Error(
        'A pocket refers to a tool that is no longer in the plan. Remove that pocket and place the tool again.',
      );
    }
    const b = boundsOf(transformTool(tool.outline, tool.rotationDeg, tool.mirrored));
    minX = Math.min(minX, b.minX - tool.offsetMm + placement.xMm);
    maxX = Math.max(maxX, b.maxX + tool.offsetMm + placement.xMm);
    minY = Math.min(minY, b.minY - tool.offsetMm + placement.yMm);
    maxY = Math.max(maxY, b.maxY + tool.offsetMm + placement.yMm);
    for (const hole of tool.fingerHoles) {
      const r = hole.diameterMm / 2;
      const x2 = hole.x2 ?? hole.x;
      const y2 = hole.y2 ?? hole.y;
      minX = Math.min(minX, Math.min(hole.x, x2) - r + placement.xMm);
      maxX = Math.max(maxX, Math.max(hole.x, x2) + r + placement.xMm);
      minY = Math.min(minY, Math.min(hole.y, y2) - r + placement.yMm);
      maxY = Math.max(maxY, Math.max(hole.y, y2) + r + placement.yMm);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The smallest gridX by gridY footprint whose interior contains the layout's
 * bounding box with at least marginMm of clear interior on every side. Sized
 * from the box's extent alone; where the bin then sits is binPlacement's
 * job. The interior is treated as its bounding rectangle; the worker's exact
 * rounded-corner containment check remains the final validator (see the
 * module comment).
 */
export function requiredFootprint(
  tools: TracedTool[],
  placements: ToolPlacement[],
  marginMm: number,
): RequiredFootprint {
  if (marginMm < 0) {
    throw new RangeError(`margin must be >= 0, got ${marginMm}`);
  }
  const b = layoutBounds(tools, placements);
  // Smallest cell count whose interior spans the extent plus both margins.
  const cellsFor = (extent: number): number => {
    let cells = 1;
    while (binInteriorSizeMm(cells) < extent + 2 * marginMm) cells += 1;
    return cells;
  };
  return {
    gridX: cellsFor(b.maxX - b.minX),
    gridY: cellsFor(b.maxY - b.minY),
  };
}

/**
 * Derives where the bin sits in the world frame. The footprint is the
 * layout's required footprint, floored at the typed size while the footprint
 * is manual; the interior rectangle is placed around the layout's bounding
 * box with the cell-rounding slack split evenly per axis, so the interior
 * centre coincides with the box centre. With no tools placed, the current
 * footprint sits centred on the world origin. Pure and deterministic; the
 * single home for the bin's world position.
 */
export function binPlacement(state: LayoutState): BinPlacement {
  if (state.placements.length === 0) {
    const widthMm = binInteriorSizeMm(state.gridX);
    const heightMm = binInteriorSizeMm(state.gridY);
    return {
      gridX: state.gridX,
      gridY: state.gridY,
      minX: -widthMm / 2,
      minY: -heightMm / 2,
      widthMm,
      heightMm,
    };
  }
  const b = layoutBounds(state.tools, state.placements);
  const required = requiredFootprint(state.tools, state.placements, AUTO_SIZE_MARGIN_MM);
  const gridX = state.gridManual ? Math.max(state.gridX, required.gridX) : required.gridX;
  const gridY = state.gridManual ? Math.max(state.gridY, required.gridY) : required.gridY;
  const widthMm = binInteriorSizeMm(gridX);
  const heightMm = binInteriorSizeMm(gridY);
  return {
    gridX,
    gridY,
    minX: (b.minX + b.maxX) / 2 - widthMm / 2,
    minY: (b.minY + b.maxY) / 2 - heightMm / 2,
    widthMm,
    heightMm,
  };
}

/**
 * Converts the world-frame layout into the pocket generator's bin-centred
 * coordinates: the derived footprint plus every placement translated so the
 * bin interior centre (from binPlacement) is the origin. The single home for
 * the world-to-bin conversion; preview generation and entry saving both go
 * through it, so stored plan entries keep bin-centred placements.
 */
export function toBinLocal(state: LayoutState): {
  gridX: number;
  gridY: number;
  placements: ToolPlacement[];
} {
  const bin = binPlacement(state);
  const cx = bin.minX + bin.widthMm / 2;
  const cy = bin.minY + bin.heightMm / 2;
  return {
    gridX: bin.gridX,
    gridY: bin.gridY,
    placements: state.placements.map((p) => ({ ...p, xMm: p.xMm - cx, yMm: p.yMm - cy })),
  };
}

/**
 * Converts a stored entry's bin-centred placements back into world-frame
 * placements by putting the layout's bounding-box centre on the world
 * origin, so a resumed edit derives the same bin around the same layout.
 */
export function worldFromEntry(tools: TracedTool[], placements: ToolPlacement[]): ToolPlacement[] {
  if (placements.length === 0) return [];
  const b = layoutBounds(tools, placements);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return placements.map((p) => ({ ...p, xMm: p.xMm - cx, yMm: p.yMm - cy }));
}

/**
 * Keeps state.gridX/gridY tracking the layout's required footprint while
 * auto-sized; while manual the typed floor is left alone (binPlacement
 * applies the floor). Placements are never touched.
 */
function refit(state: LayoutState): void {
  if (state.gridManual || state.placements.length === 0) return;
  const size = requiredFootprint(state.tools, state.placements, AUTO_SIZE_MARGIN_MM);
  state.gridX = size.gridX;
  state.gridY = size.gridY;
}

/**
 * Moves a tool to an absolute world position. Only that placement changes;
 * the footprint is recomputed live so the bin grows and shrinks around the
 * layout as the tool moves.
 */
export function moveTool(state: LayoutState, toolId: string, xMm: number, yMm: number): void {
  const placement = state.placements.find((p) => p.toolId === toolId);
  if (placement === undefined) return;
  placement.xMm = xMm;
  placement.yMm = yMm;
  refit(state);
}

/** Drops the typed footprint floor: the footprint follows the layout again. */
export function enableAutoSize(state: LayoutState): void {
  state.gridManual = false;
  refit(state);
}

/**
 * Applies a typed footprint on one axis: marks the footprint manual and
 * clamps the value to the smallest footprint that fits the current layout,
 * so the size fields can never make a tool reach into the bin wall. The
 * typed size is a floor: the bin never shrinks below it while manual, but
 * still grows past it when the layout demands. Returns the applied cell
 * count so the field can echo a clamped entry.
 */
export function setGridManually(state: LayoutState, axis: 'x' | 'y', value: number): number {
  const current = axis === 'x' ? state.gridX : state.gridY;
  if (!Number.isFinite(value)) return current;
  const cells = Math.max(1, Math.floor(value));
  state.gridManual = true;
  let minimum = 1;
  if (state.placements.length > 0) {
    const size = requiredFootprint(state.tools, state.placements, AUTO_SIZE_MARGIN_MM);
    minimum = axis === 'x' ? size.gridX : size.gridY;
  }
  const applied = Math.max(minimum, cells);
  if (axis === 'x') state.gridX = applied;
  else state.gridY = applied;
  return applied;
}

/** Recentres an outline on its bounding-box middle, into tool-local mm. */
function recentred(outline: TracedOutline): TracedOutline {
  const bounds = boundsOf(outline);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const recentre = (p: MmPoint): MmPoint => ({ x: p.x - cx, y: p.y - cy });
  return {
    outer: outline.outer.map(recentre),
    holes: outline.holes.map((loop) => loop.map(recentre)),
  };
}

/**
 * Adds a tool from an outline in sheet mm: the outline is recentered so
 * tool-local coordinates sit about the origin, and the tool is placed at the
 * world origin with the given pocket depth. Re-sizes unless manual.
 */
export function addTool(
  state: LayoutState,
  outline: TracedOutline,
  name: string,
  pocketDepthMm: number,
  clicks: SamPoint[] = [],
): TracedTool {
  const tool: TracedTool = {
    id: crypto.randomUUID(),
    name,
    outline: recentred(outline),
    clicks,
    rotationDeg: 0,
    offsetMm: DEFAULT_CLEARANCE_MM,
    mirrored: false,
    fingerHoles: [],
  };
  state.tools.push(tool);
  state.placements.push({ toolId: tool.id, xMm: 0, yMm: 0, pocketDepthMm });
  refit(state);
  return tool;
}

/**
 * Replaces an existing tool's outline and clicks after re-tracing it from
 * the stored photo; the placement, name and editing parameters stay.
 * Re-sizes unless manual.
 */
export function replaceToolOutline(
  state: LayoutState,
  toolId: string,
  outline: TracedOutline,
  clicks: SamPoint[],
): void {
  const tool = state.tools.find((t) => t.id === toolId);
  if (tool === undefined) return;
  tool.outline = recentred(outline);
  tool.clicks = clicks;
  refit(state);
}

/** Removes a tool and its placement. Re-sizes unless manual. */
export function removeTool(state: LayoutState, toolId: string): void {
  state.tools = state.tools.filter((tool) => tool.id !== toolId);
  state.placements = state.placements.filter((p) => p.toolId !== toolId);
  refit(state);
}

/**
 * Duplicates a tool, landing the copy offset from the original so both are
 * visible. Re-sizes unless manual. Returns the copy, or null when the source
 * is gone.
 */
export function duplicateTool(state: LayoutState, toolId: string): TracedTool | null {
  const source = state.tools.find((tool) => tool.id === toolId);
  const placement = state.placements.find((p) => p.toolId === toolId);
  if (source === undefined || placement === undefined) return null;
  const copy: TracedTool = {
    ...(JSON.parse(JSON.stringify(source)) as TracedTool),
    id: crypto.randomUUID(),
    name: `${source.name} copy`,
  };
  state.tools.push(copy);
  state.placements.push({
    toolId: copy.id,
    xMm: placement.xMm + 10,
    yMm: placement.yMm + 10,
    pocketDepthMm: placement.pocketDepthMm,
  });
  refit(state);
  return copy;
}

/**
 * Applies rotation, mirror or clearance changes to a tool. Any of them can
 * change the resolved outline's extents, so this re-sizes unless manual.
 */
export function setToolTransform(
  state: LayoutState,
  toolId: string,
  patch: Partial<Pick<TracedTool, 'rotationDeg' | 'mirrored' | 'offsetMm'>>,
): void {
  const tool = state.tools.find((t) => t.id === toolId);
  if (tool === undefined) return;
  if (patch.rotationDeg !== undefined) tool.rotationDeg = patch.rotationDeg;
  if (patch.mirrored !== undefined) tool.mirrored = patch.mirrored;
  if (patch.offsetMm !== undefined) tool.offsetMm = patch.offsetMm;
  refit(state);
}

/** Sets a placement's pocket depth. Depth never changes the footprint. */
export function setPocketDepth(state: LayoutState, toolId: string, depthMm: number): void {
  const placement = state.placements.find((p) => p.toolId === toolId);
  if (placement === undefined) return;
  placement.pocketDepthMm = depthMm;
}

/**
 * Adds a finger hole to a tool, in tool-local mm. Re-sizes unless manual.
 * Returns the pushed hole (the reactive instance when the state is a store)
 * so a placement drag can keep stretching it, or null when the tool is gone.
 */
export function addFingerHole(
  state: LayoutState,
  toolId: string,
  hole: FingerHole,
): FingerHole | null {
  const tool = state.tools.find((t) => t.id === toolId);
  if (tool === undefined) return null;
  tool.fingerHoles.push(hole);
  refit(state);
  return tool.fingerHoles[tool.fingerHoles.length - 1];
}

/** Moves a finger hole (both endpoints) by a delta. Re-sizes unless manual. */
export function moveFingerHole(
  state: LayoutState,
  hole: FingerHole,
  dxMm: number,
  dyMm: number,
): void {
  hole.x += dxMm;
  hole.y += dyMm;
  if (hole.x2 !== undefined && hole.y2 !== undefined) {
    hole.x2 += dxMm;
    hole.y2 += dyMm;
  }
  refit(state);
}

/**
 * Stretches a hole's second endpoint while it is being placed, in tool-local
 * mm. Re-sizes unless manual.
 */
export function stretchFingerHole(
  state: LayoutState,
  hole: FingerHole,
  x2Mm: number,
  y2Mm: number,
): void {
  hole.x2 = x2Mm;
  hole.y2 = y2Mm;
  refit(state);
}

/**
 * Finishes placing a hole: a drag shorter than minSlotMm collapses back to a
 * plain circle. Re-sizes unless manual.
 */
export function finishFingerHole(state: LayoutState, hole: FingerHole, minSlotMm: number): void {
  const length = Math.hypot((hole.x2 ?? hole.x) - hole.x, (hole.y2 ?? hole.y) - hole.y);
  if (length < minSlotMm) {
    delete hole.x2;
    delete hole.y2;
  }
  refit(state);
}

/** Removes a tool's finger hole by index. Re-sizes unless manual. */
export function removeFingerHole(state: LayoutState, tool: TracedTool, index: number): void {
  tool.fingerHoles.splice(index, 1);
  refit(state);
}

/** Sets a finger hole's diameter. Re-sizes unless manual. */
export function setFingerHoleDiameter(
  state: LayoutState,
  hole: FingerHole,
  diameterMm: number,
): void {
  if (!Number.isFinite(diameterMm) || diameterMm <= 0) return;
  hole.diameterMm = diameterMm;
  refit(state);
}
