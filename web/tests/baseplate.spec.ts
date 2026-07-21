import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from './helpers/manifold';
import { buildFoot, manifoldToMeshData } from '../src/engine/gridfinity/binGenerator';
import {
  BASEPLATE_HEIGHT,
  MAGNET_HOLE_FROM_CELL_EDGE,
  PITCH,
} from '../src/engine/gridfinity/constants';
import {
  baseplateOuterMm,
  baseplateRiserMm,
  clipFootprintMm,
  generateBaseplate,
  generateConnectionClip,
} from '../src/engine/baseplate/generator';
import {
  CLIP_TOLERANCE_MAX,
  CONNECTOR_GROOVE_DEPTH,
  CONNECTOR_GROOVE_MOUTH_HALF,
  CONNECTOR_LENGTH,
  CONNECTOR_SLOT_FLOOR,
  MAGNET_DIAMETER_DEFAULT,
  MAGNET_DIAMETER_MAX,
  MAGNET_HEIGHT_DEFAULT,
  type BaseplateMagnets,
  type BaseplateParams,
} from '../src/engine/baseplate/constants';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

function defaultMagnets(): BaseplateMagnets {
  return { diameterMm: MAGNET_DIAMETER_DEFAULT, heightMm: MAGNET_HEIGHT_DEFAULT };
}

function params(overrides: Partial<BaseplateParams> = {}): BaseplateParams {
  return {
    unitsX: 1,
    unitsY: 1,
    magnets: null,
    screwHoles: false,
    connectable: false,
    ...overrides,
  };
}

/** Intersect the plate with a probe, return the overlap volume, delete both intermediates. */
function overlapVolume(solid: Manifold, probe: Manifold): number {
  const hit = solid.intersect(probe);
  const volume = hit.volume();
  hit.delete();
  probe.delete();
  return volume;
}

/** The magnet lattice offset from a cell centre, on the bin's own lattice. */
const MAGNET_OFFSET = PITCH / 2 - MAGNET_HOLE_FROM_CELL_EDGE;

