import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { componentVolumes } from '../helpers/components';
import {
  buildCutoutBinBody,
  isDraftAngleDegValid,
  placeCutter,
  prepareCutoutModel,
  sweepCutterUpward,
  validateDraftAngleDeg,
  type CutoutBinParams,
  type CutoutModelSpec,
  type ModelPlacement,
} from '../../src/engine/cutout/cutoutBin';
import { FLOOR_TOP, HEIGHT_UNIT } from '../../src/engine/gridfinity/constants';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

/** A placement at a point, with no rotation. */
function at(xMm: number, yMm: number, zMm: number): ModelPlacement {
  return { xMm, yMm, zMm, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 };
}

/** The shared 2x2x6 test bin. Its nominal top sits at 42 mm. */
function params(overrides: Partial<CutoutBinParams> = {}): CutoutBinParams {
  return {
    gridX: 2,
    gridY: 2,
    heightUnits: 6,
    magnetHoles: true,
    walls: [],
    labelSlot: true,
    insert: null,
    models: [],
    ...overrides,
  };
}

/** Nominal top of the shared test bin: 6 height units of 7 mm. */
const BODY_TOP = 6 * HEIGHT_UNIT;

/**
 * An inverted-T solid, the canonical undercut: a 20 x 20 x 5 base with an
 * 8 x 8 x 15 stem standing on it, 20 mm tall in total and centred on its own
 * bounding box exactly as the import stage centres a model. Any exact pocket
 * of it has a lip the base cannot pass on the way down.
 */
function invertedT(): Manifold {
  const base = m.Manifold.cube([20, 20, 5], true).translate(0, 0, -7.5);
  const stem = m.Manifold.cube([8, 8, 15], true).translate(0, 0, 2.5);
  const solid = m.Manifold.union([base, stem]);
  base.delete();
  stem.delete();
  return solid;
}

/** The import stage on a primitive, standing in for a parsed STL. */
function prepared(solid: Manifold, clearanceMm: number, name = 'part.stl'): Manifold {
  return prepareCutoutModel(m, solid, { name, unitScale: 1, clearanceMm }).solid;
}

/** A model spec around a prepared solid, sweep on by these tests' choice. */
function sweptSpec(
  solid: Manifold,
  placement: ModelPlacement,
  draftAngleDeg: number,
  clearanceMm: number,
  name = 'part.stl',
): CutoutModelSpec {
  return { name, solid, placement, clearanceMm, sweepEnabled: true, draftAngleDeg };
}

/** Intersection volume of a solid with an axis-aligned probe box. */
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

describe('sweepCutterUpward on an undercut', () => {
  // The inverted T centred at z = 20 spans z 10 to 30 in a bin whose interior
  // top is 42 mm, so its base plate sits well below the rim.
  const placement = at(0, 0, 20);

  it('leaves the exact cutter non-monotonic, which is what the sweep exists to fix', () => {
    // Discriminator: without it, the monotonicity assertion below would also
    // pass against an implementation that never swept anything.
    const solid = prepared(invertedT(), 0);
    const placedSolid = placeCutter(solid, placement);

    // Base plate slice (20 x 20 = 400) above stem slice (8 x 8 = 64): the
    // cross-section SHRINKS going up, so the base cannot pass the lip.
    const baseSlice = placedSolid.slice(12);
    const stemSlice = placedSolid.slice(25);
    expect(baseSlice.area()).toBeCloseTo(400, 6);
    expect(stemSlice.area()).toBeCloseTo(64, 6);

    baseSlice.delete();
    stemSlice.delete();
    placedSolid.delete();
    solid.delete();
  });

  it('makes every horizontal slice at least as wide as every slice below it', () => {
    const solid = prepared(invertedT(), 0);
    const swept = sweepCutterUpward(m, placeCutter(solid, placement), {
      heightUnits: 6,
      draftAngleDeg: 0,
      clearanceMm: 0,
    });

    // A ladder of heights from the base up past the stem to just under the
    // interior top. Monotone non-decreasing area is the insertability
    // property itself: nothing above is narrower than what has to pass it.
    const heights = [11, 15, 20, 25, 29, 35, 41];
    const areas = heights.map((z) => {
      const slice = swept.slice(z);
      const area = slice.area();
      slice.delete();
      return area;
    });
    for (let i = 1; i < areas.length; i += 1) {
      expect(areas[i]).toBeGreaterThanOrEqual(areas[i - 1] - 1e-6);
    }
    // And the base's own footprint is carried all the way up: the slice near
    // the top is at least the 400 mm2 of the base plate.
    expect(areas[areas.length - 1]).toBeGreaterThanOrEqual(400);

    swept.delete();
    solid.delete();
  });

  it('reaches past the nominal bin top from the derived length, at any bin height', () => {
    for (const heightUnits of [6, 9]) {
      const solid = prepared(invertedT(), 0);
      const swept = sweepCutterUpward(m, placeCutter(solid, placement), {
        heightUnits,
        draftAngleDeg: 0,
        clearanceMm: 0,
      });

      // The sweep must poke through the interior top rather than land flush
      // on it, whatever the height: the top comes from the derivation, not a
      // constant that happens to match one bin.
      expect(swept.boundingBox().max[2]).toBeGreaterThan(heightUnits * HEIGHT_UNIT);
      expect(swept.status()).toBe('NoError');

      swept.delete();
      solid.delete();
    }
  });
});

