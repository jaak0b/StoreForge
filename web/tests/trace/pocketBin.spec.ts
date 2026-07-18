import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Font } from 'opentype.js';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import {
  autoGridSize,
  buildPocketBinSolids,
  maxPocketDepthMm,
  placeTools,
  validatePocketLayout,
} from '../../src/engine/trace/pocketBin';
import type { PocketBinParams } from '../../src/engine/trace/pocketBin';
import { buildBinManifold } from '../../src/engine/gridfinity/binGenerator';
import type { TracedTool, ToolPlacement } from '../../src/engine/trace/types';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

/**
 * L-shaped test tool, 30 mm wide by 25 mm tall with a 10 mm thick arm along
 * each leg, its bounding box spanning 0..30 by 0..25 in tool-local mm. The
 * outer loop is positively wound per the outline convention.
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

/** Centers the L tool's 30 x 25 bounding box on the bin origin. */
const centeredL: ToolPlacement = {
  toolId: 'l-tool',
  xMm: -15,
  yMm: -12.5,
  pocketDepthMm: 5,
};

function params(overrides: Partial<PocketBinParams> = {}): PocketBinParams {
  return {
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    stackingLip: false,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    labelText: '',
    labelText2: '',
    labelIcon: null,
    tools: [lTool()],
    placements: [centeredL],
    ...overrides,
  };
}

/** Intersection volume of the body with an axis-aligned probe box. */
function probeVolume(
  body: Manifold,
  center: [number, number, number],
  size: [number, number, number],
): number {
  const probe = m.Manifold.cube(size, true).translate(...center);
  const overlap = body.intersect(probe);
  const volume = overlap.volume();
  probe.delete();
  overlap.delete();
  return volume;
}