describe('generateBaseplate', () => {
  // 4.12/1: manifold status across all 24 size and option combinations. The
  // guard on the knife-edge top rims (risk R1), which is why it sweeps
  // combinations rather than spot-checking one.
  it('is watertight for every size and option combination', () => {
    for (const [unitsX, unitsY] of [
      [1, 1],
      [2, 2],
      [3, 2],
    ] as const) {
      for (const magnets of [null, defaultMagnets()]) {
        for (const screwHoles of [false, true]) {
          for (const connectable of [false, true]) {
            const plate = generateBaseplate(
              m,
              params({ unitsX, unitsY, magnets, screwHoles, connectable }),
            );
            expect(plate.status()).toBe('NoError');
            expect(plate.isEmpty()).toBe(false);
            plate.delete();
          }
        }
      }
    }
  });

  // 4.12/2: the footprint is units * PITCH exactly, never binOuterSizeMm, and
  // the riser raises the plate to 4.65 + 3.3 at the defaults.
  it('spans exactly the pitch per cell, plus the riser with magnets or screws', () => {
    const plain = generateBaseplate(m, params({ unitsX: 3, unitsY: 2 }));
    const box = plain.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(3 * PITCH, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(2 * PITCH, 6);
    expect(box.max[2] - box.min[2]).toBeCloseTo(BASEPLATE_HEIGHT, 6);
    plain.delete();

    const risen = generateBaseplate(
      m,
      params({ unitsX: 2, unitsY: 2, magnets: defaultMagnets(), screwHoles: true }),
    );
    const riser = baseplateRiserMm(defaultMagnets(), true);
    expect(riser).toBeCloseTo(3.3, 9);
    const risenBox = risen.boundingBox();
    expect(risenBox.max[2] - risenBox.min[2]).toBeCloseTo(BASEPLATE_HEIGHT + riser, 6);
    risen.delete();
  });

  // 4.12/3: genus of the plain plate. Each open cell is a through hole, so a
  // plate with n cells is a genus-n handle body (a 1x1 plate is a square
  // annulus, topologically a solid torus). Catches an accidental floor, a
  // merged cell, or a cavity that fails to break through.
  it('has one handle per through-cell', () => {
    for (const [unitsX, unitsY] of [
      [1, 1],
      [2, 2],
      [3, 2],
    ] as const) {
      const plate = generateBaseplate(m, params({ unitsX, unitsY }));
      expect(plate.genus()).toBe(unitsX * unitsY);
      plate.delete();
    }
  });

  // 4.12/4: two-sided mating probe stated in terms of buildFoot's own output.
  // The flush seat has the foot top at plate z = 4.40 (translate -0.35),
  // where both 45 degree chamfers touch; lifted 0.05 mm the socket must
  // clear the foot everywhere, pushed 0.10 mm deeper they must collide. It
  // fails if the socket is too tight or too loose.
  it('seats a bin foot in every cell with the measured clearance', () => {
    const plate = generateBaseplate(m, params({ unitsX: 2, unitsY: 2 }));
    const foot = buildFoot(m);
    for (const cx of [-PITCH / 2, PITCH / 2]) {
      for (const cy of [-PITCH / 2, PITCH / 2]) {
        const lifted = foot.translate(cx, cy, -0.3);
        expect(Math.abs(overlapVolume(plate, lifted))).toBeLessThan(1e-9);
        const pushed = foot.translate(cx, cy, -0.45);
        expect(overlapVolume(plate, pushed)).toBeGreaterThan(0.01);
      }
    }
    foot.delete();
    plate.delete();
  });

  // 4.12/5: section widths against the measured table. A thin slab across a
  // cell-centre row leaves only the two rim bands solid, so the cavity's
  // clear extent is the plate width minus the slab's solid volume.
  it('matches the measured cavity widths at every profile band', () => {
    const plate = generateBaseplate(m, params());
    const halfDz = 0.0005;
    const dy = 0.2;
    for (const [z, expected] of [
      [halfDz, 36.3],
      [0.7, 37.7],
      [2.5, 37.7],
      [4.6, 41.9],
    ] as const) {
      const slab = m.Manifold.cube([PITCH + 2, dy, 2 * halfDz], true).translate(0, 0, z);
      const solidWidth = overlapVolume(plate, slab) / (dy * 2 * halfDz);
      expect(Math.abs(PITCH - solidWidth - expected)).toBeLessThan(1e-3);
    }
    plate.delete();
  });

  // 4.12/6: internal corners are perfectly sharp. At z = 4.0 the rim is 0.65
  // (0.75 at 3.95), so a probe past the corner point is pure cavity when the
  // corner is sharp and partly solid when it is rounded, while a probe inside
  // the web cross is fully solid.
  it('keeps internal cavity corners sharp', () => {
    const plate = generateBaseplate(m, params({ unitsX: 2, unitsY: 2 }));
    const inCavity = m.Manifold.cube([0.2, 0.2, 0.1], true).translate(0.88, 0.88, 4.0);
    expect(Math.abs(overlapVolume(plate, inCavity))).toBeLessThan(1e-9);
    const inWeb = m.Manifold.cube([0.2, 0.2, 0.1], true).translate(0.45, 0.45, 4.0);
    expect(overlapVolume(plate, inWeb)).toBeCloseTo(0.2 * 0.2 * 0.1, 3);
    plate.delete();
  });

  // 4.12/7: magnet pockets are open at every one of the 4 * unitsX * unitsY
  // positions, and a ring of boss material surrounds each.
  it('opens a magnet pocket inside a solid boss at every position', () => {
    const magnets = defaultMagnets();
    const riser = baseplateRiserMm(magnets, false);
    const plate = generateBaseplate(m, params({ unitsX: 2, unitsY: 2, magnets }));
    for (const cx of [-PITCH / 2, PITCH / 2]) {
      for (const cy of [-PITCH / 2, PITCH / 2]) {
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const x = cx + sx * MAGNET_OFFSET;
            const y = cy + sy * MAGNET_OFFSET;
            const pocket = m.Manifold.cylinder(
              magnets.heightMm - 0.2,
              (magnets.diameterMm - 0.2) / 2,
              (magnets.diameterMm - 0.2) / 2,
              16,
            ).translate(x, y, riser - magnets.heightMm + 0.1);
            expect(Math.abs(overlapVolume(plate, pocket))).toBeLessThan(1e-9);
            const ring = m.Manifold.cube([0.4, 0.4, magnets.heightMm - 0.2], true).translate(
              x + (magnets.diameterMm + 0.2) / 2 + 0.2,
              y,
              riser - magnets.heightMm / 2,
            );
            expect(overlapVolume(plate, ring)).toBeCloseTo(
              0.4 * 0.4 * (magnets.heightMm - 0.2),
              3,
            );
          }
        }
      }
    }
    plate.delete();
  });

  // 4.12/8: owner decision 1 in assertion form. The plate magnet sits at
  // PITCH/2 - MAGNET_HOLE_FROM_CELL_EDGE = 13.0 from the cell centre, the
  // bin's own position, so a plate magnet can never drift from a bin magnet.
  it('places magnets 13.0 mm from the cell centre, matching the bins', () => {
    expect(MAGNET_OFFSET).toBe(13.0);
    const magnets = defaultMagnets();
    const riser = baseplateRiserMm(magnets, false);
    const plate = generateBaseplate(m, params({ magnets }));
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const pocket = m.Manifold.cylinder(
          magnets.heightMm - 0.2,
          (magnets.diameterMm - 0.2) / 2,
          (magnets.diameterMm - 0.2) / 2,
          16,
        ).translate(sx * 13.0, sy * 13.0, riser - magnets.heightMm + 0.1);
        expect(Math.abs(overlapVolume(plate, pocket))).toBeLessThan(1e-9);
      }
    }
    plate.delete();
  });

  // 4.12/9: the pocket floor is solid with magnets alone (the magnet is
  // inserted from inside the socket and rests on it) and drilled through by
  // the concentric screw hole when screws are on.
  it('keeps the pocket floor solid until screws drill through it', () => {
    const magnets = defaultMagnets();
    const riser = baseplateRiserMm(magnets, false);
    const floor = riser - magnets.heightMm;
    const magnetsOnly = generateBaseplate(m, params({ magnets }));
    const solidFloor = m.Manifold.cube([1, 1, floor - 0.2], true).translate(13, 13, floor / 2);
    expect(overlapVolume(magnetsOnly, solidFloor)).toBeCloseTo(1 * 1 * (floor - 0.2), 3);
    magnetsOnly.delete();
    const withScrews = generateBaseplate(m, params({ magnets, screwHoles: true }));
    const drilled = m.Manifold.cube([1, 1, floor - 0.2], true).translate(13, 13, floor / 2);
    expect(Math.abs(overlapVolume(withScrews, drilled))).toBeLessThan(1e-9);
    withScrews.delete();
  });

  // 4.12/10: the connector slot removes the outer wall through its full
  // thickness above the rib, at the cell centre of every edge.
  it('cuts the connector slot through the wall above the rib', () => {
    const connectable = generateBaseplate(m, params({ connectable: true }));
    const probe = () =>
      m.Manifold.cube([1, 1.9, 0.3], true).translate(0, 21 - 2.15 + 1.9 / 2, 2.25);
    expect(Math.abs(overlapVolume(connectable, probe()))).toBeLessThan(1e-9);
    connectable.delete();
    const plain = generateBaseplate(m, params());
    expect(overlapVolume(plain, probe())).toBeCloseTo(1 * 1.9 * 0.3, 3);
    plain.delete();
  });

  // 4.12/11: the retained rib skin is 1.00 mm thick at z = 0.9 and 1.30 mm at
  // z = 1.8, measured by probe-slab intersection volume across the wall.
  it('retains the measured rib skin thicknesses', () => {
    const plate = generateBaseplate(m, params({ connectable: true }));
    for (const [z, skin] of [
      [0.9, 1.0],
      [1.8, 1.3],
    ] as const) {
      const slab = m.Manifold.cube([1, 4, 0.1], true).translate(0, 20, z);
      expect(overlapVolume(plate, slab) / (1 * 0.1)).toBeCloseTo(skin, 3);
    }
    plate.delete();
  });

  // 4.12/17: at the maximum magnet diameter the boss merges into the socket
  // wall (section 4.5); that is a union, not a failure, and the plate stays
  // manifold.
  it('stays watertight at the maximum magnet diameter', () => {
    const plate = generateBaseplate(
      m,
      params({
        unitsX: 2,
        unitsY: 2,
        magnets: { diameterMm: MAGNET_DIAMETER_MAX, heightMm: MAGNET_HEIGHT_DEFAULT },
      }),
    );
    expect(plate.status()).toBe('NoError');
    plate.delete();
  });
});

