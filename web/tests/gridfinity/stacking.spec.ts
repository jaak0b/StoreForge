import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Font } from 'opentype.js';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import { buildFusedLabel } from '../../src/engine/label/slot';
import {
  buildBinManifold,
  buildInsertInSlotSolids,
  buildSlottedBinBody,
} from '../../src/engine/gridfinity/binGenerator';
import {
  heightUnitsForInteriorTopZ,
  interiorFeatureTopZ,
  STACK_SEAT_CLEARANCE_DROP,
  stackedFootSeatDepthMm,
} from '../../src/engine/gridfinity/constants';
import { evenDividerWalls } from '../../src/engine/gridfinity/dividerModel';
import { buildPocketBinBody } from '../../src/engine/trace/pocketBin';
import type { PocketBinParams } from '../../src/engine/trace/pocketBin';
import type { TracedTool } from '../../src/engine/trace/types';
import { buildCutoutBinBody, prepareCutoutModel } from '../../src/engine/cutout/cutoutBin';
import type { CutoutBinParams } from '../../src/engine/cutout/cutoutBin';
import type { InsertContentParams } from '../../src/engine/gridfinity/types';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

/**
 * Where the upper bin of a stack of two 3-unit bins comes to rest: the 21 mm
 * nominal top less the seat depth. 0.2464 mm was found by bisecting the
 * overlap of two plain 1x1x3 bins on the original geometry: zero overlap at a
 * 0.2464 mm sink, 1.5e-4 mm^3 at 0.2465 mm. It agrees with the analytic
 * 0.6 - 0.25 * sqrt(2) = 0.24645 mm because the 45-degree corner sample, where
 * contact happens, is a vertex of both faceted outlines.
 */
const SEATED_Z_3U = 20.7536;

/** A text-only label content, the same shape the preview hands the worker. */
const M3_LABEL: InsertContentParams = { text: 'M3x20', text2: 'FHCS', icon: null };

/**
 * Overlap volume between the upper bin's body and every lower solid, with the
 * upper bin seated at SEATED_Z_3U. Manifold's boolean is exact on solids that
 * only touch, so a clean stack comes back empty, not just small: the 1e-9 mm^3
 * bound is float noise on an empty result, far below the 1.5e-4 mm^3 a
 * 0.0001 mm overlap already produces.
 */
function seatedOverlapMm3(upperBody: Manifold, lower: Manifold[]): number {
  const upper = upperBody.translate(0, 0, SEATED_Z_3U);
  let total = 0;
  for (const solid of lower) {
    const overlap = upper.intersect(solid);
    total += overlap.volume();
    overlap.delete();
  }
  upper.delete();
  return total;
}

