import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Font } from 'opentype.js';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import {
  buildPocketBinBody,
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
  void font;
});

/**
 * L-shaped test tool, 30 mm wide by 22 mm tall with a 10 mm thick arm along
 * each leg, its bounding box spanning 0..30 by 0..22 in tool-local mm. The
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
        { x: 10, y: 22 },
        { x: 0, y: 22 },
      ],
      holes: [],
    },
    rotationDeg: 0,
    offsetMm: 0,
    mirrored: false,
    minHoleWidthMm: 0,
    filledHoleIndices: [],
    clicks: [],
    fingerHoles: [],
    ...overrides,
  };
}

/**
 * A 30 x 22 rectangular plate tool with one 6 mm square through-hole centred
 * at tool-local (15, 11). Left standing, the hole is an island in the pocket
 * floor; filling it cuts the island away.
 */
function holedPlate(overrides: Partial<TracedTool> = {}): TracedTool {
  return lTool({
    id: 'plate',
    name: 'Holed plate',
    outline: {
      outer: [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 22 },
        { x: 0, y: 22 },
      ],
      holes: [
        [
          { x: 12, y: 8 },
          { x: 12, y: 14 },
          { x: 18, y: 14 },
          { x: 18, y: 8 },
        ],
      ],
    },
    ...overrides,
  });
}

/**
 * Centers the L tool's 30 x 22 bounding box on the bin's X axis, and keeps it
 * clear of the label insert slot along the front wall (every bin has the slot
 * now, and the channel starts behind the stacking lip, so the protected strip
 * reaches back to y -5.15 on this bin).
 */
const centeredL: ToolPlacement = {
  toolId: 'l-tool',
  xMm: -15,
  yMm: -5.1,
  pocketDepthMm: 5,
};