describe('buildPocketBinSolids', () => {
  it('produces a watertight solid for a 2x1 bin with an L pocket and finger hole', () => {
    const tool = lTool({
      // Finger hole overhanging the bottom arm of the L, tool-local.
      fingerHoles: [{ x: 20, y: 5, diameterMm: 12 }],
    });
    const { body, label } = buildPocketBinSolids(m, font, params({ tools: [tool] }));
    expect(body.status()).toBe('NoError');
    expect(body.isEmpty()).toBe(false);
    expect(label).toBeNull();
    body.delete();
  });

  it('produces a watertight solid when a finger hole is an elongated slot', () => {
    const tool = lTool({
      // Slot along the bottom arm, tool-local, from (5, 5) to (25, 5).
      fingerHoles: [{ x: 5, y: 5, x2: 25, y2: 5, diameterMm: 8 }],
    });
    const { body } = buildPocketBinSolids(m, font, params({ tools: [tool] }));
    expect(body.status()).toBe('NoError');
    expect(body.isEmpty()).toBe(false);
    body.delete();
  });

  it('rejects a slot finger hole whose far end reaches into the bin wall', () => {
    // The slot's second endpoint lands at bin-local x 65; with its 6 mm
    // radius it reaches far past the 2x1 interior's 40.8 mm half-width.
    const tool = lTool({
      fingerHoles: [{ x: 20, y: 5, x2: 80, y2: 5, diameterMm: 12 }],
    });
    expect(() => buildPocketBinSolids(m, font, params({ tools: [tool] }))).toThrow(
      /into the bin wall/,
    );
  });

  it('places the pocket bottom exactly at the bin top minus the pocket depth', () => {
    // heightUnits 3 puts the bin top at 21 mm; a 5 mm pocket bottoms at 16 mm.
    const { body } = buildPocketBinSolids(m, font, params());
    // Probe XY (-10, -8.5) lies inside the L's bottom arm.
    const above = probeVolume(body, [-10, -8.5, 16.3], [2, 2, 0.5]);
    const below = probeVolume(body, [-10, -8.5, 15.7], [2, 2, 0.5]);
    expect(above).toBe(0);
    expect(below).toBeCloseTo(2, 5);
    body.delete();
  });

  it('keeps the floor plate solid under the pocket and under a finger hole', () => {
    const tool = lTool({ fingerHoles: [{ x: 20, y: 5, diameterMm: 12 }] });
    const { body } = buildPocketBinSolids(
      m,
      font,
      params({ tools: [tool], placements: [{ ...centeredL, pocketDepthMm: 14 }] }),
    );
    // The floor plate spans 4.8 to 7 mm. Probes centred at z 5.9 must come
    // back fully solid; the plate under pockets and finger holes is intact.
    expect(probeVolume(body, [-10, -8.5, 5.9], [2, 2, 1.5])).toBeCloseTo(6, 5);
    // Finger hole centre lands at bin-local (5, -7.5).
    expect(probeVolume(body, [5, -7.5, 5.9], [2, 2, 1.5])).toBeCloseTo(6, 5);
    // Directly above the floor top the finger hole is cut, even though the
    // pocket bottom (at 7 mm for a 14 mm pocket) coincides with it here.
    expect(probeVolume(body, [5, -7.5, 7.3], [2, 2, 0.5])).toBe(0);
    body.delete();
  });

  it('removes material compared to the same filled bin without pockets', () => {
    const { body } = buildPocketBinSolids(m, font, params());
    const { body: unpocketed } = buildPocketBinSolids(m, font, params({ placements: [] }));
    expect(body.volume()).toBeLessThan(unpocketed.volume());
    // The filled interior makes even the pocketed bin heavier than a plain
    // hollow bin of the same size.
    const plain = buildBinManifold(m, params());
    expect(body.volume()).toBeGreaterThan(plain.volume());
    body.delete();
    unpocketed.delete();
    plain.delete();
  });

  it('rejects a pocket deeper than the interior allows, naming the real limit', () => {
    // A 3 unit bin tops out at 21 mm and the floor top is at 7 mm: 14 mm max.
    expect(maxPocketDepthMm(3)).toBe(14);
    expect(() =>
      buildPocketBinSolids(
        m,
        font,
        params({ placements: [{ ...centeredL, pocketDepthMm: 15 }] }),
      ),
    ).toThrow(/at most 14 mm/);
  });

  it('rejects combining pockets with divider walls', () => {
    expect(() => buildPocketBinSolids(m, font, params({ dividerCountX: 1 }))).toThrow(
      /divider/i,
    );
  });

  it('rejects a pocket that reaches into the bin wall', () => {
    // A 2x1 bin's interior spans 81.6 mm; shifting the L 30 mm right pushes
    // its right edge past the wall.
    expect(() =>
      buildPocketBinSolids(m, font, params({ placements: [{ ...centeredL, xMm: 15 }] })),
    ).toThrow(/into the bin wall/);
  });

  it('rejects overlapping pockets', () => {
    const tools = [lTool(), lTool({ id: 'l-2', name: 'Second wrench' })];
    const placements: ToolPlacement[] = [
      centeredL,
      { toolId: 'l-2', xMm: -10, yMm: -12.5, pocketDepthMm: 5 },
    ];
    expect(() => buildPocketBinSolids(m, font, params({ tools, placements }))).toThrow(
      /overlap/,
    );
  });

  it('rejects a placement whose tool is missing from the plan', () => {
    expect(() =>
      buildPocketBinSolids(
        m,
        font,
        params({ placements: [{ ...centeredL, toolId: 'gone' }] }),
      ),
    ).toThrow(/no longer in the plan/);
  });
});

describe('validatePocketLayout', () => {
  it('accepts a valid layout without touching the solid pipeline', () => {
    const p = params();
    const placed = placeTools(m, p.tools, p.placements);
    expect(() => validatePocketLayout(m, p, placed)).not.toThrow();
  });
});

