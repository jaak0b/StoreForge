import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from './helpers/manifold';
import {
  buildBinManifold,
  buildFoot,
  generateBin,
  roundedRectPolygon,
  validateParams,
} from '../src/engine/gridfinity/binGenerator';
import {
  BASE_WALL_THICKNESS,
  binTopOpeningMm,
  DIVIDER_THICKNESS,
  FLOOR_PLATE_THICKNESS,
  FLOOR_TOP,
  FOOT_HEIGHT,
  HEIGHT_UNIT,
  LIP_HEIGHT,
  MAGNET_HOLE_DEPTH,
  MAGNET_HOLE_FROM_CELL_EDGE,
  OUTER_CORNER_RADIUS,
  PITCH,
  WALL_THICKNESS,
} from '../src/engine/gridfinity/constants';
import type { BinParams } from '../src/engine/gridfinity/types';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

function params(overrides: Partial<BinParams> = {}): BinParams {
  return {
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: false,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    ...overrides,
  };
}

describe('roundedRectPolygon', () => {
  it('stays inside the rectangle and touches its sides', () => {
    const poly = roundedRectPolygon(41.5, 41.5, 3.75);
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of poly) {
      expect(Math.abs(x)).toBeLessThanOrEqual(41.5 / 2 + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(41.5 / 2 + 1e-9);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    expect(maxX).toBeCloseTo(41.5 / 2, 9);
    expect(maxY).toBeCloseTo(41.5 / 2, 9);
  });
});

describe('buildBinManifold', () => {
  it('produces a watertight solid of genus 0 for a plain 1x1x3 bin', () => {
    const bin = buildBinManifold(m, params());
    expect(bin.status()).toBe('NoError');
    expect(bin.isEmpty()).toBe(false);
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('matches the expected outer dimensions for a 1x1x3 bin without lip', () => {
    const bin = buildBinManifold(m, params());
    const box = bin.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(1 * PITCH - 0.5, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(1 * PITCH - 0.5, 5);
    expect(box.max[2] - box.min[2]).toBeCloseTo(3 * HEIGHT_UNIT, 5);
    bin.delete();
  });

  it('matches the expected outer dimensions for a 2x1x6 bin without lip', () => {
    const bin = buildBinManifold(m, params({ gridX: 2, gridY: 1, heightUnits: 6 }));
    const box = bin.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(2 * PITCH - 0.5, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(1 * PITCH - 0.5, 5);
    expect(box.max[2] - box.min[2]).toBeCloseTo(6 * HEIGHT_UNIT, 5);
    bin.delete();
  });

  it('ends the stacking lip at the filleted crest apex above the nominal top', () => {
    const bin = buildBinManifold(m, params({ stackingLip: true }));
    const box = bin.boundingBox();
    // The lip profile is 0.7 + 1.8 + 1.9 = 4.4 tall (kennetek
    // STACKING_LIP_LINE), but the crest fillet (radius 0.6, kennetek
    // STACKING_LIP_FILLET_RADIUS) rounds off the knife edge: the apex sits
    // 4.4 - 0.6 * sqrt(2) = 3.5515 above the nominal top of 21, matching the
    // measured Pred reference bin (crest 3.551 above its nominal top).
    expect(box.max[2] - box.min[2]).toBeCloseTo(24.5515, 3);
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('recesses the outer rim groove below the nominal top of a lipped bin', () => {
    const bin = buildBinManifold(m, params({ stackingLip: true }));
    // Measured from the Pred reference bin: the outer face steps inward 0.7
    // over 45 degrees, runs vertical for 1.0 ending at the nominal top, and
    // returns to the outer face 0.7 above it. Nominal top here is 21, outer
    // half-width 20.75. A probe 0.3 inside the outer face finds air in the
    // groove's vertical band (z 20.0 to 21.0) and solid wall further down.
    const grooveProbe = m.Manifold.cube([0.3, 2, 0.6], true).translate(20.75 - 0.15, 0, 20.5);
    const inGroove = bin.intersect(grooveProbe);
    expect(Math.abs(inGroove.volume())).toBeLessThan(1e-9);
    inGroove.delete();
    grooveProbe.delete();
    const wallProbe = m.Manifold.cube([0.3, 2, 0.6], true).translate(20.75 - 0.15, 0, 17.0);
    const inWall = bin.intersect(wallProbe);
    expect(inWall.volume()).toBeCloseTo(0.3 * 2 * 0.6, 3);
    inWall.delete();
    wallProbe.delete();
    bin.delete();
  });

  it('seats a stacked foot in the lip with clearance and self-centres it', () => {
    const bin = buildBinManifold(m, params({ stackingLip: true }));
    const foot = buildFoot(m);
    // A foot resting centred at the nominal top (21 for 3 height units)
    // nests in the lip seat without touching: the seat profile 0.7/1.8/1.9
    // is the foot profile 0.8/1.8/2.15 plus the footprint clearance.
    const seated = foot.translate(0, 0, 3 * HEIGHT_UNIT);
    const seatedOverlap = bin.intersect(seated);
    expect(Math.abs(seatedOverlap.volume())).toBeLessThan(1e-9);
    seatedOverlap.delete();
    seated.delete();
    // A foot shifted 1 mm sideways collides with the seat: the lip
    // self-centres a stacked bin (per-side nesting clearance is under 0.4).
    const shifted = foot.translate(1, 0, 3 * HEIGHT_UNIT);
    const shiftedOverlap = bin.intersect(shifted);
    expect(shiftedOverlap.volume()).toBeGreaterThan(0.01);
    shiftedOverlap.delete();
    shifted.delete();
    foot.delete();
    bin.delete();
  });

  it('has a positive volume smaller than its bounding box volume', () => {
    const bin = buildBinManifold(m, params());
    const box = bin.boundingBox();
    const boxVolume =
      (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
    const volume = bin.volume();
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeLessThan(boxVolume);
    bin.delete();
  });

  it('magnet holes stay open inside solid bosses without breaking the solid', () => {
    const withMagnets = buildBinManifold(m, params({ magnetHoles: true }));
    expect(withMagnets.status()).toBe('NoError');
    // Each magnet boss welds to the two foot shell walls of its corner and to
    // the floor plate above, closing two independent loops per boss: genus 2
    // per boss, 4 bosses on a 1x1 bin.
    expect(withMagnets.genus()).toBe(8);
    const offset = PITCH / 2 - MAGNET_HOLE_FROM_CELL_EDGE;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        // The hole itself is open air.
        const hole = m.Manifold.cylinder(MAGNET_HOLE_DEPTH - 0.2, 3.0, 3.0, 16).translate(
          sx * offset,
          sy * offset,
          0.1,
        );
        const holeHit = withMagnets.intersect(hole);
        expect(holeHit.isEmpty()).toBe(true);
        holeHit.delete();
        hole.delete();
        // A ring of solid plastic surrounds the hole (the boss kept out of
        // the base pocket), probed just outside the hole radius.
        const ring = m.Manifold.cube([0.4, 0.4, MAGNET_HOLE_DEPTH - 0.2], true).translate(
          sx * offset + 3.25 + 0.4,
          sy * offset,
          MAGNET_HOLE_DEPTH / 2,
        );
        const ringHit = withMagnets.intersect(ring);
        expect(ringHit.isEmpty()).toBe(false);
        ringHit.delete();
        ring.delete();
      }
    }
    withMagnets.delete();
  });

  it('hollows the base while keeping the floor plate under the cavity', () => {
    const bin = buildBinManifold(m, params());
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    // The foot interior is pocketed away, probed at a cell quarter point
    // (the cell centre itself carries the "+" cross walls).
    const hollowProbe = m.Manifold.cube([4, 4, 2], true).translate(10.5, 10.5, 2);
    const hollow = bin.intersect(hollowProbe);
    expect(hollow.isEmpty()).toBe(true);
    hollow.delete();
    hollowProbe.delete();
    // The floor plate above the pocket is solid up to FLOOR_TOP.
    const plateProbe = m.Manifold.cube([4, 4, FLOOR_PLATE_THICKNESS - 0.1], true).translate(
      0,
      0,
      FLOOR_TOP - FLOOR_PLATE_THICKNESS / 2,
    );
    const plate = bin.intersect(plateProbe);
    expect(plate.volume()).toBeCloseTo(4 * 4 * (FLOOR_PLATE_THICKNESS - 0.1), 3);
    plate.delete();
    plateProbe.delete();
    // And the cavity above the plate is open: the interior floor stays at
    // FLOOR_TOP exactly.
    const cavityProbe = m.Manifold.cube([4, 4, 1], true).translate(0, 0, FLOOR_TOP + 0.6);
    const cavity = bin.intersect(cavityProbe);
    expect(cavity.isEmpty()).toBe(true);
    cavity.delete();
    cavityProbe.delete();
    bin.delete();
  });

  it('keeps a "+" of cross walls inside the base pocket of every cell', () => {
    const bin = buildBinManifold(m, params({ gridX: 2 }));
    expect(bin.status()).toBe('NoError');
    for (const cx of [-PITCH / 2, PITCH / 2]) {
      // Solid on both arms of the "+" (cell midlines), probed near the bed
      // well inside the BASE_WALL_THICKNESS of the cross walls.
      for (const [px, py] of [
        [cx + 10.5, 0],
        [cx, 10.5],
      ]) {
        const probe = m.Manifold.cube([0.5, 0.5, 1], true).translate(px, py, 1.5);
        const hit = bin.intersect(probe);
        expect(hit.volume()).toBeCloseTo(0.5 * 0.5 * 1, 3);
        hit.delete();
        probe.delete();
      }
      // Hollow chambers at the cell quarter points between the walls.
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const probe = m.Manifold.cube([2, 2, 1], true).translate(
            cx + sx * 10.5,
            sy * 10.5,
            1.5,
          );
          const hit = bin.intersect(probe);
          expect(hit.isEmpty()).toBe(true);
          hit.delete();
          probe.delete();
        }
      }
    }
    bin.delete();
  });

  it('the base pocket removes a meaningful amount of material', () => {
    // Reconstruct the pre-pocket base (solid foot plus solid slab up to
    // FLOOR_TOP) and compare it against the actual bin below FLOOR_TOP.
    const outer = PITCH - 0.5;
    const slab = m.Manifold.extrude(
      [roundedRectPolygon(outer, outer, OUTER_CORNER_RADIUS)],
      FLOOR_TOP - FOOT_HEIGHT,
    ).translate(0, 0, FOOT_HEIGHT);
    const foot = buildFoot(m);
    const solidBase = m.Manifold.union([foot, slab]);
    const bin = buildBinManifold(m, params());
    const base = bin.trimByPlane([0, 0, -1], -FLOOR_TOP);
    const saved = solidBase.volume() - base.volume();
    // The 1x1 pocket still saves several cubic centimetres of filament even
    // with the thicker base walls and the "+" cross walls in the pocket.
    expect(saved).toBeGreaterThan(4000);
    expect(base.volume()).toBeGreaterThan(0);
    solidBase.delete();
    foot.delete();
    slab.delete();
    base.delete();
    bin.delete();
  });

  it('keeps a 2x1 bin with magnets and dividers watertight when pocketed', () => {
    const bin = buildBinManifold(
      m,
      params({ gridX: 2, magnetHoles: true, dividerCountX: 1, dividerCountY: 1 }),
    );
    expect(bin.status()).toBe('NoError');
    // Genus 2 per magnet boss (see the magnet hole test): 8 bosses here.
    expect(bin.genus()).toBe(16);
    bin.delete();
  });

  it('keeps the foot region narrower than the body so bins can stack', () => {
    // Sample the bounding box of the solid sliced below the foot top.
    const bin = buildBinManifold(m, params());
    const feetOnly = bin.trimByPlane([0, 0, -1], -(FOOT_HEIGHT - 0.05));
    const box = feetOnly.boundingBox();
    expect(box.max[0] - box.min[0]).toBeLessThan(1 * PITCH - 0.5);
    bin.delete();
    feetOnly.delete();
  });

  it('rejects non-integer and out-of-range parameters', () => {
    expect(() => validateParams(params({ gridX: 0 }))).toThrow(/gridX/);
    expect(() => validateParams(params({ gridY: 1.5 }))).toThrow(/gridY/);
    expect(() => validateParams(params({ heightUnits: 1 }))).toThrow(/heightUnits/);
  });
});

describe('interior dividers', () => {
  it('keeps the solid watertight with dividers on both axes', () => {
    const bin = buildBinManifold(m, params({ dividerCountX: 2, dividerCountY: 1 }));
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('zero dividers leave the bin volume unchanged', () => {
    const plain = buildBinManifold(m, params());
    const zeroed = buildBinManifold(m, params({ dividerCountX: 0, dividerCountY: 0 }));
    expect(zeroed.volume()).toBeCloseTo(plain.volume(), 6);
    plain.delete();
    zeroed.delete();
  });

  it('adds the divider wall volume plus their solid roots in the base pocket', () => {
    const countX = 2;
    const countY = 1;
    const plain = buildBinManifold(m, params());
    const divided = buildBinManifold(m, params({ dividerCountX: countX, dividerCountY: countY }));
    const inner = PITCH - 0.5 - 2 * WALL_THICKNESS;
    const outer = PITCH - 0.5;
    const visibleHeight = 3 * HEIGHT_UNIT - FLOOR_TOP;
    const walls =
      visibleHeight *
      DIVIDER_THICKNESS *
      (countX * inner + countY * inner - countX * countY * DIVIDER_THICKNESS);
    const delta = divided.volume() - plain.volume();
    // The dividers themselves, plus the solid strips kept out of the base
    // pocket under each divider root (at most a full-height strip of
    // DIVIDER_THICKNESS + 2 * BASE_WALL_THICKNESS across the bin per divider).
    const stripBound =
      (DIVIDER_THICKNESS + 2 * BASE_WALL_THICKNESS) *
      outer *
      (FLOOR_TOP - FLOOR_PLATE_THICKNESS) *
      (countX + countY);
    expect(delta).toBeGreaterThan(walls);
    expect(delta).toBeLessThan(walls + stripBound);
    plain.delete();
    divided.delete();
  });

  it('places divider walls at equal-compartment positions inside the interior', () => {
    const bin = buildBinManifold(m, params({ dividerCountX: 2 }));
    const inner = PITCH - 0.5 - 2 * WALL_THICKNESS;
    const midZ = (FLOOR_TOP + 3 * HEIGHT_UNIT) / 2;
    // A probe at the centre compartment finds open air.
    const airProbe = m.Manifold.cube([2, 2, 2], true).translate(0, 0, midZ);
    const air = bin.intersect(airProbe);
    expect(air.isEmpty()).toBe(true);
    // Probes at both divider planes find solid wall.
    for (const i of [1, 2]) {
      const x = -inner / 2 + (i * inner) / 3;
      const probe = m.Manifold.cube([0.5, 2, 2], true).translate(x, 0, midZ);
      const hit = bin.intersect(probe);
      expect(hit.isEmpty()).toBe(false);
      hit.delete();
      probe.delete();
    }
    air.delete();
    airProbe.delete();
    bin.delete();
  });

  it('keeps dividers below the stacking lip seat and inside the outline', () => {
    const bin = buildBinManifold(
      m,
      params({ stackingLip: true, dividerCountX: 1, dividerCountY: 1 }),
    );
    expect(bin.status()).toBe('NoError');
    const box = bin.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(PITCH - 0.5, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(PITCH - 0.5, 5);
    // Nothing solid crosses the lip band at the divider plane.
    const lipZ = 3 * HEIGHT_UNIT + LIP_HEIGHT / 2;
    const probe = m.Manifold.cube([2, 2, 1], true).translate(0, 0, lipZ);
    const hit = bin.intersect(probe);
    expect(hit.isEmpty()).toBe(true);
    hit.delete();
    probe.delete();
    bin.delete();
  });

  it('rejects negative or fractional divider counts', () => {
    expect(() => validateParams(params({ dividerCountX: -1 }))).toThrow(/dividerCountX/);
    expect(() => validateParams(params({ dividerCountY: 1.5 }))).toThrow(/dividerCountY/);
  });
});

describe('interior scoop', () => {
  // The Pred reference bin (gridfinitybin_1x1x6_d1_l12_s10) carries a
  // circular fillet of radius 10.000 mm tangent to the interior floor and to
  // the interior face of the wall opposite the label slot, running the full
  // interior width. In our frame the slot is at -Y, so the scoop fills the
  // corner at the +Y wall. For a 1x1x3 bin without lip: interior back wall
  // face at y 19.8, floor top at z 7, fillet centre (y 9.8, z 17).
  it('adds solid fillet material at the floor/back-wall junction', () => {
    const bin = buildBinManifold(m, params());
    // Mid-scoop probe (y 18.5, z 8.5): 12.16 mm from the fillet centre,
    // outside the radius-10 arc, so it is now solid; it was open cavity air
    // before the scoop.
    const solid = m.Manifold.cube([2, 0.5, 0.5], true).translate(0, 18.5, 8.5);
    const solidHit = bin.intersect(solid);
    expect(solidHit.volume()).toBeCloseTo(2 * 0.5 * 0.5, 3);
    solidHit.delete();
    solid.delete();
    // The same spot at the front wall (the label slot side) stays air: the
    // scoop is only on the opposite wall.
    const front = m.Manifold.cube([2, 0.5, 0.5], true).translate(0, -18.5, 8.5);
    const frontHit = bin.intersect(front);
    expect(frontHit.isEmpty()).toBe(true);
    frontHit.delete();
    front.delete();
    // Inside the arc (y 12, z 8.5 is 8.78 mm from the centre) the cavity is
    // still open: the fillet curve, not a solid block.
    const inside = m.Manifold.cube([2, 0.5, 0.5], true).translate(0, 12, 8.5);
    const insideHit = bin.intersect(inside);
    expect(insideHit.isEmpty()).toBe(true);
    insideHit.delete();
    inside.delete();
    // Away from the scoop the floor level is unchanged: air directly above
    // FLOOR_TOP at the bin centre.
    const floor = m.Manifold.cube([2, 2, 0.5], true).translate(0, 0, FLOOR_TOP + 0.3);
    const floorHit = bin.intersect(floor);
    expect(floorHit.isEmpty()).toBe(true);
    floorHit.delete();
    floor.delete();
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('stays watertight with the stacking lip and with dividers crossing the scoop', () => {
    const bin = buildBinManifold(
      m,
      params({ stackingLip: true, dividerCountX: 1, dividerCountY: 1 }),
    );
    expect(bin.status()).toBe('NoError');
    // Dividers only ever overlap the scoop's added material, so they weld in.
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('clamps the scoop radius to the wall height on a 2-unit bin', () => {
    // A 1x1x2 bin without lip has 14 - 7 = 7 mm of interior wall above the
    // floor, less than the measured 10 mm radius, so the fillet is clamped
    // to radius 7 (centre y 12.8, z 14).
    const bin = buildBinManifold(m, params({ heightUnits: 2 }));
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    // Nothing pokes above the nominal top.
    expect(bin.boundingBox().max[2]).toBeCloseTo(2 * HEIGHT_UNIT, 5);
    // Probe (y 17.5, z 10): outside the unclamped radius-10 arc (it would be
    // solid), but inside the clamped radius-7 arc, so it stays air.
    const air = m.Manifold.cube([2, 0.5, 0.5], true).translate(0, 17.5, 10);
    const airHit = bin.intersect(air);
    expect(airHit.isEmpty()).toBe(true);
    airHit.delete();
    air.delete();
    // The clamped fillet's own material is present near the corner
    // (y 19.3, z 8: 8.85 mm from the clamped centre, outside the arc).
    const solid = m.Manifold.cube([2, 0.4, 0.4], true).translate(0, 19.3, 8);
    const solidHit = bin.intersect(solid);
    expect(solidHit.volume()).toBeCloseTo(2 * 0.4 * 0.4, 3);
    solidHit.delete();
    solid.delete();
    bin.delete();
  });
});

describe('binTopOpeningMm', () => {
  it('narrows the opening of a lipped bin to the lip tip span', () => {
    // Outer size 41.5 minus the 2.6 lip protrusion per side (kennetek
    // STACKING_LIP_SIZE.x): the widest object that drops in from above.
    expect(binTopOpeningMm(1)).toBeCloseTo(36.3, 9);
    expect(binTopOpeningMm(2)).toBeCloseTo(78.3, 9);
  });

  it('equals the interior for a bin without a stacking lip', () => {
    // Outer size 41.5 minus the 0.95 wall per side.
    expect(binTopOpeningMm(1, false)).toBeCloseTo(39.6, 9);
  });
});

describe('generateBin', () => {
  it('returns transferable arrays describing a valid triangle mesh', () => {
    const mesh = generateBin(m, params());
    expect(mesh.vertices.length % 3).toBe(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    const numVert = mesh.vertices.length / 3;
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(numVert);
    }
  });
});
