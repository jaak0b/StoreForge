import { describe, expect, it } from 'vitest';
import {
  addTool,
  binPlacement,
  layoutBounds,
  moveTool,
  removeTool,
  replaceToolOutline,
  requiredFootprint,
  setGridManually,
  setToolTransform,
  toBinLocal,
  worldFromEntry,
  type LayoutState,
} from '../../src/engine/trace/layoutModel';
import type { TracedTool, ToolPlacement } from '../../src/engine/trace/types';

// Hand-derived interior figures used throughout (margin 2 mm everywhere):
// one cell's interior is 39.6 mm, two cells give 81.6 mm, three 123.6 mm.

/**
 * L-shaped test tool, 30 mm wide by 25 mm tall, its bounding box spanning
 * 0..30 by 0..25 in tool-local mm (same literals as the pocketBin suite).
 */
function lTool(overrides: Partial<TracedTool> = {}): TracedTool {
  return {
    id: 'l-tool',
    name: 'L wrench',
    outline: {
      outer: [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 25 },
        { x: 0, y: 25 },
      ],
      holes: [],
    },
    rotationDeg: 0,
    offsetMm: 0,
    mirrored: false,
    clicks: [],
    fingerHoles: [],
    ...overrides,
  };
}

/** 70 x 12 mm bar centred on the tool-local origin. */
function barTool(overrides: Partial<TracedTool> = {}): TracedTool {
  return lTool({
    id: 'bar',
    name: 'Bar',
    outline: {
      outer: [
        { x: -35, y: -6 },
        { x: 35, y: -6 },
        { x: 35, y: 6 },
        { x: -35, y: 6 },
      ],
      holes: [],
    },
    ...overrides,
  });
}

/** 10 x 10 mm square centred on the tool-local origin, with the given id. */
function squareTool(id: string): TracedTool {
  return lTool({
    id,
    name: `Square ${id}`,
    outline: {
      outer: [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 5, y: 5 },
        { x: -5, y: 5 },
      ],
      holes: [],
    },
  });
}

/** Centers the L tool's 30 x 25 bounding box on the world origin. */
const centeredL: ToolPlacement = {
  toolId: 'l-tool',
  xMm: -15,
  yMm: -12.5,
  pocketDepthMm: 5,
};

function state(
  tools: TracedTool[],
  placements: ToolPlacement[],
  overrides: Partial<Pick<LayoutState, 'gridX' | 'gridY' | 'gridManual'>> = {},
): LayoutState {
  return {
    tools,
    placements: placements.map((p) => ({ ...p })),
    gridX: 1,
    gridY: 1,
    gridManual: false,
    ...overrides,
  };
}

describe('layoutBounds', () => {
  it('grows the placed bounding box by exactly the clearance per side', () => {
    // The L's box at (-12, -12.5) spans -12..18 by -12.5..12.5; a 1 mm
    // clearance grows every side by 1.
    const placement: ToolPlacement = { toolId: 'l-tool', xMm: -12, yMm: -12.5, pocketDepthMm: 5 };
    expect(layoutBounds([lTool({ offsetMm: 1 })], [placement])).toEqual({
      minX: -13,
      maxX: 19,
      minY: -13.5,
      maxY: 13.5,
    });
  });

  it('includes a slot finger hole reaching past the outline', () => {
    // The slot's far cap reaches world x 31 (endpoint 25 plus the 6 mm
    // radius) and its underside dips to y -13.5.
    const tool = lTool({
      fingerHoles: [{ x: 15, y: 5, x2: 40, y2: 5, diameterMm: 12 }],
    });
    expect(layoutBounds([tool], [centeredL])).toEqual({
      minX: -15,
      maxX: 31,
      minY: -13.5,
      maxY: 12.5,
    });
  });
});

describe('requiredFootprint', () => {
  it('sizes from the extent alone, wherever the layout lies', () => {
    // The L's 30 x 25 box plus 2 mm margins is 34 x 29, inside one cell's
    // 39.6 mm; the far-out placement must give the same answer because the
    // footprint depends only on the extent.
    expect(requiredFootprint([lTool()], [centeredL], 2)).toEqual({ gridX: 1, gridY: 1 });
    const farOut: ToolPlacement = { toolId: 'l-tool', xMm: 500, yMm: 300, pocketDepthMm: 5 };
    expect(requiredFootprint([lTool()], [farOut], 2)).toEqual({ gridX: 1, gridY: 1 });
  });

  it('grows along X for a wide tool', () => {
    // The 70 mm bar cannot fit one cell's 39.6 mm interior; two cells give
    // 81.6 mm.
    const placement: ToolPlacement = { toolId: 'bar', xMm: 0, yMm: 0, pocketDepthMm: 5 };
    expect(requiredFootprint([barTool()], [placement], 2)).toEqual({ gridX: 2, gridY: 1 });
  });

  it('crosses the one-cell limit exactly where the clearance-grown width does', () => {
    // Width 30 plus twice the clearance plus twice the 2 mm margin against
    // the 39.6 mm interior: 2.75 mm clearance gives 39.5 mm (fits one
    // cell), 3 mm gives 40 mm (needs two).
    expect(requiredFootprint([lTool({ offsetMm: 2.75 })], [centeredL], 2).gridX).toBe(1);
    const grown = requiredFootprint([lTool({ offsetMm: 3 })], [centeredL], 2);
    expect(grown.gridX).toBe(2);
    expect(grown.gridY).toBe(1);
  });

  it('rejects sizing an empty layout with a user-worded message', () => {
    expect(() => requiredFootprint([], [], 2)).toThrow(/at least one tool/);
  });
});

