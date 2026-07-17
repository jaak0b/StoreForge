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
  it('fits the centred L tool with margin into a 1x1 bin', () => {
    expect(autoGridSize(m, [lTool()], [centeredL], 2)).toEqual({ gridX: 1, gridY: 1 });
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
    expect(autoGridSize(m, [bar], [placement], 2)).toEqual({ gridX: 2, gridY: 1 });
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