describe('generateConnectionClip', () => {
  // 4.12/12: the clip is generated standing exactly as measured: bounding box
  // [4.30, 3.6738, 19.60] at tolerance 0, watertight, genus 0.
  it('reproduces the measured connector exactly at tolerance zero', () => {
    const clip = generateConnectionClip(m, { toleranceMm: 0 });
    expect(clip.status()).toBe('NoError');
    expect(clip.genus()).toBe(0);
    const box = clip.boundingBox();
    expect(Math.abs(box.max[0] - box.min[0] - 4.3)).toBeLessThan(1e-3);
    expect(Math.abs(box.max[1] - box.min[1] - 3.6738)).toBeLessThan(1e-3);
    expect(Math.abs(box.max[2] - box.min[2] - 19.6)).toBeLessThan(1e-3);
    clip.delete();
  });

  // Regression for the CLIP_TOLERANCE_MAX bound: past the flank/groove
  // crossover the profile self-intersects, which manifold absorbed into a
  // genus -4 solid while status stayed NoError. The genus assertion is
  // therefore the one that matters: a single shell has genus 0.
  it('stays a single genus-0 shell at the maximum tolerance', () => {
    const clip = generateConnectionClip(m, { toleranceMm: CLIP_TOLERANCE_MAX });
    expect(clip.status()).toBe('NoError');
    expect(clip.genus()).toBe(0);
    clip.delete();
  });

  // 4.12/16 (first half): the tolerance shrinks the clip per mating face and
  // never leaks into the plate, whose slot is byte-identical either way
  // because the plate generator does not even accept a tolerance.
  it('shrinks the clip with the tolerance while the plate is untouched', () => {
    const clip = generateConnectionClip(m, { toleranceMm: 0.3 });
    const box = clip.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(4.3 - 0.6, 6);
    expect(box.max[2] - box.min[2]).toBeCloseTo(19.6 - 0.6, 6);
    const footprint = clipFootprintMm({ toleranceMm: 0.3 });
    expect(box.max[0] - box.min[0]).toBeCloseTo(footprint.widthMm, 6);
    expect(box.max[1] - box.min[1]).toBeLessThanOrEqual(footprint.depthMm + 1e-9);
    clip.delete();
    const plateA = generateBaseplate(m, params({ connectable: true }));
    const plateB = generateBaseplate(m, params({ connectable: true }));
    const meshA = manifoldToMeshData(plateA);
    const meshB = manifoldToMeshData(plateB);
    expect(meshA.vertices).toEqual(meshB.vertices);
    expect(meshA.indices).toEqual(meshB.indices);
    plateA.delete();
    plateB.delete();
  });
});

