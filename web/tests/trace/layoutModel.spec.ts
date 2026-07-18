import { describe, expect, it } from 'vitest';
import {
  addTool,
  dropTool,
  moveTool,
  removeTool,
  requiredFootprint,
  setGridManually,
  setToolTransform,
  type LayoutState,
} from '../../src/engine/trace/layoutModel';
import type { TracedTool, ToolPlacement } from '../../src/engine/trace/types';

// Hand-derived interior figures used throughout (margin 2 mm everywhere):
// one cell's interior is 39.6 mm, so the margin line sits at +-17.8 mm;
// two cells give 81.6 mm, margin line +-38.8 mm.

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

/** Centers the L tool's 30 x 25 bounding box on the bin origin. */
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

describe('requiredFootprint', () => {
  it('fits the centred L tool with margin into a 1x1 bin with no offset', () => {
    expect(requiredFootprint([lTool()], [centeredL], 2)).toEqual({
      gridX: 1,
      gridY: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('grows along X for a wide tool', () => {
    // The 70 mm bar cannot fit one cell's 39.6 mm interior; two cells
    // give 81.6 mm, inside which the centred bar fits with no shift.
    const placement: ToolPlacement = { toolId: 'bar', xMm: 0, yMm: 0, pocketDepthMm: 5 };
    expect(requiredFootprint([barTool()], [placement], 2)).toEqual({
      gridX: 2,
      gridY: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('grows the bounds by exactly the clearance per side', () => {
    // The L's box at xMm -12 spans -12..18; a 1 mm clearance widens it to
    // -13..19, poking 1.2 mm past the 17.8 mm margin line, so the minimal
    // shift is exactly -1.2 (it would be -0.2 without the clearance growth).
    const placement: ToolPlacement = { toolId: 'l-tool', xMm: -12, yMm: -12.5, pocketDepthMm: 5 };
    const size = requiredFootprint([lTool({ offsetMm: 1 })], [placement], 2);
    expect(size.gridX).toBe(1);
    expect(size.gridY).toBe(1);
    expect(size.offsetX).toBeCloseTo(-1.2, 9);
    expect(size.offsetY).toBeCloseTo(0, 9);
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

  it('includes a slot finger hole reaching past the outline in the box', () => {
    // The slot's far cap reaches bin-local x 31 (endpoint 25 plus the 6 mm
    // radius) and its underside dips to y -13.5, so the box spans -15..31
    // by -13.5..12.5: 46 mm wide plus margins needs two cells, inside
    // whose 81.6 mm interior the box already fits where it lies.
    const tool = lTool({
      fingerHoles: [{ x: 15, y: 5, x2: 40, y2: 5, diameterMm: 12 }],
    });
    expect(requiredFootprint([tool], [centeredL], 2)).toEqual({
      gridX: 2,
      gridY: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('rejects sizing an empty layout with a user-worded message', () => {
    expect(() => requiredFootprint([], [], 2)).toThrow(/at least one tool/);
  });
});

describe('dropTool', () => {
  it('re-sizes the footprint and shifts a far-out layout minimally', () => {
    // The L's box at (50, 40) spans 50..80 by 40..65, far outside one
    // cell. The minimal shift drags its max corner back to the 17.8 mm
    // margin line: offsetX 17.8 - 80 = -62.2, offsetY 17.8 - 65 = -47.2,
    // landing the placement at (-12.2, -7.2).
    const s = state(
      [lTool()],
      [{ toolId: 'l-tool', xMm: 50, yMm: 40, pocketDepthMm: 5 }],
      { gridX: 3, gridY: 3, gridManual: true },
    );
    dropTool(s);
    expect(s.gridManual).toBe(false);
    expect(s.gridX).toBe(1);
    expect(s.gridY).toBe(1);
    expect(s.placements[0].xMm).toBeCloseTo(-12.2, 9);
    expect(s.placements[0].yMm).toBeCloseTo(-7.2, 9);
  });

  it('discards a typed footprint', () => {
    const s = state([lTool()], [centeredL]);
    expect(setGridManually(s, 'x', 4)).toBe(4);
    expect(s.gridManual).toBe(true);
    expect(s.gridX).toBe(4);
    dropTool(s);
    expect(s.gridManual).toBe(false);
    expect(s.gridX).toBe(1);
    expect(s.gridY).toBe(1);
  });

  it('is idempotent: dropping twice changes nothing further', () => {
    const s = state(
      [lTool()],
      [{ toolId: 'l-tool', xMm: 50, yMm: 40, pocketDepthMm: 5 }],
    );
    dropTool(s);
    const once = JSON.parse(JSON.stringify(s)) as LayoutState;
    dropTool(s);
    expect(JSON.parse(JSON.stringify(s))).toEqual(once);
  });
});

describe('moveTool', () => {
  it('moves the placement and never re-sizes or shifts', () => {
    const s = state([lTool()], [centeredL]);
    moveTool(s, 'l-tool', 100, 0);
    expect(s.gridX).toBe(1);
    expect(s.gridY).toBe(1);
    expect(s.gridManual).toBe(false);
    expect(s.placements[0].xMm).toBe(100);
    expect(s.placements[0].yMm).toBe(0);
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

  it('keeps a manual footprint when a tool is added', () => {
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
