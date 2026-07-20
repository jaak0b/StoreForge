import { describe, expect, it } from 'vitest';
import {
  circleSegments,
  MIN_CIRCLE_SEGMENTS,
} from '../../src/engine/geometry/circleSegments';

/** Sagitta of one segment: how far its chord departs from the arc it spans. */
function sagittaMm(radiusMm: number, segments: number): number {
  return radiusMm * (1 - Math.cos(Math.PI / segments));
}

const RADII = [0.05, 0.1, 0.4, 1, 2.5, 6, 20, 100];
const TOLERANCES = [0.01, 0.04, 0.08, 0.1, 0.2];

describe('circleSegments', () => {
  it('keeps the chordal deviation within the tolerance it is given', () => {
    // The property the derivation exists to guarantee. Asserted directly
    // rather than by comparing against a remembered count, so it stays
    // meaningful if the arithmetic is ever restated.
    for (const radiusMm of RADII) {
      for (const toleranceMm of TOLERANCES) {
        const n = circleSegments(radiusMm, toleranceMm);
        expect(sagittaMm(radiusMm, n)).toBeLessThanOrEqual(toleranceMm);
      }
    }
  });

  it('is always a multiple of four', () => {
    // Load bearing: it puts vertices at the four axis extremes, so a circle or
    // a sphere primitive measures exactly its requested diameter across each
    // axis rather than slightly less.
    for (const radiusMm of RADII) {
      for (const toleranceMm of TOLERANCES) {
        expect(circleSegments(radiusMm, toleranceMm) % 4).toBe(0);
      }
    }
  });

  it('never drops below the floor, however generous the tolerance', () => {
    // A radius small enough that its whole circle fits inside the budget would
    // otherwise derive a count of 3 and look like a triangle.
    for (const radiusMm of [0.001, 0.05, 0.1, 1]) {
      expect(circleSegments(radiusMm, 10)).toBeGreaterThanOrEqual(MIN_CIRCLE_SEGMENTS);
    }
    expect(circleSegments(0.05, 0.1)).toBe(MIN_CIRCLE_SEGMENTS);
  });

  it('asks for more segments as the radius grows and as the tolerance tightens', () => {
    // Both directions of the same relation: a longer arc and a smaller error
    // budget each need finer faceting, and neither may reduce the count.
    let previous = 0;
    for (const radiusMm of RADII) {
      const n = circleSegments(radiusMm, 0.1);
      expect(n).toBeGreaterThanOrEqual(previous);
      previous = n;
    }
    let atLooserTolerance = 0;
    for (const toleranceMm of [0.2, 0.1, 0.04, 0.01]) {
      const n = circleSegments(20, toleranceMm);
      expect(n).toBeGreaterThanOrEqual(atLooserTolerance);
      atLooserTolerance = n;
    }
  });

  it('is independent of the clearance when the tolerance is a fixed fraction of it', () => {
    // The cutout flow spends one tenth of its clearance on the offset sphere,
    // so the ratio tolerance over radius is constant and the segment count
    // comes out the same at every clearance. Section 8.2 of the design relies
    // on this: no model's offset sphere is finer than another's.
    const counts = [0.1, 0.2, 0.4, 0.8, 1, 2].map((clearanceMm) =>
      circleSegments(clearanceMm, clearanceMm / 10),
    );

    expect(new Set(counts).size).toBe(1);
  });
});
