import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import {
  applyCavityEdits,
  cavityEditsKey,
  simplifyStroke,
  strokeSolid,
  flattenSolid,
} from '../../src/engine/cutout/cavityEdits';
import type { CavityEdit, Vec3Mm } from '../../src/engine/plan/types';

let m: ManifoldToplevel;
beforeAll(async () => {
  m = await loadManifold();
});

const p = (xMm: number, yMm: number, zMm: number): Vec3Mm => ({ xMm, yMm, zMm });

/** A 40 x 40 x 20 mm box standing on the bed, a stand-in bin envelope. */
function box(): Manifold {
  return m.Manifold.cube([40, 40, 20], false);
}

describe('strokeSolid', () => {
  it('builds a watertight connected capsule chain from a multi-segment stroke', () => {
    const solid = strokeSolid(m, [p(5, 5, 5), p(20, 5, 5), p(20, 20, 5), p(30, 20, 12)], 2);
    expect(solid.status()).toBe('NoError');
    expect(solid.numTri()).toBeGreaterThan(0);
    expect(solid.decompose()).toHaveLength(1);
    expect(solid.genus()).toBe(0);
    solid.delete();
  });

  it('builds a single sphere from a single point', () => {
    const solid = strokeSolid(m, [p(0, 0, 0)], 3);
    const sphereVolume = (4 / 3) * Math.PI * 27;
    // A faceted sphere is inscribed in the true sphere, so under but near.
    // At the shared circleSegments floor (12 segments, the same floor the
    // clearance offset sphere in cutoutBin.ts accepts and documents), a
    // sphere's volume deviation is larger than its surface sagitta bound, so
    // the accepted margin here is looser than a single circle's tolerance.
    expect(solid.volume()).toBeGreaterThan(sphereVolume * 0.8);
    expect(solid.volume()).toBeLessThanOrEqual(sphereVolume);
    solid.delete();
  });
});

describe('simplifyStroke', () => {
  it('collapses collinear points and keeps genuine corners', () => {
    const stroke = [p(0, 0, 0), p(1, 0.01, 0), p(2, 0, 0), p(3, -0.01, 0), p(4, 0, 0), p(4, 5, 0)];
    const simplified = simplifyStroke(stroke, 0.5);
    expect(simplified[0]).toEqual(stroke[0]);
    expect(simplified[simplified.length - 1]).toEqual(stroke[stroke.length - 1]);
    expect(simplified.length).toBeLessThan(stroke.length);
    expect(simplified).toContainEqual(p(4, 0, 0));
  });
});

describe('applyCavityEdits', () => {
  function carvedBody(): Manifold {
    // The box with a pocket already carved, standing in for a carved bin.
    const envelope = box();
    const pocket = m.Manifold.cube([10, 10, 10], false).translate([15, 15, 10]);
    const body = envelope.subtract(pocket);
    envelope.delete();
    pocket.delete();
    return body;
  }

  it('add increases volume but never past the un-carved envelope', () => {
    const binSolid = box();
    const before = carvedBody();
    const beforeVolume = before.volume();
    const edits: CavityEdit[] = [
      { kind: 'add', points: [p(20, 20, 15), p(20, 20, 25)], radiusMm: 4 },
    ];
    const after = applyCavityEdits(m, before, binSolid, edits, 20);
    expect(after.status()).toBe('NoError');
    expect(after.volume()).toBeGreaterThan(beforeVolume);
    expect(after.volume()).toBeLessThanOrEqual(binSolid.volume());
    after.delete();
    binSolid.delete();
  });

  it('remove decreases volume', () => {
    const binSolid = box();
    const before = carvedBody();
    const beforeVolume = before.volume();
    const after = applyCavityEdits(m, before, binSolid, [
      { kind: 'remove', points: [p(5, 5, 18), p(35, 5, 18)], radiusMm: 3 },
    ], 20);
    expect(after.volume()).toBeLessThan(beforeVolume);
    after.delete();
    binSolid.delete();
  });

  it('flatten leaves no material above the plane inside the brush circle', () => {
    const binSolid = box();
    const before = carvedBody();
    const after = applyCavityEdits(m, before, binSolid, [
      { kind: 'flatten', centerMm: p(10, 10, 15), radiusMm: 5, planeZMm: 12 },
    ], 20);
    // Probe: intersect the result with the flatten cylinder region above the plane.
    // The probe is geometrically coincident with the cylinder that was just
    // subtracted, so the intersection's boundary faces are tangent; Manifold
    // can leave a handful of zero-volume sliver triangles there rather than
    // reporting a strictly empty mesh (a documented floating-point boolean
    // edge case for exactly coincident surfaces), so the meaningful check is
    // that no volume remains, not that the vertex list is empty.
    const probe = flattenSolid(m, { centerMm: p(10, 10, 15), radiusMm: 5, planeZMm: 12 }, 20);
    const above = after.intersect(probe);
    expect(above.volume()).toBeLessThan(1e-6);
    above.delete();
    probe.delete();
    after.delete();
    binSolid.delete();
  });

  it('is order dependent for an overlapping add and remove pair', () => {
    const binSolid = box();
    const add: CavityEdit = { kind: 'add', points: [p(18, 18, 14)], radiusMm: 5 };
    const remove: CavityEdit = { kind: 'remove', points: [p(20, 20, 14)], radiusMm: 5 };
    const a = applyCavityEdits(m, carvedBody(), binSolid, [add, remove], 20);
    const b = applyCavityEdits(m, carvedBody(), binSolid, [remove, add], 20);
    expect(Math.abs(a.volume() - b.volume())).toBeGreaterThan(1);
    a.delete();
    b.delete();
    binSolid.delete();
  });

  it('rejects an edit that empties the body with a user-worded message', () => {
    const binSolid = box();
    const before = box();
    expect(() =>
      applyCavityEdits(m, before, binSolid, [
        { kind: 'remove', points: [p(20, 20, 10)], radiusMm: 50 },
      ], 20),
    ).toThrow(/entire bin/);
    binSolid.delete();
  });
});

describe('cavityEditsKey', () => {
  it('is stable for equal lists and differs on any change', () => {
    const edits: CavityEdit[] = [{ kind: 'add', points: [p(1, 2, 3)], radiusMm: 2 }];
    expect(cavityEditsKey(edits)).toBe(cavityEditsKey([{ kind: 'add', points: [p(1, 2, 3)], radiusMm: 2 }]));
    expect(cavityEditsKey(edits)).not.toBe(cavityEditsKey([{ kind: 'remove', points: [p(1, 2, 3)], radiusMm: 2 }]));
    expect(cavityEditsKey([])).toBe(cavityEditsKey([]));
  });
});
