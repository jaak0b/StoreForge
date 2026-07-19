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
  binInteriorSizeMm,
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
import { evenDividerWalls, type DividerWall } from '../src/engine/gridfinity/dividerModel';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

/**
 * Build BinParams for a test. The old evenly spaced divider counts are still
 * accepted as a convenience (converted to walls through evenDividerWalls, the
 * production conversion), so the count-based geometry tests keep exercising
 * the same solids; a test that needs a free wall passes walls directly.
 */
function params(
  overrides: Partial<Omit<BinParams, 'walls'>> & {
    walls?: DividerWall[];
    dividerCountX?: number;
    dividerCountY?: number;
  } = {},
): BinParams {
  const { dividerCountX = 0, dividerCountY = 0, walls, ...rest } = overrides;
  const base = {
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    ...rest,
  };
  return {
    ...base,
    walls: walls ?? evenDividerWalls(base.gridX, base.gridY, dividerCountX, dividerCountY),
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

  it('matches the expected footprint for a 1x1x3 bin', () => {
    const bin = buildBinManifold(m, params());
    const box = bin.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(1 * PITCH - 0.5, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(1 * PITCH - 0.5, 5);
    bin.delete();
  });

  it('matches the expected outer dimensions for a 2x1x6 bin', () => {
    const bin = buildBinManifold(m, params({ gridX: 2, gridY: 1, heightUnits: 6 }));
    const box = bin.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(2 * PITCH - 0.5, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(1 * PITCH - 0.5, 5);
    // The lip is always present, so the height runs to the crest apex:
    // 4.4 - 0.6 * sqrt(2) = 3.5515 above the nominal top of 42.
    expect(box.max[2] - box.min[2]).toBeCloseTo(45.5515, 3);
    bin.delete();
  });

  it('ends the stacking lip at the filleted crest apex above the nominal top', () => {
    const bin = buildBinManifold(m, params());
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
    const bin = buildBinManifold(m, params());
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
    const bin = buildBinManifold(m, params());
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
    // With the measured 3.05 mm base wall the magnet bosses (radius 6.30 mm)
    // fully weld into the thick foot shell and the dense rib lattice, leaving
    // no independent through-loops: the pocketed base is a simple genus-0
    // solid, and the blind magnet holes (checked open below) do not add genus.
    expect(withMagnets.genus()).toBe(0);
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
    // The foot interior is pocketed away, probed inside one of the triangular
    // void sectors of the rib lattice (off the cross arms and the diagonals).
    const hollowProbe = m.Manifold.cube([4, 4, 2], true).translate(12, 5, 2);
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

  it('keeps the rib lattice ("+" cross plus diagonals) inside every cell pocket', () => {
    const bin = buildBinManifold(m, params({ gridX: 2 }));
    expect(bin.status()).toBe('NoError');
    for (const cx of [-PITCH / 2, PITCH / 2]) {
      // Solid on both arms of the "+" cross (cell midlines) and on both
      // diagonals (a point on y = x at radius 10.5, cell-local (7.42, 7.42)),
      // probed near the bed well inside the rib width.
      for (const [px, py] of [
        [cx + 10.5, 0],
        [cx, 10.5],
        [cx + 7.42, 7.42],
        [cx + 7.42, -7.42],
      ]) {
        const probe = m.Manifold.cube([0.5, 0.5, 1], true).translate(px, py, 1.5);
        const hit = bin.intersect(probe);
        expect(hit.volume()).toBeCloseTo(0.5 * 0.5 * 1, 3);
        hit.delete();
        probe.delete();
      }
      // Hollow triangular void sectors between the ribs (cell-local (9, 4),
      // off both the cross arms and the diagonals).
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const probe = m.Manifold.cube([2, 2, 1], true).translate(
            cx + sx * 9,
            sy * 4,
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
    // with the thicker base walls and the rib lattice standing in the pocket.
    // With the ribs widened to BASE_RIB_THICKNESS = 1.6 mm the ribs occupy
    // more of the pocket, so the pocket now saves about 3804 mm^3 (measured
    // 2026-07-19); the bound follows from the 1.6 mm rib width.
    expect(saved).toBeGreaterThan(3500);
    expect(base.volume()).toBeGreaterThan(0);
    solidBase.delete();
    foot.delete();
    slab.delete();
    base.delete();
    bin.delete();
  });

  it('gives the first layer the measured Pred base area for bed adhesion', () => {
    const bin = buildBinManifold(m, params());
    // First-layer plan slice, 0.1 mm above the bed, is what adheres to the
    // build plate. The base uses a 3.05 mm foot shell plus the rib lattice at
    // BASE_RIB_THICKNESS = 1.6 mm (the owner's four-perimeter printability
    // width, see constants). With the 1.6 mm central cross and diagonals the
    // slice measures 613.37 mm^2 of solid per cell (measured 2026-07-19); the
    // range below is pinned tightly around that value, which follows directly
    // from the 1.6 mm rib width. Pinning it guards the adhesion fix: a
    // regression thinning the base back to sparse lines would fall far below.
    const cs = bin.slice(0.1);
    expect(cs.area()).toBeGreaterThan(611);
    expect(cs.area()).toBeLessThan(616);
    cs.delete();
    bin.delete();
  });

  it('keeps a 2x1 bin with magnets and dividers watertight when pocketed', () => {
    const bin = buildBinManifold(
      m,
      params({ gridX: 2, magnetHoles: true, dividerCountX: 1, dividerCountY: 1 }),
    );
    expect(bin.status()).toBe('NoError');
    // The magnet bosses weld fully into the thick base wall and rib lattice
    // (see the magnet hole test), leaving a simple genus-0 solid.
    expect(bin.genus()).toBe(0);
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

/**
 * Volume in cubic mm of the default 2x2x3 bin with one even divider along X,
 * recorded from the evenly spaced geometry as it has always been built. A pin
 * on that case: only wall ends on the interior boundary are extended into the
 * perimeter, and this is what proves the even dividers still are.
 */
const EVEN_DIVIDER_2X2_VOLUME_MM3 = 38002.874199748905;

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
      params({ dividerCountX: 1, dividerCountY: 1 }),
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

  it('rejects a wall running outside the interior or two walls too close', () => {
    // A wall reaching well past the interior rectangle.
    expect(() =>
      validateParams(params({ walls: [{ x1: -100, y1: 0, x2: 100, y2: 0 }] })),
    ).toThrow(/outside the bin interior/);
    // Two parallel walls closer than the minimum compartment gap.
    expect(() =>
      validateParams(
        params({
          gridX: 3,
          walls: [
            { x1: 0, y1: -10, x2: 0, y2: 10 },
            { x1: 3, y1: -10, x2: 3, y2: 10 },
          ],
        }),
      ),
    ).toThrow(/minimum compartment gap/);
  });

  it('keeps a single partial-length free wall watertight', () => {
    const bin = buildBinManifold(
      m,
      params({ gridX: 2, walls: [{ x1: 0, y1: -8, x2: 0, y2: 8 }] }),
    );
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('keeps an angled free wall watertight', () => {
    // A wall at 30 degrees through the interior of a 2x2 bin.
    const r = 15;
    const a = (30 * Math.PI) / 180;
    const bin = buildBinManifold(
      m,
      params({
        gridX: 2,
        gridY: 2,
        walls: [
          { x1: -r * Math.cos(a), y1: -r * Math.sin(a), x2: r * Math.cos(a), y2: r * Math.sin(a) },
        ],
      }),
    );
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('keeps a T-junction of free walls watertight', () => {
    const bin = buildBinManifold(
      m,
      params({
        gridX: 2,
        gridY: 2,
        walls: [
          { x1: -20, y1: 0, x2: 20, y2: 0 },
          { x1: 0, y1: 0, x2: 0, y2: 18 },
        ],
      }),
    );
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('leaves no fin past the far face of a wall a wall ends against', () => {
    // A T: a long wall along X, and a wall running up from it. The ending
    // wall's endpoint is at the junction, in open interior, so nothing of it
    // may appear on the far side of the wall it meets.
    const bin = buildBinManifold(
      m,
      params({
        gridX: 2,
        gridY: 2,
        walls: [
          { x1: -20, y1: 0, x2: 20, y2: 0 },
          { x1: 0, y1: 0, x2: 0, y2: 18 },
        ],
      }),
    );
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    const midZ = (FLOOR_TOP + 3 * HEIGHT_UNIT) / 2;
    // The junction wall is solid right up to its own far face.
    const inside = m.Manifold.cube([DIVIDER_THICKNESS, 0.4, 2], true).translate(
      0,
      -DIVIDER_THICKNESS / 2 + 0.2,
      midZ,
    );
    const insideHit = bin.intersect(inside);
    expect(insideHit.isEmpty()).toBe(false);
    insideHit.delete();
    inside.delete();
    // Beyond that face, along the ending wall's axis, there is only air.
    const beyond = m.Manifold.cube([DIVIDER_THICKNESS, WALL_THICKNESS, 2], true).translate(
      0,
      -DIVIDER_THICKNESS / 2 - 0.05 - WALL_THICKNESS / 2,
      midZ,
    );
    const beyondHit = bin.intersect(beyond);
    expect(beyondHit.isEmpty()).toBe(true);
    beyondHit.delete();
    beyond.delete();
    bin.delete();
  });

  it('builds a wall ending in open interior at the length it was drawn', () => {
    // Both endpoints are free, so the wall is built exactly end to end. The
    // scoop is off so the only material in the probe slab is the wall.
    const drawn = 8;
    const bin = buildBinManifold(
      m,
      params({
        gridX: 2,
        gridY: 2,
        scoop: false,
        walls: [{ x1: 0, y1: -drawn, x2: 0, y2: drawn }],
      }),
    );
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    const midZ = (FLOOR_TOP + 3 * HEIGHT_UNIT) / 2;
    // A slab thinner than the wall and well clear of the perimeter, so what
    // it catches is the wall and nothing else; its Y extent is the built
    // length.
    const slab = m.Manifold.cube([DIVIDER_THICKNESS / 2, 60, 2], true).translate(0, 0, midZ);
    const built = bin.intersect(slab);
    expect(built.isEmpty()).toBe(false);
    const box = built.boundingBox();
    expect(box.min[1]).toBeCloseTo(-drawn, 5);
    expect(box.max[1]).toBeCloseTo(drawn, 5);
    built.delete();
    slab.delete();
    bin.delete();
  });

  it('still welds an even divider into the perimeter walls', () => {
    // Both endpoints of an even divider lie on the interior boundary, so it
    // is still extended into the perimeter wall and reaches it: the case the
    // boundary test must keep protecting. The volume is pinned so the
    // evenly spaced geometry cannot drift.
    const bin = buildBinManifold(m, params({ gridX: 2, gridY: 2, dividerCountX: 1 }));
    expect(bin.status()).toBe('NoError');
    const hy = binInteriorSizeMm(2) / 2;
    const midZ = (FLOOR_TOP + 3 * HEIGHT_UNIT) / 2;
    // Solid divider material in the last tenth of a millimetre before the
    // perimeter wall's interior face, at both ends.
    for (const sign of [-1, 1]) {
      const probe = m.Manifold.cube([DIVIDER_THICKNESS / 2, 0.1, 2], true).translate(
        0,
        sign * (hy - 0.05),
        midZ,
      );
      const hit = bin.intersect(probe);
      expect(hit.isEmpty()).toBe(false);
      hit.delete();
      probe.delete();
    }
    expect(bin.volume()).toBeCloseTo(EVEN_DIVIDER_2X2_VOLUME_MM3, 3);
    bin.delete();
  });

  it('keeps an asymmetric compartment layout watertight', () => {
    // A 2x3 bin split down the middle, the left half into two rows and the
    // right half into three, every wall reaching the perimeter or the centre
    // wall so the partition is clean (genus 0). The deeper bin keeps the
    // staggered rows clear of the minimum compartment gap.
    const hx = (2 * PITCH - 0.5 - 2 * WALL_THICKNESS) / 2;
    const hy = (3 * PITCH - 0.5 - 2 * WALL_THICKNESS) / 2;
    const bin = buildBinManifold(
      m,
      params({
        gridX: 2,
        gridY: 3,
        walls: [
          { x1: 0, y1: -hy, x2: 0, y2: hy },
          { x1: -hx, y1: 0, x2: 0, y2: 0 },
          { x1: 0, y1: -hy / 3, x2: hx, y2: -hy / 3 },
          { x1: 0, y1: hy / 3, x2: hx, y2: hy / 3 },
        ],
      }),
    );
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    bin.delete();
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

  it('keeps the outer corner arcs unchanged through the scoop band', () => {
    // Regression: the scoop prism ends square while the bin corners are
    // round, so before it was trimmed to the outer envelope its ends poked
    // 0.313 mm past the outer corner arcs at (+-19.8, 19.8), z 7..17 on a
    // 1x1x6 lipped bin (plan slices measured 2026-07-18; the Pred reference
    // bin gridfinitybin_1x1x6_d1_l12_s10 keeps its corner arc unchanged
    // through the same band). A probe box spanning the diagonal just outside
    // the radius-4 corner arc but inside where the nub was must stay empty.
    const bin = buildBinManifold(m, params({ heightUnits: 6 }));
    for (const sx of [-1, 1]) {
      // Box corner nearest the arc centre (16.75, 16.75) is (19.7, 19.7),
      // 4.17 mm from it: the whole box lies outside the outer outline.
      const probe = m.Manifold.cube([0.8, 0.8, 8]).translate(
        sx === 1 ? 19.7 : -20.5,
        19.7,
        8,
      );
      const hit = bin.intersect(probe);
      expect(hit.isEmpty()).toBe(true);
      hit.delete();
      probe.delete();
    }
    bin.delete();
  });

  it('stays watertight with the stacking lip and with dividers crossing the scoop', () => {
    const bin = buildBinManifold(
      m,
      params({ dividerCountX: 1, dividerCountY: 1 }),
    );
    expect(bin.status()).toBe('NoError');
    // Dividers only ever overlap the scoop's added material, so they weld in.
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('clamps the scoop radius to the wall height on a 2-unit bin', () => {
    // On a 1x1x2 bin the vertical interior wall face ends where the lip's
    // support taper starts, at 14 - 1.2 - (2.6 - 0.95) = 11.15, leaving
    // 11.15 - 7 = 4.15 mm of wall above the floor: less than the measured
    // 10 mm radius, so the fillet is clamped to radius 4.15 (centre y 15.65,
    // z 11.15).
    const bin = buildBinManifold(m, params({ heightUnits: 2 }));
    expect(bin.status()).toBe('NoError');
    expect(bin.genus()).toBe(0);
    // Nothing pokes above the lip crest apex.
    expect(bin.boundingBox().max[2]).toBeCloseTo(2 * HEIGHT_UNIT + 3.5515, 3);
    // Probe (y 17.5, z 10): outside the unclamped radius-10 arc (it would be
    // solid), but inside the clamped arc, so it stays air.
    const air = m.Manifold.cube([2, 0.5, 0.5], true).translate(0, 17.5, 10);
    const airHit = bin.intersect(air);
    expect(airHit.isEmpty()).toBe(true);
    airHit.delete();
    air.delete();
    // The clamped fillet's own material is present near the corner
    // (y 19.3, z 8: 4.82 mm from the clamped centre, outside the arc).
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