describe('a carved bin with the sweep on', () => {
  it('opens the pocket at the bin top above a model sunk below the rim', () => {
    // The same probe the exact-cutter suite proves CLOSED over a sunk model:
    // with the sweep on it must be open, because that opening is what lets
    // the object in and out at all.
    const solid = prepared(m.Manifold.cube([10, 10, 10], true), 0, 'sunk.stl');
    const models = [sweptSpec(solid, at(0, 5, 12), 0, 0, 'sunk.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(probeVolume(result.body, [0, 5, BODY_TOP - 0.5], [4, 4, 0.5])).toBe(0);
    // Sound geometry throughout, per the geometry integrity bar.
    expect(result.body.status()).toBe('NoError');
    expect(componentVolumes(result.body).solids).toHaveLength(1);

    result.body.delete();
    solid.delete();
  });

  it('keeps the column below the model closed: the sweep goes up, never down', () => {
    const solid = prepared(m.Manifold.cube([10, 10, 10], true), 0, 'sunk.stl');
    // Model spans z 12 to 22; the fill from the floor top (7 mm) up to it
    // must stay solid, or the pocket floor the object rests on is gone. The
    // probe spans z 8 to 11, wholly inside that band.
    const models = [sweptSpec(solid, at(0, 5, 17), 0, 0, 'sunk.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(probeVolume(result.body, [0, 5, FLOOR_TOP + 2.5], [4, 4, 3])).toBeCloseTo(48, 5);

    result.body.delete();
    solid.delete();
  });

  it('measures the footprint from the swept cutter, not the model', () => {
    // The readout must report the pocket the bin actually has. A 10 mm cube
    // at z centre 12 has its lowest point at 7 mm, and the swept cutter is
    // trimmed at the swept reach: the 42 mm nominal top plus the 4.4 mm lip
    // and the 0.01 mm weld overlap, 46.41 mm. So the pocket spans z 7 to
    // 46.41 (39.41 mm tall), and the segment's 0.01 mm half-width adds to
    // each side in plan. Hand-derived literals.
    const solid = prepared(m.Manifold.cube([10, 10, 10], true), 0, 'sunk.stl');
    const models = [sweptSpec(solid, at(0, 5, 12), 0, 0, 'sunk.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(result.footprints[0].sizeMm.x).toBeCloseTo(10.02, 6);
    expect(result.footprints[0].sizeMm.y).toBeCloseTo(10.02, 6);
    expect(result.footprints[0].sizeMm.z).toBeCloseTo(39.41, 6);

    result.body.delete();
    solid.delete();
  });
});

describe('the draft angle', () => {
  it('flares the swept walls outward by tan(angle) times the sweep length', () => {
    // A 10 mm cube centred at z 12 has its lowest point at 7 mm, and the
    // swept cutter is trimmed at the 46.41 mm swept reach, so the widest
    // slice is the trim plane, 39.41 mm above the lowest point. At 45 degrees
    // the wall stands off by that climb plus the 0.01 mm base half-width, and
    // the cone's facet vertices land on the axes, so the swept width along X
    // is exactly 10 + 2 * (0.01 + 39.41) = 88.84 mm. Hand-derived literal.
    const solid = prepared(m.Manifold.cube([10, 10, 10], true), 0);
    const swept = sweepCutterUpward(m, placeCutter(solid, at(0, 0, 12)), {
      heightUnits: 6,
      draftAngleDeg: 45,
      clearanceMm: 0,
    });

    const box = swept.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(88.84, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(88.84, 6);
    expect(swept.status()).toBe('NoError');

    swept.delete();
    solid.delete();
  });

  it('does not flare at 0 degrees beyond the weld-scale operand width', () => {
    const solid = prepared(m.Manifold.cube([10, 10, 10], true), 0);
    const swept = sweepCutterUpward(m, placeCutter(solid, at(0, 0, 12)), {
      heightUnits: 6,
      draftAngleDeg: 0,
      clearanceMm: 0,
    });

    // 10 mm plus twice the 0.01 mm segment half-width, and nothing more.
    const box = swept.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(10.02, 6);

    swept.delete();
    solid.delete();
  });
});

describe('the sweep is not rotation invariant', () => {
  it('differs between sweeping the rotated model and rotating the swept one', () => {
    // The geometric fact the whole pipeline placement rests on: the sweep
    // points along world Z, so it cannot be cached in the model's own frame
    // and reused across rotations the way the isotropic clearance sphere is.
    // Both solids here sit centred at (0, 0, 20) with the same bounds, so a
    // rotation-invariant sweep would make them identical.
    const rotation: ModelPlacement = { ...at(0, 0, 20), rotXDeg: 90 };
    const spec = { heightUnits: 6, draftAngleDeg: 0, clearanceMm: 0 };

    const solidA = prepared(invertedT(), 0);
    const sweptRotated = sweepCutterUpward(m, placeCutter(solidA, rotation), spec);

    const solidB = prepared(invertedT(), 0);
    const rotatedSwept = sweepCutterUpward(m, placeCutter(solidB, at(0, 0, 20)), spec)
      // Rotate about the model's own centre, as a cached swept solid would be.
      .translate([0, 0, -20])
      .rotate([90, 0, 0])
      .translate([0, 0, 20]);

    const extra = sweptRotated.subtract(rotatedSwept);
    const missing = rotatedSwept.subtract(sweptRotated);
    // The upward columns of the base plate alone differ by thousands of mm3;
    // 1000 is a comfortable floor that still fails hard on equal solids.
    expect(extra.volume() + missing.volume()).toBeGreaterThan(1000);

    for (const part of [extra, missing, sweptRotated, rotatedSwept]) part.delete();
    solidA.delete();
    solidB.delete();
  });
});

describe('the draft angle bound', () => {
  it('accepts 0 and values up to but not including 90 degrees', () => {
    expect(isDraftAngleDegValid(0)).toBe(true);
    expect(isDraftAngleDegValid(45)).toBe(true);
    expect(isDraftAngleDegValid(89.9)).toBe(true);
  });

  it('rejects 90, negatives and non-finite values', () => {
    expect(isDraftAngleDegValid(90)).toBe(false);
    expect(isDraftAngleDegValid(-0.1)).toBe(false);
    expect(isDraftAngleDegValid(Number.NaN)).toBe(false);
    expect(isDraftAngleDegValid(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('throws the user-worded sentence from the editor-facing validator', () => {
    expect(() => validateDraftAngleDeg(90)).toThrow(
      'The draft angle must be a number from 0 up to but not including 90 degrees.',
    );
    expect(() => validateDraftAngleDeg(45)).not.toThrow();
  });
});
