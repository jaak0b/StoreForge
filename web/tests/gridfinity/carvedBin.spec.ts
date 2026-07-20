import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { componentVolumes } from '../helpers/components';
import {
  buildCarvedBinBody,
  buildInteriorFill,
  CARVE_OVERLAP_EPS,
  interiorSection,
  labelStructureStrip,
  maxCarveDepthMm,
} from '../../src/engine/gridfinity/carvedBin';
import type { CarvedBinParams } from '../../src/engine/gridfinity/carvedBin';
import { buildSlottedBinBody } from '../../src/engine/gridfinity/binGenerator';
import {
  binInteriorSizeMm,
  binOuterSizeMm,
  FLOOR_TOP,
  HEIGHT_UNIT,
} from '../../src/engine/gridfinity/constants';
import {
  FUSED_SHELF_REACH_DEPTH,
  SLOT_DEPTH,
  SLOT_FRONT_INSET,
  SLOT_HEIGHT,
  SLOT_REACH_DEPTH,
} from '../../src/engine/label/slot';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

/**
 * A 2x1x3 bin with magnet holes. The holes are on deliberately: they are the
 * legitimate exception to "nothing below the container floor", so every
 * differential base comparison here exercises them rather than avoiding them.
 */
function params(overrides: Partial<CarvedBinParams> = {}): CarvedBinParams {
  return {
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: true,
    walls: [],
    ...overrides,
  };
}

/** Nominal bin top of the shared test bin: 3 height units of 7 mm. */
const BODY_TOP = 3 * HEIGHT_UNIT;

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

/**
 * A 10 mm cube cutter fully inside the interior fill of the shared test bin:
 * clear of the walls, clear of the label slot strip along the front, above the
 * floor top and below the nominal bin top.
 */
function interiorCube(): Manifold {
  return m.Manifold.cube([10, 10, 10], true).translate(0, 5, 14);
}