/** One-arm L tool, 30 x 22 mm, the shape the pocket bin tests use. */
function lTool(): TracedTool {
  return {
    id: 'l-tool',
    name: 'L wrench',
    parts: [
      {
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
    ],
    rotationDeg: 0,
    offsetMm: 0,
    mirrored: false,
    minHoleWidthMm: 0,
    filledHoles: [],
    fingerHoles: [],
    source: { kind: 'primitive' },
  };
}

function pocketParams(overrides: Partial<PocketBinParams> = {}): PocketBinParams {
  return {
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
    labelSlot: true,
    insert: null,
    tools: [lTool()],
    placements: [{ toolId: 'l-tool', xMm: -15, yMm: -5.1, pocketDepthMm: 5, draftAngleDeg: 0 }],
    ...overrides,
  };
}

function cutoutParams(overrides: Partial<CutoutBinParams> = {}): CutoutBinParams {
  const solid = prepareCutoutModel(m, m.Manifold.cube([10, 10, 10], true), {
    name: 'cube.stl',
    unitScale: 1,
    clearanceMm: 0.2,
  }).solid;
  return {
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
    labelSlot: true,
    insert: null,
    models: [
      {
        name: 'cube.stl',
        solid,
        // Cube top flush with the 20.6 mm fill top, so the pocket opens there.
        placement: { xMm: 0, yMm: 5, zMm: 15.6, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 },
        clearanceMm: 0.2,
        sweepEnabled: false,
        draftAngleDeg: 0,
      },
    ],
    ...overrides,
  };
}

describe('stackedFootSeatDepthMm', () => {
  it('matches the seat depth found by bisection on two stacked plain bins', () => {
    expect(Math.abs(stackedFootSeatDepthMm() - 0.246)).toBeLessThan(0.005);
  });

  it('stays shallower than the clearance drop of the features inside the lip', () => {
    // A future lip or foot profile change that deepens the seat past the drop
    // must fail here rather than print bins that collide when stacked.
    expect(STACK_SEAT_CLEARANCE_DROP).toBeGreaterThanOrEqual(stackedFootSeatDepthMm());
  });
});

describe('interiorFeatureTopZ', () => {
  it('lowers the nominal top of a 3-unit bin from 21 mm to 20.6 mm', () => {
    expect(interiorFeatureTopZ(3)).toBeCloseTo(20.6, 9);
  });

  it('picks the fewest whole units whose feature top reaches a height', () => {
    expect(heightUnitsForInteriorTopZ(13.6)).toBe(2);
    expect(heightUnitsForInteriorTopZ(13.7)).toBe(3);
    expect(heightUnitsForInteriorTopZ(14)).toBe(3);
    expect(heightUnitsForInteriorTopZ(1)).toBe(2);
  });
});

describe('two stacked bins', () => {
  it('collide once the upper foot sinks 0.01 mm past the seat, so the seat is tight', () => {
    const lower = buildBinManifold(m, {
      gridX: 1,
      gridY: 1,
      heightUnits: 3,
      magnetHoles: false,
      walls: [],
    });
    const upper = lower.translate(0, 0, SEATED_Z_3U - 0.01);
    const overlap = upper.intersect(lower);
    expect(overlap.volume()).toBeGreaterThan(1e-3);
    overlap.delete();
    upper.delete();
    lower.delete();
  });

  it.each([
    [1, 1],
    [2, 1],
  ])('do not touch for a %ix%i plain bin without a slot', (gridX, gridY) => {
    const lower = buildSlottedBinBody(m, {
      gridX,
      gridY,
      heightUnits: 3,
      magnetHoles: false,
      walls: [],
      labelSlot: false,
    });
    expect(seatedOverlapMm3(lower, [lower])).toBeLessThan(1e-9);
    lower.delete();
  });

  it.each([
    [1, 1],
    [2, 1],
  ])('do not touch for a %ix%i bin with an empty label slot', (gridX, gridY) => {
    const lower = buildSlottedBinBody(m, {
      gridX,
      gridY,
      heightUnits: 3,
      magnetHoles: false,
      walls: [],
      labelSlot: true,
    });
    expect(lower.status()).toBe('NoError');
    expect(lower.genus()).toBe(0);
    expect(seatedOverlapMm3(lower, [lower])).toBeLessThan(1e-9);
    lower.delete();
  });

  it.each([
    [1, 1],
    [2, 1],
  ])('do not touch for a %ix%i bin with its label insert in the slot', (gridX, gridY) => {
    const bin = { gridX, gridY, heightUnits: 3, magnetHoles: false, walls: [] };
    const lower = buildSlottedBinBody(m, { ...bin, labelSlot: true });
    const { plate, label } = buildInsertInSlotSolids(m, font, M3_LABEL, bin);
    expect(label).not.toBeNull();
    expect(seatedOverlapMm3(lower, [lower, plate, label!])).toBeLessThan(1e-9);
    lower.delete();
    plate.delete();
    label!.delete();
  });

  it('do not touch for a bin with a fused label', () => {
    const params = {
      gridX: 1,
      gridY: 1,
      heightUnits: 3,
      magnetHoles: false,
      walls: [],
      labelSlot: false,
      fusedLabel: M3_LABEL,
    };
    const lower = buildSlottedBinBody(m, params);
    const label = buildFusedLabel(m, font, { text: 'M3x20', text2: 'FHCS', icon: null }, params);
    expect(lower.status()).toBe('NoError');
    expect(label).not.toBeNull();
    expect(seatedOverlapMm3(lower, [lower, label!])).toBeLessThan(1e-9);
    lower.delete();
    label!.delete();
  });

  it('do not touch for a bin with divider walls', () => {
    const lower = buildSlottedBinBody(m, {
      gridX: 2,
      gridY: 1,
      heightUnits: 3,
      magnetHoles: false,
      walls: evenDividerWalls(2, 1, 1, 1),
      labelSlot: false,
    });
    expect(lower.status()).toBe('NoError');
    expect(seatedOverlapMm3(lower, [lower])).toBeLessThan(1e-9);
    lower.delete();
  });

  it('do not touch for a traced pocket bin with its insert in the slot', () => {
    const params = pocketParams();
    const lower = buildPocketBinBody(m, params);
    const { plate, label } = buildInsertInSlotSolids(m, font, M3_LABEL, params);
    expect(lower.status()).toBe('NoError');
    expect(seatedOverlapMm3(lower, [lower, plate, label!])).toBeLessThan(1e-9);
    lower.delete();
    plate.delete();
    label!.delete();
  });

  it('do not touch for a traced pocket bin with a fused label', () => {
    const params = pocketParams({ labelSlot: false, fusedLabel: M3_LABEL });
    const lower = buildPocketBinBody(m, params);
    const label = buildFusedLabel(m, font, { text: 'M3x20', text2: 'FHCS', icon: null }, params);
    expect(lower.status()).toBe('NoError');
    expect(seatedOverlapMm3(lower, [lower, label!])).toBeLessThan(1e-9);
    lower.delete();
    label!.delete();
  });

  it('do not touch for a cutout bin', () => {
    const params = cutoutParams();
    const { body: lower } = buildCutoutBinBody(m, params);
    expect(lower.status()).toBe('NoError');
    expect(seatedOverlapMm3(lower, [lower])).toBeLessThan(1e-9);
    lower.delete();
    params.models[0].solid.delete();
  });
});

describe('a carved bin with a fused label', () => {
  it('leaves the label face as uncovered as on the plain bin', () => {
    // The fill stands higher than the fused shelf top, so the carve must open
    // the label field again: the label may only overlap the body by its weld
    // into the shelf, exactly as much as on a plain fused bin.
    const plainParams = {
      gridX: 2,
      gridY: 1,
      heightUnits: 3,
      magnetHoles: false,
      walls: [],
      labelSlot: false,
      fusedLabel: M3_LABEL,
    };
    const plain = buildSlottedBinBody(m, plainParams);
    const carvedParams = pocketParams({ labelSlot: false, fusedLabel: M3_LABEL });
    const carved = buildPocketBinBody(m, carvedParams);
    const spec = { text: 'M3x20', text2: 'FHCS', icon: null };
    const label = buildFusedLabel(m, font, spec, plainParams)!;
    const plainWeld = label.intersect(plain);
    const carvedWeld = label.intersect(carved);
    expect(carvedWeld.volume()).toBeCloseTo(plainWeld.volume(), 6);
    plainWeld.delete();
    carvedWeld.delete();
    label.delete();
    plain.delete();
    carved.delete();
  });
});