describe('autoGridSize', () => {
  it('fits the centred L tool with margin into a 1x1 bin with no offset', () => {
    expect(autoGridSize(m, [lTool()], [centeredL], 2)).toEqual({
      gridX: 1,
      gridY: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('sizes an off-centre tool from its bounding box and recentres it', () => {
    // The L's 30 x 25 box sits at bin-local 50..80 by 40..65: the box alone
    // (15 mm half-width plus the 2 mm margin) fits one cell's 19.8 mm
    // interior half-width, and the offset moves the box centre (65, 52.5)
    // onto the origin.
    const placement: ToolPlacement = { toolId: 'l-tool', xMm: 50, yMm: 40, pocketDepthMm: 5 };
    expect(autoGridSize(m, [lTool()], [placement], 2)).toEqual({
      gridX: 1,
      gridY: 1,
      offsetX: -65,
      offsetY: -52.5,
    });
  });

  it('sizes two off-centre tools from their combined box, not their distance from the origin', () => {
    // Two L tools whose boxes span bin-local 100..170 by 0..25: the 70 mm
    // combined width plus margins needs two cells' 81.6 mm interior, however
    // far from the origin the pair sits.
    const tools = [lTool(), lTool({ id: 'l-2', name: 'Second wrench' })];
    const placements: ToolPlacement[] = [
      { toolId: 'l-tool', xMm: 100, yMm: 0, pocketDepthMm: 5 },
      { toolId: 'l-2', xMm: 140, yMm: 0, pocketDepthMm: 5 },
    ];
    expect(autoGridSize(m, tools, placements, 2)).toEqual({
      gridX: 2,
      gridY: 1,
      offsetX: -135,
      offsetY: -12.5,
    });
  });

  it('grows along X for a wide tool', () => {
    // A 70 mm wide bar cannot fit one cell's 39.6 mm interior; two cells
    // give 81.6 mm.
    const bar = lTool({
      id: 'bar',
      name: 'Bar',
      outline: {
        outer: [
          { x: 0, y: 0 },
          { x: 70, y: 0 },
          { x: 70, y: 12 },
          { x: 0, y: 12 },
        ],
        holes: [],
      },
    });
    const placement: ToolPlacement = { toolId: 'bar', xMm: -35, yMm: -6, pocketDepthMm: 5 };
    expect(autoGridSize(m, [bar], [placement], 2)).toEqual({
      gridX: 2,
      gridY: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('includes a slot finger hole reaching past the outline in the box', () => {
    // The slot's far cap reaches bin-local x 31 (endpoint 25 plus the 6 mm
    // radius) and its underside dips to y -13.5, so the box spans -15..31 by
    // -13.5..12.5: 46 mm wide plus margins needs two cells, and the offset
    // recentres the box.
    const tool = lTool({
      fingerHoles: [{ x: 15, y: 5, x2: 40, y2: 5, diameterMm: 12 }],
    });
    expect(autoGridSize(m, [tool], [centeredL], 2)).toEqual({
      gridX: 2,
      gridY: 1,
      offsetX: -8,
      offsetY: 0.5,
    });
  });

  it('returns a size whose recentred layout passes the exact wall validation', () => {
    const tool = lTool({
      fingerHoles: [{ x: 15, y: 5, x2: 40, y2: 5, diameterMm: 12 }],
    });
    const size = autoGridSize(m, [tool], [centeredL], 2);
    const recentred: ToolPlacement = {
      ...centeredL,
      xMm: centeredL.xMm + size.offsetX,
      yMm: centeredL.yMm + size.offsetY,
    };
    const p = params({ gridX: size.gridX, gridY: size.gridY, tools: [tool], placements: [recentred] });
    expect(() => validatePocketLayout(m, p, placeTools(m, p.tools, p.placements))).not.toThrow();
    // The recentred layout is already centred: sizing it again moves nothing.
    const again = autoGridSize(m, [tool], [recentred], 2);
    expect(again).toEqual({ ...size, offsetX: 0, offsetY: 0 });
  });

  it('rejects overlapping placements', () => {
    const tools = [lTool(), lTool({ id: 'l-2', name: 'Second wrench' })];
    const placements: ToolPlacement[] = [
      centeredL,
      { toolId: 'l-2', xMm: -10, yMm: -12.5, pocketDepthMm: 5 },
    ];
    expect(() => autoGridSize(m, tools, placements, 2)).toThrow(/overlap/);
  });
});