function params(overrides: Partial<PocketBinParams> = {}): PocketBinParams {
  return {
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
    insert: null,
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

describe('buildPocketBinBody', () => {
  it('produces a watertight solid for a 2x1 bin with an L pocket and finger hole', () => {
    const tool = lTool({
      // Finger hole overhanging the bottom arm of the L, tool-local.
      fingerHoles: [{ x: 20, y: 6.5, diameterMm: 12 }],
    });
    const body = buildPocketBinBody(m, params({ tools: [tool] }));
    expect(body.status()).toBe('NoError');
    expect(body.isEmpty()).toBe(false);
    body.delete();
  });

  it('produces a watertight solid when a finger hole is an elongated slot', () => {
    const tool = lTool({
      // Slot along the bottom arm, tool-local, from (5, 5) to (25, 5).
      fingerHoles: [{ x: 5, y: 5, x2: 25, y2: 5, diameterMm: 8 }],
    });
    const body = buildPocketBinBody(m, params({ tools: [tool] }));
    expect(body.status()).toBe('NoError');
    expect(body.isEmpty()).toBe(false);
    body.delete();
  });

  it('rejects a slot finger hole whose far end reaches into the bin wall', () => {
    // The slot's second endpoint lands at bin-local x 65; with its 6 mm
    // radius it reaches far past the 2x1 interior's 40.8 mm half-width.
    const tool = lTool({
      fingerHoles: [{ x: 20, y: 6.5, x2: 80, y2: 6.5, diameterMm: 12 }],
    });
    expect(() => buildPocketBinBody(m, params({ tools: [tool] }))).toThrow(/into the bin wall/);
  });

  it('places the pocket bottom exactly at the bin top minus the pocket depth', () => {
    // heightUnits 3 puts the bin top at 21 mm; a 5 mm pocket bottoms at 16 mm.
    const body = buildPocketBinBody(m, params());
    // Probe XY (-10, -1.5) lies inside the L's bottom arm.
    const above = probeVolume(body, [-10, -1.5, 16.3], [2, 2, 0.5]);
    const below = probeVolume(body, [-10, -1.5, 15.7], [2, 2, 0.5]);
    expect(above).toBe(0);
    expect(below).toBeCloseTo(2, 5);
    body.delete();
  });

  it('keeps the floor plate solid under the pocket and under a finger hole', () => {
    const tool = lTool({ fingerHoles: [{ x: 20, y: 6.5, diameterMm: 12 }] });
    const body = buildPocketBinBody(
      m,
      params({ tools: [tool], placements: [{ ...centeredL, pocketDepthMm: 14 }] }),
    );
    // The floor plate spans 4.8 to 7 mm. Probes centred at z 5.9 must come
    // back fully solid; the plate under pockets and finger holes is intact.
    expect(probeVolume(body, [-10, -1.5, 5.9], [2, 2, 1.5])).toBeCloseTo(6, 5);
    // Finger hole centre lands at bin-local (5, 1.4).
    expect(probeVolume(body, [5, 1.4, 5.9], [2, 2, 1.5])).toBeCloseTo(6, 5);
    // Directly above the floor top the finger hole is cut, even though the
    // pocket bottom (at 7 mm for a 14 mm pocket) coincides with it here.
    expect(probeVolume(body, [5, 1.4, 7.3], [2, 2, 0.5])).toBe(0);
    body.delete();
  });

  it('removes material compared to the same filled bin without pockets', () => {
    const body = buildPocketBinBody(m, params());
    const unpocketed = buildPocketBinBody(m, params({ placements: [] }));
    expect(body.volume()).toBeLessThan(unpocketed.volume());
    // The filled interior makes even the pocketed bin heavier than a plain
    // hollow bin of the same size.
    const { insert: _insert, tools: _tools, placements: _placements, ...binParams } = params();
    void _insert;
    void _tools;
    void _placements;
    const plain = buildBinManifold(m, binParams);
    expect(body.volume()).toBeGreaterThan(plain.volume());
    body.delete();
    unpocketed.delete();
    plain.delete();
  });

  it('is unaffected by the interior scoop: pockets reach the back wall cleanly', () => {
    // Standard bins carry the scoop fillet against the back (+Y) wall, which
    // for this 2x1 bin fills the corner around the arc centred at y 9.8,
    // z 17. Pocket bins skip it: a full-depth pocket whose arm runs back into
    // that corner (tool-local y 0..22 placed at yMm -5.1 reaches y 16.9)
    // bottoms out flat at the floor top with no fillet intruding.
    const body = buildPocketBinBody(
      m,
      params({ placements: [{ ...centeredL, pocketDepthMm: 14 }] }),
    );
    // Inside the pocket, where the scoop fillet would be solid (11.4 mm from
    // the would-be fillet centre at y 9.8, z 17, outside its radius): air.
    expect(probeVolume(body, [-10, 16.2, 7.5], [2, 1, 0.5])).toBe(0);
    // The plain bin generator does place scoop material there.
    const { insert: _i, tools: _t, placements: _p, ...binParams } = params();
    void _i;
    void _t;
    void _p;
    const plain = buildBinManifold(m, binParams);
    const scooped = m.Manifold.cube([2, 1, 0.5], true).translate(-10, 16.2, 7.5);
    const hit = plain.intersect(scooped);
    expect(hit.volume()).toBeCloseTo(2 * 1 * 0.5, 3);
    hit.delete();
    scooped.delete();
    plain.delete();
    body.delete();
  });

  it('rejects a pocket deeper than the interior allows, naming the real limit', () => {
    // A 3 unit bin tops out at 21 mm and the floor top is at 7 mm: 14 mm max.
    expect(maxPocketDepthMm(3)).toBe(14);
    expect(() =>
      buildPocketBinBody(m, params({ placements: [{ ...centeredL, pocketDepthMm: 15 }] })),
    ).toThrow(/at most 14 mm/);
  });

  it('keeps an unfilled hole as an island in the placed pocket outline', () => {
    const [placed] = placeTools(m, [holedPlate()], [{ ...centeredL, toolId: 'plate' }]);
    expect(placed.outline.holes).toHaveLength(1);
  });

  it('drops a manually filled hole from the placed pocket outline', () => {
    const tool = holedPlate({ filledHoleIndices: [0] });
    const [placed] = placeTools(m, [tool], [{ ...centeredL, toolId: 'plate' }]);
    expect(placed.outline.holes).toHaveLength(0);
  });

  it('cuts away the island of a filled hole so the pocket floor is clear there', () => {
    // Bin top 21 mm, a 5 mm pocket bottoms at 16 mm. Tool-local hole centre
    // (15, 11) maps to bin-local (0, 5.9). Left standing, that column stays
    // solid up to the bin top; filling the hole cuts it to the pocket floor.
    const standing = buildPocketBinBody(
      m,
      params({ tools: [holedPlate()], placements: [{ ...centeredL, toolId: 'plate' }] }),
    );
    const filled = buildPocketBinBody(
      m,
      params({
        tools: [holedPlate({ filledHoleIndices: [0] })],
        placements: [{ ...centeredL, toolId: 'plate' }],
      }),
    );
    expect(probeVolume(standing, [0, 5.9, 18], [2, 2, 2])).toBeCloseTo(8, 5);
    expect(probeVolume(filled, [0, 5.9, 18], [2, 2, 2])).toBe(0);
    standing.delete();
    filled.delete();
  });

  it('rejects combining pockets with divider walls', () => {
    expect(() =>
      buildPocketBinBody(m, params({ walls: [{ x1: 0, y1: -5, x2: 0, y2: 5 }] })),
    ).toThrow(/divider/i);
  });

  it('rejects a pocket that reaches into the bin wall', () => {
    // A 2x1 bin's interior spans 81.6 mm; shifting the L 30 mm right pushes
    // its right edge past the wall.
    expect(() =>
      buildPocketBinBody(m, params({ placements: [{ ...centeredL, xMm: 15 }] })),
    ).toThrow(/into the bin wall/);
  });

  it('rejects overlapping pockets', () => {
    const tools = [lTool(), lTool({ id: 'l-2', name: 'Second wrench' })];
    const placements: ToolPlacement[] = [
      centeredL,
      { toolId: 'l-2', xMm: -10, yMm: -5.1, pocketDepthMm: 5 },
    ];
    expect(() => buildPocketBinBody(m, params({ tools, placements }))).toThrow(/overlap/);
  });

  it('rejects a placement whose tool is missing from the plan', () => {
    expect(() =>
      buildPocketBinBody(m, params({ placements: [{ ...centeredL, toolId: 'gone' }] })),
    ).toThrow(/no longer in the plan/);
  });

  it('rejects a pocket that reaches under the label insert slot', () => {
    // The slot-strip restriction now always applies, since every bin has the
    // insert slot: a pocket placed at the bin's geometric centre (the old
    // default before the slot existed) now clips the slot along the front
    // wall.
    expect(() =>
      buildPocketBinBody(m, params({ placements: [{ ...centeredL, yMm: -12.5 }] })),
    ).toThrow(/label insert slot/);
  });
});

describe('validatePocketLayout', () => {
  it('accepts a layout kept clear of the label insert slot', () => {
    const p = params();
    const placed = placeTools(m, p.tools, p.placements);
    expect(() => validatePocketLayout(m, p, placed)).not.toThrow();
  });

  it('rejects a layout whose pocket reaches under the label insert slot', () => {
    const p = params({ placements: [{ ...centeredL, yMm: -12.5 }] });
    const placed = placeTools(m, p.tools, p.placements);
    expect(() => validatePocketLayout(m, p, placed)).toThrow(/label insert slot/);
  });

  it('rejects a pocket that clears the end stop but cuts the shelf back chamfer', () => {
    // The protected strip reaches to the shelf plate's 45 degree back
    // chamfer, one 1.0 mm plate thickness behind the channel's back edge
    // (measured on the reference 1x1x6 mesh, chamfer top y 26.15 against the
    // stop base's back at 26.25), 0.1 mm deeper than the end stop base. On
    // this 2x1 bin the strip ends at y -5.15; a pocket starting at y -5.24
    // clears the stop-depth strip alone (which would end at -5.25) but shaves
    // the chamfer, and one starting at y -5.1 is fine.
    const rejected = params({ placements: [{ ...centeredL, yMm: -5.24 }] });
    const placedRejected = placeTools(m, rejected.tools, rejected.placements);
    expect(() => validatePocketLayout(m, rejected, placedRejected)).toThrow(
      /label insert slot/,
    );
    const accepted = params({ placements: [{ ...centeredL, yMm: -5.1 }] });
    const placedAccepted = placeTools(m, accepted.tools, accepted.placements);
    expect(() => validatePocketLayout(m, accepted, placedAccepted)).not.toThrow();
  });
});
