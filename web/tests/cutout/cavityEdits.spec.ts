import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import {
  applyCavityEdits,
  cavityEditsKey,
  isCavityEditRejectionMessage,
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
    const after = applyCavityEdits(m, before, binSolid, edits);
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
    ]);
    expect(after.volume()).toBeLessThan(beforeVolume);
    after.delete();
    binSolid.delete();
  });

  it('flatten leaves no material above the plane inside the brush circle', () => {
    const binSolid = box();
    const before = carvedBody();
    const edit = {
      kind: 'flatten' as const,
      centerMm: p(10, 10, 12),
      radiusMm: 5,
      normalMm: p(0, 0, 1),
    };
    const after = applyCavityEdits(m, before, binSolid, [edit]);
    // Probe: intersect the result with the flatten cylinder region above the plane.
    // The probe is geometrically coincident with the cylinder that was just
    // subtracted, so the intersection's boundary faces are tangent; Manifold
    // can leave a handful of zero-volume sliver triangles there rather than
    // reporting a strictly empty mesh (a documented floating-point boolean
    // edge case for exactly coincident surfaces), so the meaningful check is
    // that no volume remains, not that the vertex list is empty.
    const probe = flattenSolid(m, edit, binSolid);
    const above = after.intersect(probe);
    expect(above.volume()).toBeLessThan(1e-6);
    above.delete();
    probe.delete();
    after.delete();
    binSolid.delete();
  });

  it('flatten on a wall-facing normal removes a bump protruding past the wall but leaves material behind it', () => {
    const binSolid = box();
    // A cavity void carved out of the envelope for x in [0, 30] (air, open
    // all the way to the bin's front face so no unrelated wall sits in the
    // brush's path), with solid wall material for x in [30, 40]. A bump
    // defect fills part of the void back in, from the wall at x=30 out to
    // x=25, as if a stray sliver of solid protrudes into what should be
    // open cavity air.
    const cavityVoid = m.Manifold.cube([30, 20, 15], false).translate([0, 10, 0]);
    const bump = m.Manifold.cube([5, 8, 8], false).translate([25, 13, 3]);
    const envelope = box();
    const withCavity = envelope.subtract(cavityVoid);
    cavityVoid.delete();
    const before = withCavity.add(bump);
    withCavity.delete();
    bump.delete();
    const edit = {
      kind: 'flatten' as const,
      // Tangent plane x=30 (the wall), outward normal -X (into the cavity
      // air): removes solid material found on the air side of the wall. The
      // radius (6) comfortably covers the bump's corners (at radius
      // sqrt(4^2+4^2) ~ 5.66 from the centre) with the round brush, while
      // staying inside the cavity void's own y/z margins (radius 7) so the
      // brush never reaches solid outside the cavity.
      centerMm: p(30, 17, 7),
      radiusMm: 6,
      normalMm: p(-1, 0, 0),
    };
    const after = applyCavityEdits(m, before, binSolid, [edit]);
    // Probe the air-side half-space (x < 30, within the brush disc): the bump
    // is fully shaved away, nothing remains there.
    const probe = flattenSolid(m, edit, binSolid);
    const above = after.intersect(probe);
    expect(above.volume()).toBeLessThan(1e-6);
    above.delete();
    probe.delete();
    // Material behind the plane (the solid wall for x >= 30, untouched by the
    // brush) survives: the flattened body matches the bump-free cavity.
    const bumplessCavityVoid = m.Manifold.cube([30, 20, 15], false).translate([0, 10, 0]);
    const bumplessEnvelope = box();
    const baseline = bumplessEnvelope.subtract(bumplessCavityVoid);
    bumplessCavityVoid.delete();
    expect(Math.abs(after.volume() - baseline.volume())).toBeLessThan(1);
    baseline.delete();
    after.delete();
    binSolid.delete();
  });

  it('is order dependent for an overlapping add and remove pair', () => {
    const binSolid = box();
    const add: CavityEdit = { kind: 'add', points: [p(18, 18, 14)], radiusMm: 5 };
    const remove: CavityEdit = { kind: 'remove', points: [p(20, 20, 14)], radiusMm: 5 };
    const a = applyCavityEdits(m, carvedBody(), binSolid, [add, remove]);
    const b = applyCavityEdits(m, carvedBody(), binSolid, [remove, add]);
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
      ]),
    ).toThrow(/entire bin/);
    binSolid.delete();
  });

  it('throws a message isCavityEditRejectionMessage recognizes', () => {
    const binSolid = box();
    const before = box();
    let thrown: unknown;
    try {
      applyCavityEdits(m, before, binSolid, [
        { kind: 'remove', points: [p(20, 20, 10)], radiusMm: 50 },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(isCavityEditRejectionMessage((thrown as Error).message)).toBe(true);
    binSolid.delete();
  });
});

describe('isCavityEditRejectionMessage', () => {
  it('recognizes the emptied-bin and invalid-solid messages', () => {
    expect(
      isCavityEditRejectionMessage(
        'The cavity edits removed the entire bin, so the last edit was not applied.',
      ),
    ).toBe(true);
    expect(
      isCavityEditRejectionMessage('Applying the cavity edits produced an invalid solid (NonManifoldEdge).'),
    ).toBe(true);
  });

  it('rejects unrelated carve failures so an unrelated failure never rolls back a good edit', () => {
    expect(isCavityEditRejectionMessage('The model "widget.stl" is no longer stored on this device.')).toBe(
      false,
    );
    expect(
      isCavityEditRejectionMessage(
        'Cutout models cannot be combined with divider walls. Remove the dividers to add models.',
      ),
    ).toBe(false);
    expect(isCavityEditRejectionMessage('Generating the preview failed.')).toBe(false);
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
