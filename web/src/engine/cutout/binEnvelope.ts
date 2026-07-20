// Where the bin interior is, in the same bin-local millimetre frame a cutout
// model's placement is expressed in, and how large a bin has to be to hold the
// models the user has placed. Framework-agnostic and free of WASM: both are
// comparisons of numbers, so the editor can answer them every frame without a
// worker call.
import {
  binInteriorSizeMm,
  cellsForInteriorMm,
  FLOOR_TOP,
  HEIGHT_UNIT,
  MIN_HEIGHT_UNITS,
} from '../gridfinity/constants';
import type { ModelPlacement } from './cutoutBin';
import type { MeshBounds } from './cutoutMesh';

/** The footprint and height of a bin, as the designer form holds them. */
export interface BinEnvelopeSize {
  gridX: number;
  gridY: number;
  heightUnits: number;
}

/**
 * One placed model as the fit consumes it: where its triangles actually are,
 * and how far its pocket is dilated beyond them.
 */
export interface PlacedModelExtent {
  /** Exact bounds of the placed model in bin-local mm, clearance excluded. */
  bounds: MeshBounds;
  /** The model's clearance, which grows its pocket by that much on every side. */
  clearanceMm: number;
}

/**
 * The bin interior as an axis-aligned box in bin-local millimetres: centred on
 * the origin in X and Y, running from the top of the interior floor up to the
 * nominal bin top in Z. The same span buildInteriorFill extrudes, from the same
 * figures, so the box the editor judges a placement against and the solid the
 * carve subtracts from are the same interior.
 *
 * The rounded interior corners are not modelled, exactly as the traced flow's
 * layout sizing does not model them: this is the interior's bounding box, and
 * the carve's exact containment check stays the authority on whether a shape
 * fits. The consequence is confined to the corners, where a model may be
 * reported as fitting and still break through; the carve then says so.
 */
export function interiorBoundsMm(
  gridX: number,
  gridY: number,
  heightUnits: number,
): MeshBounds {
  const halfX = binInteriorSizeMm(gridX) / 2;
  const halfY = binInteriorSizeMm(gridY) / 2;
  const topZ = heightUnits * HEIGHT_UNIT;
  return {
    minX: -halfX,
    minY: -halfY,
    minZ: FLOOR_TOP,
    maxX: halfX,
    maxY: halfY,
    maxZ: topZ,
    sizeX: halfX * 2,
    sizeY: halfY * 2,
    sizeZ: topZ - FLOOR_TOP,
  };
}

/**
 * The smallest bin envelope whose interior contains every placed model's
 * pocket, or null when there are no models to fit to.
 *
 * The models are not moved. Placement is the user's own work and the gizmo is
 * the only thing that writes it, so the fit grows the bin around the models
 * where they stand rather than re-centring them: a model sitting off to one
 * side therefore costs cells on both sides, because the bin interior is centred
 * on the origin and cannot be offset.
 *
 * Each model's clearance is added on every side, because the pocket and not the
 * model is what has to fit inside the walls. Depth below the interior floor is
 * not fitted: the floor sits at a fixed height above the bed, so no bin size
 * can contain a model placed under it, and the carve's warning is what covers
 * that case.
 */
export function fitBinToModels(extents: PlacedModelExtent[]): BinEnvelopeSize | null {
  if (extents.length === 0) return null;
  let halfX = 0;
  let halfY = 0;
  let topZ = 0;
  for (const { bounds, clearanceMm } of extents) {
    halfX = Math.max(halfX, Math.abs(bounds.minX) + clearanceMm, bounds.maxX + clearanceMm);
    halfY = Math.max(halfY, Math.abs(bounds.minY) + clearanceMm, bounds.maxY + clearanceMm);
    topZ = Math.max(topZ, bounds.maxZ + clearanceMm);
  }
  return {
    gridX: cellsForInteriorMm(halfX * 2),
    gridY: cellsForInteriorMm(halfY * 2),
    heightUnits: Math.max(MIN_HEIGHT_UNITS, Math.ceil(topZ / HEIGHT_UNIT)),
  };
}

/**
 * How far a placed model's lowest point sits above the interior floor, in mm.
 * Negative when it reaches into the floor. The readout's own row, so a model
 * that looks seated in the viewport can be checked against a number.
 */
export function restingHeightMm(bounds: MeshBounds): number {
  return bounds.minZ - FLOOR_TOP;
}

/** True when a placed model's bounds lie entirely inside the interior box. */
export function fitsInterior(bounds: MeshBounds, interior: MeshBounds): boolean {
  return (
    bounds.minX >= interior.minX &&
    bounds.minY >= interior.minY &&
    bounds.minZ >= interior.minZ &&
    bounds.maxX <= interior.maxX &&
    bounds.maxY <= interior.maxY &&
    bounds.maxZ <= interior.maxZ
  );
}

/**
 * Where a freshly imported model is dropped: centred over the bin floor with
 * its underside resting on it, and unrotated. The model's own frame is centred
 * on its bounding box (prepareCutoutModel centres it there), so seating it on
 * the floor is half its height above the floor top.
 */
export function restingPlacementMm(sizeZMm: number): ModelPlacement {
  return {
    xMm: 0,
    yMm: 0,
    zMm: FLOOR_TOP + sizeZMm / 2,
    rotXDeg: 0,
    rotYDeg: 0,
    rotZDeg: 0,
  };
}
