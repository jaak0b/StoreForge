import type { Manifold } from 'manifold-3d';

/**
 * The volumes of a solid's connected components, split by sign. Manifold gives
 * an enclosed void a negative volume because its surface is inverted, so the
 * sign is what distinguishes a sealed cavity inside the material from a
 * genuinely detached piece of plastic.
 *
 * This is how validity is asserted on a carved bin. Whole-solid genus is not:
 * a Gridfinity bin has a hollow base, so a cut that pinches a slot of that
 * hollow shut seals a void and drives the genus negative on geometry that is
 * perfectly valid and perfectly watertight.
 */
export function componentVolumes(solid: Manifold): { solids: number[]; voids: number[] } {
  const volumes = solid.decompose().map((part) => part.volume());
  return {
    solids: volumes.filter((v) => v > 0),
    voids: volumes.filter((v) => v < 0),
  };
}