describe('binPlacement', () => {
  // The world grid is fixed: cell k spans k*42..(k+1)*42, each cell's
  // interior inset 1.2 mm per side (42 - 39.6 = 2.4).

  it('occupies exactly one fixed cell when the layout sits inside it', () => {
    // The L at (5, 8) spans 5..35 by 8..33; grown by the 2 mm margin it is
    // 3..37 by 6..35, inside cell 0's interior 1.2..40.8 on both axes.
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 5, yMm: 8, pocketDepthMm: 5 }]);
    const bin = binPlacement(s);
    expect(bin.gridX).toBe(1);
    expect(bin.gridY).toBe(1);
    expect(bin.widthMm).toBeCloseTo(39.6, 9);
    expect(bin.minX).toBeCloseTo(1.2, 9);
    expect(bin.minY).toBeCloseTo(1.2, 9);
  });

  it('covers both cells when the layout straddles a cell boundary', () => {
    // The L at (0, 0) grows to -2..32 by -2..27, straddling the fixed
    // boundary at 0 on both axes: cells -1 and 0, interior centred on the
    // two-cell outer span (centre 0), so minX = -81.6 / 2.
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 0, yMm: 0, pocketDepthMm: 5 }]);
    const bin = binPlacement(s);
    expect(bin.gridX).toBe(2);
    expect(bin.gridY).toBe(2);
    expect(bin.minX).toBeCloseTo(-40.8, 9);
    expect(bin.minY).toBeCloseTo(-40.8, 9);
  });

  it('follows the layout wherever it lies instead of moving the tools', () => {
    // The L at (100, 50): grown X extent 98..132 covers cells 2..3 (outer
    // 84..168, interior min 126 - 40.8 = 85.2); grown Y extent 48..77 sits
    // inside cell 1 (interior 43.2..82.8). The placement never moves.
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 100, yMm: 50, pocketDepthMm: 5 }]);
    const bin = binPlacement(s);
    expect(bin.gridX).toBe(2);
    expect(bin.gridY).toBe(1);
    expect(bin.minX).toBeCloseTo(85.2, 9);
    expect(bin.minY).toBeCloseTo(43.2, 9);
    expect(s.placements[0].xMm).toBe(100);
    expect(s.placements[0].yMm).toBe(50);
  });

  it('never shrinks below a typed floor but still grows past it', () => {
    // One-cell L (at 5, 8) with a manual 2 x 1 floor: the run keeps its
    // first cell and extends to two cells (outer 0..84, minX 1.2).
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 5, yMm: 8, pocketDepthMm: 5 }], {
      gridX: 2,
      gridY: 1,
      gridManual: true,
    });
    const floored = binPlacement(s);
    expect(floored.gridX).toBe(2);
    expect(floored.gridY).toBe(1);
    expect(floored.widthMm).toBeCloseTo(81.6, 9);
    expect(floored.minX).toBeCloseTo(1.2, 9);
    // A vertical 70 mm bar centred at (21, 21) spans y -16..58 grown,
    // covering cells -1..1: the derived footprint grows to 3 past the
    // typed 1 while the stored floor stays 2 x 1.
    s.tools = [barTool()];
    s.placements = [{ toolId: 'bar', xMm: 21, yMm: 21, pocketDepthMm: 5 }];
    setToolTransform(s, 'bar', { rotationDeg: 90 });
    const grown = binPlacement(s);
    expect(grown.gridY).toBe(3);
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(1);
  });

  it('occupies the cells at the origin while nothing is placed', () => {
    const s = state([], [], { gridX: 2, gridY: 1 });
    const bin = binPlacement(s);
    expect(bin.gridX).toBe(2);
    expect(bin.gridY).toBe(1);
    expect(bin.minX).toBeCloseTo(1.2, 9);
    expect(bin.minY).toBeCloseTo(1.2, 9);
    expect(bin.widthMm).toBeCloseTo(81.6, 9);
    expect(bin.heightMm).toBeCloseTo(39.6, 9);
  });
});