describe('buildInteriorFill', () => {
  it('welds into the floor plate and stops at the nominal bin top', () => {
    // The eps overlap is what makes the fill weld to the floor rather than
    // meeting it on a coincident face; dropping it in the move would leave a
    // gap that makes the union non-manifold.
    const fill = buildInteriorFill(m, params());
    const box = fill.boundingBox();

    expect(box.min[2]).toBeCloseTo(FLOOR_TOP - CARVE_OVERLAP_EPS, 6);
    expect(box.max[2]).toBeCloseTo(BODY_TOP, 6);
    expect(box.max[0] - box.min[0]).toBeCloseTo(binInteriorSizeMm(2), 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(binInteriorSizeMm(1), 6);

    fill.delete();
  });

  it('matches the interior cavity cross-section in plan', () => {
    // Both come from interiorSection, so a drift here means the fill stopped
    // using the shared profile.
    const fill = buildInteriorFill(m, params());
    const section = interiorSection(m, 2, 1);
    const plan = fill.slice(FLOOR_TOP + 1);

    expect(plan.area()).toBeCloseTo(section.area(), 6);

    plan.delete();
    section.delete();
    fill.delete();
  });
});

describe('buildCarvedBinBody with no cutters', () => {
  it('is a watertight single solid welded to the floor plate', () => {
    const body = buildCarvedBinBody(m, params(), [], 'Test bin');

    expect(body.status()).toBe('NoError');
    expect(componentVolumes(body).solids).toHaveLength(1);
    // The weld is asserted directly, as a slab straddling the floor top well
    // inside the interior coming back solid through. The fill reaches
    // CARVE_OVERLAP_EPS into the plate rather than meeting it on a coincident
    // face, and dropping that overlap would open a gap across the whole
    // interior cross-section right here.
    expect(probeVolume(body, [0, 5, FLOOR_TOP], [4, 4, 1])).toBeCloseTo(16, 5);
    // Sealed voids are deliberately not asserted to be absent on a filled bin.
    // A filled bin has them by construction: the fill closes the interior
    // around the insert slot's tab pockets, which are open to the cavity on a
    // plain bin and enclosed once the interior is solid. That is the shipped
    // behaviour of this stage, unchanged here, so per the assertion policy
    // validity is status() and connectedness is the positive component count.
    body.delete();
  });

  it('fills the interior up to the nominal bin top and no further', () => {
    // The mistake this pins: extruding the fill to the lip top instead of the
    // nominal bin top, which fills the stacking lip region solid.
    const body = buildCarvedBinBody(m, params(), [], 'Test bin');
    const plain = buildSlottedBinBody(m, { ...params(), scoop: false });

    expect(body.volume()).toBeGreaterThan(plain.volume());
    // Just under the bin top, inside the interior: filled solid.
    expect(probeVolume(body, [0, 5, BODY_TOP - 0.25], [4, 4, 0.5])).toBeCloseTo(8, 5);
    // Just above the bin top, in the lip region: still open.
    expect(probeVolume(body, [0, 5, BODY_TOP + 0.25], [4, 4, 0.5])).toBe(0);

    plain.delete();
    body.delete();
  });

  it('leaves the insert channel open after the fill closed it', () => {
    // The fill spans the whole interior and closes the insert channel, so the
    // slot has to be applied again; forgetting that leaves the insert with
    // nowhere to slide in.
    const body = buildCarvedBinBody(m, params(), [], 'Test bin');
    const channelY = -binOuterSizeMm(1) / 2 + SLOT_FRONT_INSET + SLOT_DEPTH / 2;
    const channelZ = BODY_TOP - SLOT_HEIGHT / 2;

    expect(probeVolume(body, [0, channelY, channelZ], [4, 4, SLOT_HEIGHT / 2])).toBe(0);

    body.delete();
  });
});

describe('buildCarvedBinBody with cutters', () => {
  it('removes exactly the cutter volume from the filled interior', () => {
    // The cube sits entirely inside the fill, so the difference must cost
    // exactly its 1000 mm3. A difference applied before the union rather than
    // after would remove nothing.
    const uncarved = buildCarvedBinBody(m, params(), [], 'Test bin');
    const carved = buildCarvedBinBody(m, params(), [interiorCube()], 'Test bin');

    expect(uncarved.volume() - carved.volume()).toBeCloseTo(1000, 4);

    carved.delete();
    uncarved.delete();
  });

  it('produces one sound piece of plastic', () => {
    // status() alone calls a bin with a loose island of plastic rattling in it
    // perfectly valid geometry, so connectedness is asserted directly.
    const carved = buildCarvedBinBody(m, params(), [interiorCube()], 'Test bin');

    expect(carved.status()).toBe('NoError');
    expect(componentVolumes(carved).solids).toHaveLength(1);

    carved.delete();
  });

  it('leaves the bin unchanged when a cutter misses it entirely', () => {
    // A degenerate empty difference must not corrupt the solid.
    const uncarved = buildCarvedBinBody(m, params(), [], 'Test bin');
    const missed = m.Manifold.cube([10, 10, 10], true).translate(500, 0, 14);
    const carved = buildCarvedBinBody(m, params(), [missed], 'Test bin');

    expect(carved.status()).toBe('NoError');
    expect(carved.volume()).toBeCloseTo(uncarved.volume(), 6);

    carved.delete();
    uncarved.delete();
  });

  it('leaves everything at and below the container floor untouched', () => {
    // The defect this pins actually shipped once, in the divider walls: roots
    // reached down past the interior floor and printed as ribs across the
    // bottom of the bin, and every validity assertion in the suite stayed
    // green because the solid was valid, just wrong. The comparison is
    // differential so magnet holes, which legitimately sit below the floor,
    // cancel between the two bins instead of having to be described again.
    const plain = buildCarvedBinBody(m, params(), [], 'Test bin');
    const carved = buildCarvedBinBody(m, params(), [interiorCube()], 'Test bin');

    const plainBase = plain.trimByPlane([0, 0, -1], -FLOOR_TOP);
    const carvedBase = carved.trimByPlane([0, 0, -1], -FLOOR_TOP);
    expect(carvedBase.volume()).toBeCloseTo(plainBase.volume(), 6);

    // The first layer as its own plan slice, so a change confined to the bed
    // surface cannot hide inside a volume comparison.
    const plainSlice = plain.slice(0.1);
    const carvedSlice = carved.slice(0.1);
    expect(carvedSlice.area()).toBeCloseTo(plainSlice.area(), 6);

    for (const part of [plainSlice, carvedSlice]) part.delete();
    for (const part of [plainBase, carvedBase, plain, carved]) part.delete();
  });
});

describe('buildCarvedBinBody cutter ownership', () => {
  it('deletes every cutter it is handed on the success path', () => {
    // A leak here is invisible in the output and fatal in a long editing
    // session, so it is asserted rather than reviewed: manifold throws a
    // binding error the moment a deleted object is used again.
    const cutters = [interiorCube(), interiorCube().translate(20, 0, 0)];
    const body = buildCarvedBinBody(m, params(), cutters, 'Test bin');

    for (const cutter of cutters) {
      expect(() => cutter.volume()).toThrow(/deleted object/);
    }

    body.delete();
  });

  it('deletes every cutter it is handed on the failure path', () => {
    // heightUnits 1 is rejected by the bin builder the shared stage sits on,
    // so the stage throws after taking ownership of the cutters.
    const cutters = [interiorCube()];

    expect(() =>
      buildCarvedBinBody(m, params({ heightUnits: 1 }), cutters, 'Test bin'),
    ).toThrow(/heightUnits/);
    for (const cutter of cutters) {
      expect(() => cutter.volume()).toThrow(/deleted object/);
    }
  });
});

describe('labelStructureStrip', () => {
  it('covers the slot structure reach on a bin with the insert slot', () => {
    const structure = labelStructureStrip(m, params());
    expect(structure).not.toBeNull();
    const { section, name } = structure!;

    expect(name).toBe('label insert slot');
    const box = section.bounds();
    expect(box.min[1]).toBeCloseTo(-binOuterSizeMm(1) / 2, 6);
    expect(box.max[1]).toBeCloseTo(-binOuterSizeMm(1) / 2 + SLOT_REACH_DEPTH, 6);

    section.delete();
  });

  it('detects a carve reaching into the strip and clears one that does not', () => {
    // The protection this keeps: the insert rests on the slot floor, so a
    // carve cutting into the strip undercuts its seat.
    const { section } = labelStructureStrip(m, params())!;
    const frontY = -binOuterSizeMm(1) / 2;

    const reaching = new m.CrossSection(
      [
        [
          [-5, frontY + SLOT_REACH_DEPTH - 1],
          [5, frontY + SLOT_REACH_DEPTH - 1],
          [5, frontY + SLOT_REACH_DEPTH + 5],
          [-5, frontY + SLOT_REACH_DEPTH + 5],
        ],
      ],
      'NonZero',
    );
    const clear = reaching.translate([0, 2]);

    const hit = section.intersect(reaching);
    expect(hit.isEmpty()).toBe(false);
    const miss = section.intersect(clear);
    expect(miss.isEmpty()).toBe(true);

    for (const part of [hit, miss, clear, reaching, section]) part.delete();
  });

  it('names the fused shelf and its reach on a fused-label bin', () => {
    const structure = labelStructureStrip(
      m,
      params({ fusedLabel: { text: 'A', text2: '', icon: null } }),
    );
    expect(structure).not.toBeNull();
    const { section, name } = structure!;

    expect(name).toBe('fused label shelf');
    expect(section.bounds().max[1]).toBeCloseTo(
      -binOuterSizeMm(1) / 2 + FUSED_SHELF_REACH_DEPTH,
      6,
    );

    section.delete();
  });

  it('is null for a bin with neither a slot nor a fused label', () => {
    expect(labelStructureStrip(m, params({ labelSlot: false }))).toBeNull();
  });
});

describe('maxCarveDepthMm', () => {
  it('is the nominal bin top down to the top of the floor plate', () => {
    // The figure the depth validation messages quote; drifting from it would
    // make a message name a limit the geometry does not enforce.
    for (const heightUnits of [2, 3, 6, 12]) {
      expect(maxCarveDepthMm(heightUnits)).toBe(heightUnits * HEIGHT_UNIT - FLOOR_TOP);
    }
    expect(maxCarveDepthMm(3)).toBe(14);
  });
});
