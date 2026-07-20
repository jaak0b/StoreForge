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
  /** Whether the model's pocket is swept open upward, which flares it by the draft. */
  sweepEnabled: boolean;
  /** How far the swept walls lean outward toward the top, in degrees. */
  draftAngleDeg: number;
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
 *
 * A swept model with a positive draft angle flares its pocket outward as it
 * rises, so its widest footprint is at the interior top, wider than the model
 * plus clearance by tan(draftAngleDeg) times the height the sweep climbs. The
 * fit adds that expansion so it never under-sizes a swept bin. The height is
 * fitted first, because the flare's width depends on where the interior top
 * ends up and the sweep itself asks for no extra height: it opens the pocket
 * up to whatever top the bin has. The expansion is taken from the pocket's
 * lowest point, which is where the longest sweep column starts, so it is an
 * upper bound on the flare rather than an exact per-point figure; the carve's
 * footprint stays the authority on the exact size.
 */
export function fitBinToModels(extents: PlacedModelExtent[]): BinEnvelopeSize | null {
  if (extents.length === 0) return null;
  let topZ = 0;
  for (const { bounds, clearanceMm } of extents) {
    topZ = Math.max(topZ, bounds.maxZ + clearanceMm);
  }
  const heightUnits = Math.max(MIN_HEIGHT_UNITS, Math.ceil(topZ / HEIGHT_UNIT));
  const interiorTopZ = heightUnits * HEIGHT_UNIT;
  let halfX = 0;
  let halfY = 0;
  for (const { bounds, clearanceMm, sweepEnabled, draftAngleDeg } of extents) {
    const flareMm =
      sweepEnabled && draftAngleDeg > 0
        ? Math.tan((draftAngleDeg * Math.PI) / 180) *
          Math.max(0, interiorTopZ - (bounds.minZ - clearanceMm))
        : 0;
    const grow = clearanceMm + flareMm;
    halfX = Math.max(halfX, Math.abs(bounds.minX) + grow, bounds.maxX + grow);
    halfY = Math.max(halfY, Math.abs(bounds.minY) + grow, bounds.maxY + grow);
  }
  return {
    gridX: cellsForInteriorMm(halfX * 2),
    gridY: cellsForInteriorMm(halfY * 2),
    heightUnits,
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