describe('moveTool', () => {
  it('grows and collapses the footprint live without moving any placement', () => {
    // Two 10 mm squares inside cell 0 (a at 10,10; b at 26,10): one cell.
    // Dragging b to (60, 10) reaches into cell 1's interior: two cells.
    // At (100, 10) the grown extent 3..107 covers cells 0..2: three cells.
    // Back at (60, 10) it collapses to two. Placements always hold exactly
    // the dragged values.
    const s = state(
      [squareTool('a'), squareTool('b')],
      [
        { toolId: 'a', xMm: 10, yMm: 10, pocketDepthMm: 5 },
        { toolId: 'b', xMm: 26, yMm: 10, pocketDepthMm: 5 },
      ],
    );
    moveTool(s, 'b', 26, 10);
    expect(s.gridX).toBe(1);
    expect(s.gridY).toBe(1);
    moveTool(s, 'b', 60, 10);
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(1);
    moveTool(s, 'b', 100, 10);
    expect(s.gridX).toBe(3);
    expect(s.gridY).toBe(1);
    expect(s.placements[0]).toEqual({ toolId: 'a', xMm: 10, yMm: 10, pocketDepthMm: 5 });
    expect(s.placements[1]).toEqual({ toolId: 'b', xMm: 100, yMm: 10, pocketDepthMm: 5 });
    moveTool(s, 'b', 60, 10);
    expect(s.gridX).toBe(2);
    expect(s.placements[0]).toEqual({ toolId: 'a', xMm: 10, yMm: 10, pocketDepthMm: 5 });
    expect(s.placements[1]).toEqual({ toolId: 'b', xMm: 60, yMm: 10, pocketDepthMm: 5 });
  });

  it('keeps a typed floor: a drag no longer discards the manual size', () => {
    const s = state([lTool()], [centeredL], { gridX: 4, gridY: 4, gridManual: true });
    moveTool(s, 'l-tool', 100, 0);
    expect(s.gridManual).toBe(true);
    expect(s.gridX).toBe(4);
    expect(binPlacement(s).gridX).toBe(4);
  });
});

describe('toBinLocal and worldFromEntry', () => {
  it('converts world placements to bin-centred ones via the derived bin', () => {
    // The L at (7, 4) sits inside cell 0 (grown 5..39 by 2..31), whose
    // interior centre is (21, 21): the bin-centred placement is
    // (7 - 21, 4 - 21).
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 7, yMm: 4, pocketDepthMm: 5 }]);
    const local = toBinLocal(s);
    expect(local.gridX).toBe(1);
    expect(local.gridY).toBe(1);
    expect(local.placements[0].xMm).toBeCloseTo(-14, 9);
    expect(local.placements[0].yMm).toBeCloseTo(-17, 9);
    // The world state is untouched.
    expect(s.placements[0].xMm).toBe(7);
  });

  it('round-trips a stored entry: world in, same bin-centred placements out', () => {
    // A 1 x 1 entry lands in the world cells 0..1, interior centre (21, 21):
    // the stored (-15, -12.5) becomes world (6, 8.5) and converts back
    // exactly.
    const world = worldFromEntry([centeredL], 1, 1);
    expect(world[0].xMm).toBeCloseTo(6, 9);
    expect(world[0].yMm).toBeCloseTo(8.5, 9);
    const s = state([lTool()], world);
    const local = toBinLocal(s);
    expect(local.gridX).toBe(1);
    expect(local.gridY).toBe(1);
    expect(local.placements[0].xMm).toBeCloseTo(-15, 9);
    expect(local.placements[0].yMm).toBeCloseTo(-12.5, 9);
  });

  it('returns no placements for an entry without any', () => {
    expect(worldFromEntry([], 1, 1)).toEqual([]);
  });
});

describe('setGridManually', () => {
  it('clamps a typed value below the required minimum and returns the applied size', () => {
    const s = state([barTool()], [{ toolId: 'bar', xMm: 0, yMm: 0, pocketDepthMm: 5 }], {
      gridX: 2,
    });
    expect(setGridManually(s, 'x', 1)).toBe(2);
    expect(s.gridX).toBe(2);
    expect(s.gridManual).toBe(true);
  });

  it('applies a typed value above the minimum as is', () => {
    const s = state([barTool()], [{ toolId: 'bar', xMm: 0, yMm: 0, pocketDepthMm: 5 }], {
      gridX: 2,
    });
    expect(setGridManually(s, 'y', 5)).toBe(5);
    expect(s.gridY).toBe(5);
  });
});

