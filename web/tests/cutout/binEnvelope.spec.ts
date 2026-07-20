import { describe, expect, it } from 'vitest';
import {
  fitBinToModels,
  fitsInterior,
  interiorBoundsMm,
  restingHeightMm,
  restingPlacementMm,
  type PlacedModelExtent,
} from '../../src/engine/cutout/binEnvelope';
import {
  binInteriorSizeMm,
  FLOOR_TOP,
  HEIGHT_UNIT,
  MIN_HEIGHT_UNITS,
} from '../../src/engine/gridfinity/constants';
import type { MeshBounds } from '../../src/engine/cutout/cutoutMesh';

/** A bounds record from its extents, so the tests read as placements. */
function bounds(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): MeshBounds {
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}

function extent(b: MeshBounds, clearanceMm = 0): PlacedModelExtent {
  return { bounds: b, clearanceMm };
}

describe('interiorBoundsMm', () => {
  it('spans the interior between the walls and from the floor to the bin top', () => {
    const box = interiorBoundsMm(2, 3, 6);
    expect(box.sizeX).toBeCloseTo(binInteriorSizeMm(2), 10);
    expect(box.sizeY).toBeCloseTo(binInteriorSizeMm(3), 10);
    expect(box.minX).toBeCloseTo(-box.maxX, 10);
    expect(box.minZ).toBe(FLOOR_TOP);
    expect(box.maxZ).toBe(6 * HEIGHT_UNIT);
  });
});

describe('fitsInterior', () => {
  const interior = interiorBoundsMm(2, 2, 6);

  it('accepts a model sitting inside the walls and above the floor', () => {
    expect(fitsInterior(bounds(-10, 10, -10, 10, FLOOR_TOP, 20), interior)).toBe(true);
  });

  it('rejects a model reaching through a wall', () => {
    const half = interior.maxX + 1;
    expect(fitsInterior(bounds(-half, half, -10, 10, FLOOR_TOP, 20), interior)).toBe(false);
  });

  it('rejects a model reaching below the interior floor', () => {
    expect(fitsInterior(bounds(-10, 10, -10, 10, FLOOR_TOP - 1, 20), interior)).toBe(false);
  });
});

describe('fitBinToModels', () => {
  it('has nothing to fit to when there are no models', () => {
    expect(fitBinToModels([])).toBeNull();
  });

  it('grows the footprint until the interior contains every model', () => {
    // Wider than a single cell's interior, so one cell cannot be the answer.
    const wide = bounds(-30, 30, -8, 8, FLOOR_TOP, 20);
    const fit = fitBinToModels([extent(wide)])!;
    expect(binInteriorSizeMm(fit.gridX)).toBeGreaterThanOrEqual(60);
    expect(binInteriorSizeMm(fit.gridX - 1)).toBeLessThan(60);
    expect(fitsInterior(wide, interiorBoundsMm(fit.gridX, fit.gridY, fit.heightUnits))).toBe(
      true,
    );
  });

  it('counts the clearance, because the pocket and not the model has to fit', () => {
    const b = bounds(-30, 30, -8, 8, FLOOR_TOP, 20);
    const tight = fitBinToModels([extent(b, 0)])!;
    const loose = fitBinToModels([extent(b, 20)])!;
    expect(loose.gridX).toBeGreaterThan(tight.gridX);
  });

  // The bin interior is centred on the origin and cannot be offset, so a model
  // pushed to one side costs cells on both sides. Re-centring the models would
  // move the user's own placement, which only the gizmo is allowed to do.
  it('does not move an off-centre model to save cells', () => {
    const centred = bounds(-20, 20, -8, 8, FLOOR_TOP, 20);
    const offCentre = bounds(40, 80, -8, 8, FLOOR_TOP, 20);
    expect(fitBinToModels([extent(offCentre)])!.gridX).toBeGreaterThan(
      fitBinToModels([extent(centred)])!.gridX,
    );
  });

  it('raises the bin until its top clears the tallest model', () => {
    const tall = bounds(-8, 8, -8, 8, FLOOR_TOP, 50);
    const fit = fitBinToModels([extent(tall)])!;
    expect(fit.heightUnits * HEIGHT_UNIT).toBeGreaterThanOrEqual(50);
    expect((fit.heightUnits - 1) * HEIGHT_UNIT).toBeLessThan(50);
  });

  it('never proposes a bin with no interior at all', () => {
    const flat = bounds(-2, 2, -2, 2, 0, 1);
    expect(fitBinToModels([extent(flat)])!.heightUnits).toBe(MIN_HEIGHT_UNITS);
  });

  it('fits every model at once, not just the first', () => {
    const small = bounds(-5, 5, -5, 5, FLOOR_TOP, 12);
    const big = bounds(-45, 45, -45, 45, FLOOR_TOP, 40);
    const fit = fitBinToModels([extent(small), extent(big)])!;
    const interior = interiorBoundsMm(fit.gridX, fit.gridY, fit.heightUnits);
    expect(fitsInterior(small, interior)).toBe(true);
    expect(fitsInterior(big, interior)).toBe(true);
  });
});

describe('restingPlacementMm', () => {
  it('seats a freshly imported model on the interior floor, unrotated', () => {
    const placement = restingPlacementMm(12);
    expect(placement.xMm).toBe(0);
    expect(placement.yMm).toBe(0);
    expect(placement.rotXDeg).toBe(0);
    expect(placement.rotYDeg).toBe(0);
    expect(placement.rotZDeg).toBe(0);
    // The model's own frame is centred on its bounding box, so its underside is
    // half its height below the placement.
    expect(placement.zMm - 12 / 2).toBe(FLOOR_TOP);
  });
});

describe('restingHeightMm', () => {
  it('measures from the interior floor, and goes negative inside it', () => {
    expect(restingHeightMm(bounds(0, 1, 0, 1, FLOOR_TOP + 3, 10))).toBeCloseTo(3, 10);
    expect(restingHeightMm(bounds(0, 1, 0, 1, FLOOR_TOP - 2, 10))).toBeCloseTo(-2, 10);
  });
});