describe('clip assembly', () => {
  /** Two 1x1 connectable plates butted outer face to outer face at x = PITCH / 2. */
  function platePair(): Manifold {
    const plate = generateBaseplate(m, params({ connectable: true }));
    const shifted = plate.translate(PITCH, 0, 0);
    const pair = plate.add(shifted);
    shifted.delete();
    plate.delete();
    return pair;
  }

  /** Seat a clip in the joint pocket, lifted clear of the slot floor. */
  function placeClip(clip: Manifold, toleranceMm: number, liftMm: number): Manifold {
    const rotated = clip.rotate(90, 0, 0);
    const placed = rotated.translate(
      PITCH / 2,
      (CONNECTOR_LENGTH - 2 * toleranceMm) / 2,
      CONNECTOR_SLOT_FLOOR + liftMm,
    );
    rotated.delete();
    return placed;
  }

  // 4.12/13: the assembly probe. The seated clip must not interfere with the
  // plate pair, and its groove must actually engage the central rib; only the
  // second half proves the parts mate, since the first alone passes on a clip
  // that no longer grips.
  it('seats without interference and grips the rib', () => {
    const pair = platePair();
    const clip = generateConnectionClip(m, { toleranceMm: 0 });
    const placed = placeClip(clip, 0, 0.02);
    clip.delete();
    expect(Math.abs(overlapVolume(pair, placed))).toBeLessThan(1e-9);
    // The groove interior region of the seated clip must contain rib material.
    const groove = m.Manifold.cube(
      [2 * CONNECTOR_GROOVE_MOUTH_HALF, CONNECTOR_LENGTH - 2, CONNECTOR_GROOVE_DEPTH],
      true,
    ).translate(PITCH / 2, 0, CONNECTOR_SLOT_FLOOR + 0.02 + CONNECTOR_GROOVE_DEPTH / 2);
    expect(overlapVolume(pair, groove)).toBeGreaterThan(0.01);
    pair.delete();
  });

  // 4.12/16 (second half): the maximum tolerance still produces a clip whose
  // groove engages the rib.
  it('still engages the rib at the maximum tolerance', () => {
    const pair = platePair();
    const clip = generateConnectionClip(m, { toleranceMm: CLIP_TOLERANCE_MAX });
    const placed = placeClip(clip, CLIP_TOLERANCE_MAX, 0.02);
    clip.delete();
    expect(Math.abs(overlapVolume(pair, placed))).toBeLessThan(1e-9);
    const grooveDepth = CONNECTOR_GROOVE_DEPTH + CLIP_TOLERANCE_MAX;
    const groove = m.Manifold.cube(
      [
        2 * (CONNECTOR_GROOVE_MOUTH_HALF + CLIP_TOLERANCE_MAX),
        CONNECTOR_LENGTH - 2 * CLIP_TOLERANCE_MAX - 2,
        grooveDepth,
      ],
      true,
    ).translate(PITCH / 2, 0, CONNECTOR_SLOT_FLOOR + 0.02 + grooveDepth / 2);
    expect(overlapVolume(pair, groove)).toBeGreaterThan(0.01);
    pair.delete();
  });
});