describe('tool list and transform actions', () => {
  it('re-sizes when a tool is added and when it is removed', () => {
    const s = state([], []);
    const bar = addTool(
      s,
      {
        outer: [
          { x: 0, y: 0 },
          { x: 70, y: 0 },
          { x: 70, y: 12 },
          { x: 0, y: 12 },
        ],
        holes: [],
      },
      'Bar',
      20,
    );
    // The clearance-grown box starts at 3.2 mm (cell inset 1.2 plus margin
    // 2): the recentred 70 mm bar's placement is 3.2 + 35 + 0.5 = 38.7 by
    // 3.2 + 6 + 0.5 = 9.7, and the grown extent 1.2..76.2 covers two cells.
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(1);
    expect(s.placements[0]).toEqual({ toolId: bar.id, xMm: 38.7, yMm: 9.7, pocketDepthMm: 20 });
    addTool(
      s,
      {
        outer: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        holes: [],
      },
      'Square',
      20,
    );
    removeTool(s, bar.id);
    // Only the 10 mm square remains: back down to one cell.
    expect(s.tools).toHaveLength(1);
    expect(s.gridX).toBe(1);
    expect(s.gridY).toBe(1);
  });

  it('places sheet-position tools where they lay on the paper, not stacked', () => {
    // Two 10 mm squares traced at sheet spots (40..50, 40..50) and
    // (150..160, 90..100): placed at their sheet positions their placements
    // are the bounding-box middles (45, 45) and (155, 95), restoring every
    // outline point's sheet coordinates. They stay 110 mm apart instead of
    // stacking, and the extent grown by the 0.5 mm default clearance plus
    // the 2 mm margin (37.5..162.5 by 37.5..102.5) covers cells 0..3 by
    // 0..2 of the fixed world grid.
    const s = state([], []);
    const square = (x0: number, y0: number) => ({
      outer: [
        { x: x0, y: y0 },
        { x: x0 + 10, y: y0 },
        { x: x0 + 10, y: y0 + 10 },
        { x: x0, y: y0 + 10 },
      ],
      holes: [],
    });
    const a = addTool(s, square(40, 40), 'A', 20, [], true);
    const b = addTool(s, square(150, 90), 'B', 20, [], true);
    expect(s.placements[0]).toEqual({ toolId: a.id, xMm: 45, yMm: 45, pocketDepthMm: 20 });
    expect(s.placements[1]).toEqual({ toolId: b.id, xMm: 155, yMm: 95, pocketDepthMm: 20 });
    const bin = binPlacement(s);
    expect(bin.gridX).toBe(4);
    expect(bin.gridY).toBe(3);
    expect(bin.minX).toBeCloseTo(1.2, 9);
    expect(bin.minY).toBeCloseTo(1.2, 9);
  });

  it('moves a re-traced tool to its new sheet position', () => {
    const s = state([], []);
    const square = (x0: number, y0: number) => ({
      outer: [
        { x: x0, y: y0 },
        { x: x0 + 10, y: y0 },
        { x: x0 + 10, y: y0 + 10 },
        { x: x0, y: y0 + 10 },
      ],
      holes: [],
    });
    const tool = addTool(s, square(40, 40), 'A', 20, [], true);
    replaceToolOutline(s, tool.id, square(80, 20), []);
    expect(s.placements[0].xMm).toBe(85);
    expect(s.placements[0].yMm).toBe(25);
  });

  it('keeps a manual floor when a tool outgrows it, growing only the derived bin', () => {
    const s = state([lTool()], [centeredL], { gridManual: true, gridX: 1, gridY: 1 });
    addTool(
      s,
      {
        outer: [
          { x: 0, y: 0 },
          { x: 70, y: 0 },
          { x: 70, y: 12 },
          { x: 0, y: 12 },
        ],
        holes: [],
      },
      'Bar',
      20,
    );
    expect(s.gridX).toBe(1);
    expect(s.gridY).toBe(1);
    // The L straddles the origin boundary (grown -17..17) and the added bar
    // reaches to 76.2: together they cover cells -1..2, which the derived
    // footprint reports past the floor.
    expect(binPlacement(s).gridX).toBe(3);
  });

  it('re-sizes when a transform change swaps the layout axes', () => {
    // Horizontal bar at (42, 21): grown 5..79 covers cells 0..1, Y inside
    // cell 0: 2 x 1. Rotated 90 degrees about its centre, the grown Y
    // extent -16..58 covers cells -1..1 and X (34..50) straddles the
    // boundary at 42: 2 x 3.
    const s = state([barTool()], [{ toolId: 'bar', xMm: 42, yMm: 21, pocketDepthMm: 5 }], {
      gridX: 2,
    });
    setToolTransform(s, 'bar', { rotationDeg: 0 });
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(1);
    setToolTransform(s, 'bar', { rotationDeg: 90 });
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(3);
  });
});
