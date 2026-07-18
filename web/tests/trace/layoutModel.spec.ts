import { describe, expect, it } from 'vitest';
import {
  addTool,
  binPlacement,
  layoutBounds,
  moveTool,
  removeTool,
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
  it('centres the interior on the layout box, splitting the slack evenly', () => {
    // The L placed at (0, 0) spans 0..30 by 0..25 and needs one cell. The
    // 39.6 mm interior centres on the box centre (15, 12.5): minX is
    // 15 - 19.8 = -4.8, minY 12.5 - 19.8 = -7.3. Equivalently, the box min
    // 0 minus the 2 mm margin minus half the 5.6 mm X slack (39.6 - 34).
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 0, yMm: 0, pocketDepthMm: 5 }]);
    const bin = binPlacement(s);
    expect(bin.gridX).toBe(1);
    expect(bin.gridY).toBe(1);
    expect(bin.widthMm).toBeCloseTo(39.6, 9);
    expect(bin.heightMm).toBeCloseTo(39.6, 9);
    expect(bin.minX).toBeCloseTo(-4.8, 9);
    expect(bin.minY).toBeCloseTo(-7.3, 9);
  });

  it('follows the layout wherever it lies instead of moving the tools', () => {
    // Same L shifted to (100, 50): the bin follows, the placement does not
    // move.
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 100, yMm: 50, pocketDepthMm: 5 }]);
    const bin = binPlacement(s);
    expect(bin.minX).toBeCloseTo(95.2, 9);
    expect(bin.minY).toBeCloseTo(42.7, 9);
    expect(s.placements[0].xMm).toBe(100);
    expect(s.placements[0].yMm).toBe(50);
  });

  it('never shrinks below a typed floor but still grows past it', () => {
    // Manual 2 x 1 floor around the one-cell L: the bin holds 2 x 1 with
    // its 81.6 mm interior centred on the box centre (15, 12.5).
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 0, yMm: 0, pocketDepthMm: 5 }], {
      gridX: 2,
      gridY: 1,
      gridManual: true,
    });
    const floored = binPlacement(s);
    expect(floored.gridX).toBe(2);
    expect(floored.widthMm).toBeCloseTo(81.6, 9);
    expect(floored.minX).toBeCloseTo(-25.8, 9);
    // A 90 degree turn makes the bar demand 2 cells along Y, past the
    // typed 1: the derived footprint grows while the floor stays 2 x 1.
    s.tools = [barTool()];
    s.placements = [{ toolId: 'bar', xMm: 0, yMm: 0, pocketDepthMm: 5 }];
    setToolTransform(s, 'bar', { rotationDeg: 90 });
    const grown = binPlacement(s);
    expect(grown.gridX).toBe(2);
    expect(grown.gridY).toBe(2);
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(1);
  });

  it('centres the current footprint on the origin while nothing is placed', () => {
    const s = state([], [], { gridX: 2, gridY: 1 });
    const bin = binPlacement(s);
    expect(bin).toEqual({
      gridX: 2,
      gridY: 1,
      minX: -40.8,
      minY: -19.8,
      widthMm: 81.6,
      heightMm: 39.6,
    });
  });
});

describe('moveTool', () => {
  it('grows and collapses the footprint live without moving any placement', () => {
    // Two 10 mm squares, one at the origin: with the other at x 60 the box
    // spans -5..65, 70 mm plus margins is 74, two cells. At x 70 the box
    // spans -5..75, 80 mm plus margins is 84, past the
    // 81.6 mm two-cell interior, so three cells; back at 60 it collapses
    // to two. The placements always hold exactly the dragged values.
    const s = state(
      [squareTool('a'), squareTool('b')],
      [
        { toolId: 'a', xMm: 0, yMm: 0, pocketDepthMm: 5 },
        { toolId: 'b', xMm: 60, yMm: 0, pocketDepthMm: 5 },
      ],
    );
    moveTool(s, 'b', 60, 0);
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(1);
    moveTool(s, 'b', 70, 0);
    expect(s.gridX).toBe(3);
    expect(s.gridY).toBe(1);
    expect(s.placements[0]).toEqual({ toolId: 'a', xMm: 0, yMm: 0, pocketDepthMm: 5 });
    expect(s.placements[1]).toEqual({ toolId: 'b', xMm: 70, yMm: 0, pocketDepthMm: 5 });
    moveTool(s, 'b', 60, 0);
    expect(s.gridX).toBe(2);
    expect(s.placements[0]).toEqual({ toolId: 'a', xMm: 0, yMm: 0, pocketDepthMm: 5 });
    expect(s.placements[1]).toEqual({ toolId: 'b', xMm: 60, yMm: 0, pocketDepthMm: 5 });
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
    // The L at (7, 3) spans 7..37 by 3..28, box centre (22, 15.5); the bin
    // centre coincides with it, so the bin-centred placement is exactly
    // (-15, -12.5), the placement that centres the L's box on the origin.
    const s = state([lTool()], [{ toolId: 'l-tool', xMm: 7, yMm: 3, pocketDepthMm: 5 }]);
    const local = toBinLocal(s);
    expect(local.gridX).toBe(1);
    expect(local.gridY).toBe(1);
    expect(local.placements[0].xMm).toBeCloseTo(-15, 9);
    expect(local.placements[0].yMm).toBeCloseTo(-12.5, 9);
    // The world state is untouched.
    expect(s.placements[0].xMm).toBe(7);
  });

  it('round-trips a stored entry: world in, same bin-centred placements out', () => {
    const world = worldFromEntry([lTool()], [centeredL]);
    // The stored layout's box centre already sits on the origin, so the
    // placement is unchanged.
    expect(world[0].xMm).toBeCloseTo(-15, 9);
    expect(world[0].yMm).toBeCloseTo(-12.5, 9);
    const s = state([lTool()], world);
    const local = toBinLocal(s);
    expect(local.placements[0].xMm).toBeCloseTo(-15, 9);
    expect(local.placements[0].yMm).toBeCloseTo(-12.5, 9);
  });

  it('returns no placements for an entry without any', () => {
    expect(worldFromEntry([lTool()], [])).toEqual([]);
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
    // 70 mm plus twice the 0.5 mm default clearance and margins needs two
    // cells; the recentred outline lands the placement at the origin.
    expect(s.gridX).toBe(2);
    expect(s.gridY).toBe(1);
    expect(s.placements[0]).toEqual({ toolId: bar.id, xMm: 0, yMm: 0, pocketDepthMm: 20 });
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
    // Both new tools land at the origin, overlapping the L: the box spans
    // -35.5..35.5 with the bar's clearance, needing two cells, which the
    // derived footprint reports past the floor.
    expect(binPlacement(s).gridX).toBe(2);
  });

  it('re-sizes when a transform change swaps the layout axes', () => {
    const s = state([barTool()], [{ toolId: 'bar', xMm: 0, yMm: 0, pocketDepthMm: 5 }], {
      gridX: 2,
    });
    setToolTransform(s, 'bar', { rotationDeg: 90 });
    expect(s.gridX).toBe(1);
    expect(s.gridY).toBe(2);
  });
});