describe('generateBaseplate with a brim', () => {
  function brimParams(overrides: Partial<BaseplateParams> = {}): BaseplateParams {
    return params({
      unitsX: 2,
      unitsY: 2,
      brim: { leftMm: 10, rightMm: 0, frontMm: 0, backMm: 15 },
      ...overrides,
    });
  }

  it('is watertight with a brim on two adjacent edges', () => {
    const plate = generateBaseplate(m, brimParams());
    expect(plate.status()).toBe('NoError');
    expect(plate.isEmpty()).toBe(false);
    plate.delete();
  });

  it('grows the bounding box by exactly the brim on the brimmed sides only', () => {
    const plate = generateBaseplate(m, brimParams());
    const box = plate.boundingBox();
    // Full-cell span is 2 * PITCH = 84 on each axis. Left brim 10, right 0:
    // total X span 94, offset so the right face stays at the un-brimmed edge.
    expect(box.max[0] - box.min[0]).toBeCloseTo(2 * PITCH + 10, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(2 * PITCH + 15, 6);
    // The un-brimmed right (+X) face sits exactly at the full-cell edge, PITCH.
    expect(box.max[0]).toBeCloseTo(PITCH, 6);
    // The un-brimmed front (-Y) face sits exactly at the full-cell edge, -PITCH.
    expect(box.min[1]).toBeCloseTo(-PITCH, 6);
    plate.delete();
  });

  it('matches baseplateOuterMm exactly', () => {
    const plate = generateBaseplate(m, brimParams());
    const box = plate.boundingBox();
    const outer = baseplateOuterMm(brimParams());
    expect(box.max[0] - box.min[0]).toBeCloseTo(outer.widthMm, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(outer.depthMm, 6);
    plate.delete();
  });

  it('never opens a cavity in the brim: the extension is solid, flush with the base', () => {
    // The left brim is 10 mm; a probe centred 5 mm past the left full-cell
    // edge (x = -PITCH - 5), spanning from the plate base up through the
    // full riser-free height, must be entirely filled: no socket profile, no
    // partial cavity, just a flat solid bar.
    const plate = generateBaseplate(m, brimParams());
    const probe = m.Manifold.cube([2, 4, BASEPLATE_HEIGHT - 0.01], true).translate(
      -PITCH - 5,
      -PITCH / 2,
      BASEPLATE_HEIGHT / 2,
    );
    const hit = plate.intersect(probe);
    const hitVolume = hit.volume();
    hit.delete();
    expect(hitVolume).toBeCloseTo(2 * 4 * (BASEPLATE_HEIGHT - 0.01), 3);
    plate.delete();
  });

  it('adds no handle for the brim: only the full cells carry a through-hole', () => {
    const plate = generateBaseplate(m, brimParams());
    // A brim never opens a cavity, so it never adds a handle either; the
    // genus is exactly the plain-plate genus of the 4 full cells.
    expect(plate.genus()).toBe(2 * 2);
    plate.delete();
  });

  it('stays a flat solid extension with no extra cells at any brim size, including over half a pitch', () => {
    // Every brim size from a sliver to just under one pitch must produce the
    // same flat bar and the same genus as the plain 4-cell plate: the brim
    // never carries a partial socket regardless of how large it is, matching
    // baseplateOuterMm's own footprint exactly.
    for (const leftMm of [1, 3, PITCH / 2 + 5, PITCH - 0.1]) {
      const testParams = brimParams({ brim: { leftMm, rightMm: 0, frontMm: 0, backMm: 0 } });
      const plate = generateBaseplate(m, testParams);
      expect(plate.status()).toBe('NoError');
      expect(plate.genus()).toBe(2 * 2);
      const box = plate.boundingBox();
      const outer = baseplateOuterMm(testParams);
      expect(box.max[0] - box.min[0]).toBeCloseTo(outer.widthMm, 6);
      expect(box.max[1] - box.min[1]).toBeCloseTo(outer.depthMm, 6);
      plate.delete();
    }
  });

  it('omits connector slots on brimmed edges but keeps them on plain edges', () => {
    const connectableBrim = generateBaseplate(
      m,
      brimParams({ unitsX: 1, unitsY: 1, connectable: true }),
    );
    // Left edge (brimmed, leftMm 10): the slot cutter for -X would sit at
    // x = -width/2 = -21; with a 10 mm brim material still fills where the
    // plain-edge test (4.12/10) probes the +X (right, un-brimmed) edge.
    const rightProbe = () =>
      m.Manifold.cube([1, 1.9, 0.3], true).translate(21, 0, 2.25);
    const rightHit = connectableBrim.intersect(rightProbe());
    expect(Math.abs(rightHit.volume())).toBeLessThan(1e-9); // right edge: no brim, slot present
    rightHit.delete();
    const backProbe = () =>
      m.Manifold.cube([1.9, 1, 0.3], true).translate(0, 21, 2.25);
    const backHit = connectableBrim.intersect(backProbe());
    expect(backHit.volume()).toBeCloseTo(1.9 * 1 * 0.3, 3); // back edge: brimmed, slot suppressed
    backHit.delete();
    connectableBrim.delete();
  });

  it('places magnets only at full cells, unaffected by the brim', () => {
    const magnets = { diameterMm: MAGNET_DIAMETER_DEFAULT, heightMm: MAGNET_HEIGHT_DEFAULT };
    const plate = generateBaseplate(
      m,
      brimParams({ unitsX: 1, unitsY: 1, magnets, connectable: false }),
    );
    const riser = baseplateRiserMm(magnets, false);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const pocket = m.Manifold.cylinder(
          magnets.heightMm - 0.2,
          (magnets.diameterMm - 0.2) / 2,
          (magnets.diameterMm - 0.2) / 2,
          16,
        ).translate(sx * 13.0, sy * 13.0, riser - magnets.heightMm + 0.1);
        expect(Math.abs(overlapVolume(plate, pocket))).toBeLessThan(1e-9);
      }
    }
    plate.delete();
  });
});
