// Gridfinity bins whose interior is carved by imported STL models. The bin is
// generated as usual, its interior cavity is filled solid, and each model is
// subtracted from it as a cutter, so the pocket is the shape of the real
// object rather than an extruded outline. Everything either side of building
// the cutters is the shared carve stage in gridfinity/carvedBin.ts; this
// module owns turning a stored model plus a placement and a clearance into a
// cutter solid, its own validation, and its own generators.
//
// The work splits into a slow import stage that runs once per model per
// clearance and unit scale (scale to mm, centre, simplify, dilate) and a fast
// edit stage that runs on every placement change (rotate, translate,
// subtract). The Minkowski sum with a sphere is rotation invariant because a
// sphere is isotropic, so the dilation can be computed in the model's own
// frame and reused for every later placement.
//
// Framework-agnostic; the ManifoldToplevel and Font are injected as everywhere
// else in the engine.
import type { ExecutionContext, Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Font } from 'opentype.js';
import {
  buildInsertInSlotSolids,
  hasFusedShelf,
  labelSpecOf,
  manifoldToMeshData,
} from '../gridfinity/binGenerator';
import {
  buildCarvedBinBody,
  buildInteriorFill,
  labelStructureStrip,
} from '../gridfinity/carvedBin';
import { binInteriorSizeMm } from '../gridfinity/constants';
import { circleSegments } from '../geometry/circleSegments';
import { buildFusedLabel } from '../label/slot';
import type { MeshData, PartMeshes, SlottedBinParams } from '../gridfinity/types';

/**
 * Default dilation of a cutout pocket beyond the model surface. One nozzle
 * width, matching the extrusion width the rest of the tool assumes, which is
 * the smallest gap an FDM printer can be expected to actually leave open. The
 * single home for the figure; the store default and the plan loader default
 * both read it from here.
 */
export const DEFAULT_CUTOUT_CLEARANCE_MM = 0.4;

/**
 * Wall-clock ceiling on one model's clearance offset, in milliseconds.
 *
 * PROVISIONAL. It is not a measured figure yet: the measurement it must come
 * from is taken in the browser worker with the timing instrumentation, over a
 * sweep of triangle counts and real downloaded STLs, and it sets this constant
 * for real. Until then the value is deliberately far above any plausible
 * legitimate import, because a ceiling that fires on valid work is worse than
 * no ceiling at all.
 *
 * Be clear about what this bounds. The check runs after minkowskiSum returns,
 * so it bounds what is accepted, not what is attempted: a blocked synchronous
 * WASM call cannot be interrupted from outside, and an offset that takes ten
 * minutes still takes ten minutes. What the ceiling buys is that the app says
 * what happened and what to do about it, instead of appearing to hang forever.
 */
export const CLEARANCE_OFFSET_CEILING_MS = 120_000;

/** Where one imported model sits in the bin, in bin-local millimetres. */
export interface ModelPlacement {
  /** Position of the model's centred origin along X. */
  xMm: number;
  /** Position of the model's centred origin along Y. */
  yMm: number;
  /** Position of the model's centred origin along Z, measured from the bed. */
  zMm: number;
  /** Rotation about the global X axis, in degrees. */
  rotXDeg: number;
  /** Rotation about the global Y axis, in degrees. */
  rotYDeg: number;
  /** Rotation about the global Z axis, in degrees. */
  rotZDeg: number;
}

/** Size of a solid along the three axes, in mm. */
export interface SizeMm {
  x: number;
  y: number;
  z: number;
}

/** One model as a carve consumes it: which prepared solid, and where it goes. */
export interface CutoutModelSpec {
  /** The uploaded file's name. Every warning about this model quotes it. */
  name: string;
  /**
   * The finished import-stage solid: scaled to mm, centred, simplified and
   * dilated by its own clearance. Not owned by the carve: the caller keeps it
   * cached and hands the same solid to every later carve.
   */
  solid: Manifold;
  placement: ModelPlacement;
}

/** A slotted bin plus the models carved out of its interior. */
export interface CutoutBinParams extends SlottedBinParams {
  models: CutoutModelSpec[];
}

/**
 * What the two expensive import-stage operations cost on one model, returned
 * rather than logged. Timing the pipeline is the worker's concern, and this
 * module has to stay framework agnostic and free of environment side effects,
 * so the figures come back as values and the worker prints them.
 *
 * The post-simplify triangle count is here because it is the number that
 * decides where the imported triangle ceiling belongs: the clearance offset's
 * cost is driven by what simplify leaves behind, not by what the file
 * contained.
 */
export interface CutoutPrepareTimings {
  /** Wall clock spent in simplify, or 0 when the clearance skipped it. */
  simplifyMs: number;
  /** Wall clock spent in the Minkowski sum, or 0 when the clearance skipped it. */
  offsetMs: number;
  /** Triangle count after simplify, equal to triangleCount when it was skipped. */
  simplifiedTriangleCount: number;
}

/** A model's finished import-stage product, ready to be cached. */
export interface PreparedCutoutModel {
  /** Scaled, centred, simplified and dilated. The caller owns and caches it. */
  solid: Manifold;
  /** The model's own bounding box in mm after the unit scale, before rotation. */
  sizeMm: SizeMm;
  /** Triangle count as imported, before any simplification. */
  triangleCount: number;
  /** What this import cost, for the caller's timing instrumentation. */
  timings: CutoutPrepareTimings;
}

/** A placed cutter and the model name any warning about it must quote. */
export interface PlacedCutout {
  name: string;
  cutter: Manifold;
}

/** What a cutout carve produces beyond the solid itself. */
export interface CutoutCarve {
  body: Manifold;
  /**
   * User-worded warnings about placements that are legal but probably not what
   * the user meant. Returned, never thrown: a pocket that opens through a wall
   * is the user's decision to make.
   */
  warnings: string[];
  /**
   * Each model's footprint after its placement, including the clearance
   * dilation, taken from the transformed cutter rather than from a transformed
   * bounding box, which would overestimate every non-box shape.
   */
  footprints: { name: string; sizeMm: SizeMm }[];
}

/**
 * A carved cutout bin as its two-mesh consumers take it: the preview, which
 * colors the insert separately, and the two-filament 3MF export.
 *
 * The warnings and the footprints travel with the meshes rather than being
 * dropped at the boundary. A placement warning is information the caller has
 * to be able to act on, and the footprints are the authoritative post-dilation
 * sizes the readout shows, which nothing downstream can recompute without
 * redoing the carve.
 */
export interface CutoutCarveResult {
  meshes: PartMeshes;
  warnings: string[];
  footprints: CutoutCarve['footprints'];
}

/** The same, for the single-mesh STL export. */
export interface CutoutUnionResult {
  mesh: MeshData;
  warnings: string[];
  footprints: CutoutCarve['footprints'];
}

/**
 * The largest clearance a bin of this size can hold: half the narrowest
 * interior dimension. A dilation of half the interior across leaves the pocket
 * spanning the whole cavity from one wall to the other, so nothing beyond it
 * can describe a pocket inside the bin at all. The single home for the figure;
 * the validator message quotes it.
 */
export function maxClearanceMm(gridX: number, gridY: number): number {
  return Math.min(binInteriorSizeMm(gridX), binInteriorSizeMm(gridY)) / 2;
}

/**
 * The geometric error budget the simplification of one model may spend, in mm:
 * one tenth of that model's own clearance.
 *
 * Manifold documents a simplify tolerance as the maximum distance between the
 * original and the simplified mesh, so it is directly comparable to the
 * clearance, which is the fit budget. Spending at most a tenth of the gap on
 * simplification bounds the worst-case fit degradation at ten percent of the
 * intended gap and leaves the guarantee substantially intact.
 *
 * Per model, because the clearance is. Two models in one bin with different
 * clearances carry different tolerances and one may not be simplified at all;
 * the guarantee is per model, so there is no bin-wide fit property for a
 * bin-wide tolerance to protect.
 */
export function simplifyToleranceMm(clearanceMm: number): number {
  return clearanceMm / 10;
}

/**
 * Cache key for a model's finished import-stage solid. All three parts are
 * load bearing and each is here for the same reason: it changes the cached
 * solid. The unit scale rescales the model before it is simplified and
 * dilated, so it invalidates an entry exactly as a clearance change does.
 * Omitting either has the same silent failure mode, a preview that renders and
 * a printed part that is simply the wrong size.
 *
 * The single home for the key; the worker's cache, its miss reporting and its
 * eviction all derive it from here.
 */
export function cutoutModelKey(
  modelSourceId: string,
  unitScale: number,
  clearanceMm: number,
): string {
  return `${modelSourceId}:${unitScale}:${clearanceMm}`;
}

/** Size of a solid's axis-aligned bounding box. */
function sizeOf(solid: Manifold): SizeMm {
  const box = solid.boundingBox();
  return {
    x: box.max[0] - box.min[0],
    y: box.max[1] - box.min[1],
    z: box.max[2] - box.min[2],
  };
}

/** The clearance floor both the field validator and the import stage enforce. */
function requireNonNegativeClearance(clearanceMm: number): void {
  if (!(clearanceMm >= 0)) {
    throw new Error('The clearance must be 0 mm or more.');
  }
}

/**
 * Validate a clearance against the bin it is to be carved into. Both problems
 * are user-fixable and error with user-worded messages.
 */
export function validateClearanceMm(
  clearanceMm: number,
  gridX: number,
  gridY: number,
): void {
  requireNonNegativeClearance(clearanceMm);
  const max = maxClearanceMm(gridX, gridY);
  if (clearanceMm > max) {
    throw new Error(
      `A clearance of ${clearanceMm} mm does not fit a bin ${gridX} by ${gridY} cells, ` +
        `which allows at most ${max} mm.`,
    );
  }
}

/**
 * The import stage for one model: scale the welded solid to millimetres,
 * centre it on its own bounding box, simplify it within its error budget, and
 * dilate it by its clearance. The product is what the carve subtracts and what
 * the worker caches.
 *
 * The scale comes first and that order is forced: the simplify tolerance and
 * the clearance are millimetre figures, so they only mean what they say once
 * the solid is in millimetres. Simplifying an inch-unit solid at 0.04 mm would
 * spend more than forty times the intended error budget.
 *
 * Centring makes rotation behave: manifold rotates about the origin, so a
 * centred solid rotates about its own centre rather than swinging across the
 * bin, and three.js rotates an Object3D about its own origin too, so the ghost
 * mesh in the viewport and the carved solid agree.
 *
 * A clearance of 0 skips both the simplify and the Minkowski sum entirely.
 * There is no error budget to spend, the user asked for an exact subtraction,
 * and the import is effectively instant. The skip is per model, so one bin can
 * mix an exact model and a dilated one.
 *
 * Takes ownership of `solid`: it is deleted before returning, on the success
 * and the failure path alike.
 */
export function prepareCutoutModel(
  m: ManifoldToplevel,
  solid: Manifold,
  spec: {
    name: string;
    unitScale: number;
    clearanceMm: number;
    /**
     * Wall-clock ceiling for the offset, in milliseconds. Defaults to
     * CLEARANCE_OFFSET_CEILING_MS, which is what every production caller
     * wants; it is settable so the ceiling mechanism itself can be exercised
     * without needing a model slow enough to trip the real figure.
     */
    ceilingMs?: number;
  },
): PreparedCutoutModel {
  const { name, unitScale, clearanceMm } = spec;
  const ceilingMs = spec.ceilingMs ?? CLEARANCE_OFFSET_CEILING_MS;
  requireNonNegativeClearance(clearanceMm);
  let simplifyMs = 0;
  let offsetMs = 0;
  // Holds whichever solid this function currently owns, so a throw at any
  // stage releases exactly one solid and a success releases none.
  let current: Manifold | null = solid;
  /** Replace the working solid, deleting the one it supersedes. */
  const advance = (next: Manifold): void => {
    current!.delete();
    current = next;
  };
  try {
    const triangleCount = current.numTri();
    if (unitScale !== 1) {
      advance(current.scale([unitScale, unitScale, unitScale]));
    }
    const box = current.boundingBox();
    advance(
      current.translate([
        -(box.min[0] + box.max[0]) / 2,
        -(box.min[1] + box.max[1]) / 2,
        -(box.min[2] + box.max[2]) / 2,
      ]),
    );
    const sizeMm = sizeOf(current);
    // Equal to the imported count until a simplify runs, which a zero
    // clearance skips entirely.
    let simplifiedTriangleCount = triangleCount;

    if (clearanceMm > 0) {
      const toleranceMm = simplifyToleranceMm(clearanceMm);
      const simplifyStartedAt = Date.now();
      advance(current.simplify(toleranceMm));
      // Reading the count is what forces the simplify to be evaluated, so it
      // belongs inside the measured span rather than after it.
      simplifiedTriangleCount = current.numTri();
      simplifyMs = Date.now() - simplifyStartedAt;
      // The offset sphere's faceting error obeys the same sagitta bound as a
      // flattened circle, so its resolution comes from the shared derivation
      // spent against the same budget the simplification spends.
      //
      // The honest consequence: a faceted sphere is inscribed in the true
      // sphere, so the realized clearance dips slightly under nominal between
      // facet vertices, by at most clearanceMm * (1 - cos(pi / n)). It is
      // exact along the three axes, where the multiple-of-four rounding puts
      // vertices. At the 12 segments this budget yields that worst case is
      // 3.41 percent of the clearance, 0.0136 mm at the 0.4 mm default: below
      // the simplify tolerance already being spent and far below any FDM
      // printer's positional resolution.
      const sphere = m.Manifold.sphere(
        clearanceMm,
        circleSegments(clearanceMm, toleranceMm),
      );
      const startedAt = Date.now();
      const dilated = current.minkowskiSum(sphere);
      const elapsedMs = Date.now() - startedAt;
      offsetMs = elapsedMs;
      sphere.delete();
      advance(dilated);

      if (elapsedMs > ceilingMs) {
        const seconds = ceilingMs / 1000;
        throw new Error(
          `Applying a clearance to the model "${name}" took longer than ${seconds} ` +
            'seconds and was stopped. The model is probably too complex or has geometry ' +
            'the offset cannot handle. Simplify it in your modelling software and import ' +
            'it again, or import it with a clearance of 0 mm.',
        );
      }
      const status = current.status();
      if (status !== 'NoError') {
        // The caller appends the sentence naming the clearance the model falls
        // back to, because only it knows which one last succeeded.
        throw new Error(
          `Applying a clearance of ${clearanceMm} mm to the model "${name}" failed ` +
            `(${status}).`,
        );
      }
    }

    const prepared = {
      solid: current,
      sizeMm,
      triangleCount,
      timings: { simplifyMs, offsetMs, simplifiedTriangleCount },
    };
    // Ownership passes to the caller, which caches it.
    current = null;
    return prepared;
  } finally {
    current?.delete();
  }
}

/**
 * Move a prepared model into the bin: rotate, then translate.
 *
 * The order is forced. Rotation is about the origin, so it must happen while
 * the model is still centred there; translating first would swing it about the
 * bin's centre instead of its own. It also matches three.js, which applies an
 * Object3D's scale, then rotation, then position, so the ghost and the carve
 * agree by construction.
 *
 * Manifold rotates in extrinsic x-y-z order. A three.js Euler defaults to
 * intrinsic 'XYZ', which is extrinsic ZYX, and the two disagree for any
 * compound rotation, so the gizmo target's Euler order is set to 'ZYX' to
 * match this. The rotation-order tests hold the two conventions apart.
 *
 * Does not take ownership of `solid`, which stays cached for the next carve.
 * The returned solid belongs to the caller.
 */
export function placeCutter(solid: Manifold, placement: ModelPlacement): Manifold {
  return solid
    .rotate([placement.rotXDeg, placement.rotYDeg, placement.rotZDeg])
    .translate([placement.xMm, placement.yMm, placement.zMm]);
}

/**
 * Validate a cutout layout. Divider walls are an error, because the interior
 * is filled solid for the carve and walls have nothing to divide. Everything
 * else is returned as a user-worded warning rather than thrown: free placement
 * is the point of the tab, so a model that reaches outside the interior or
 * sits clear of it is a design decision the user is entitled to make, and the
 * bin still generates and still downloads.
 *
 * Two models that overlap are deliberately not reported. The cutters are
 * unioned before subtraction, so overlapping models merge into one pocket, and
 * composing a pocket shape that way is a legitimate technique.
 */
export function validateCutoutPlacement(
  m: ManifoldToplevel,
  params: CutoutBinParams,
  placed: PlacedCutout[],
): string[] {
  if (params.walls.length > 0) {
    throw new Error(
      'Cutout models cannot be combined with divider walls. Remove the dividers to add models.',
    );
  }
  const warnings: string[] = [];
  const interior = buildInteriorFill(m, params);
  const structure = labelStructureStrip(m, params);
  // The strip belongs to the shared carve stage, which every carve flow
  // protects the same way; only the wording is this flow's own.
  const restsOn = hasFusedShelf(params)
    ? 'the label to stand on'
    : 'the insert to rest on';
  try {
    for (const { name, cutter } of placed) {
      const inside = cutter.intersect(interior);
      const carvesNothing = inside.isEmpty();
      inside.delete();
      if (carvesNothing) {
        warnings.push(
          `The model "${name}" sits entirely outside the bin interior, so it carves ` +
            'nothing. Move it into the bin.',
        );
      } else {
        const outside = cutter.subtract(interior);
        const breaksThrough = !outside.isEmpty();
        outside.delete();
        if (breaksThrough) {
          warnings.push(
            `The model "${name}" reaches outside the bin interior, so its pocket breaks ` +
              'through the bin. Move it further in, or use a larger or taller bin.',
          );
        }
      }
      if (structure !== null) {
        const plan = cutter.project();
        const overlap = plan.intersect(structure.section);
        const overlaps = !overlap.isEmpty();
        overlap.delete();
        plan.delete();
        if (overlaps) {
          warnings.push(
            `The model "${name}" reaches under the ${structure.name}, which needs to stay ` +
              `solid for ${restsOn}. Move it away from the front wall.`,
          );
        }
      }
    }
  } finally {
    interior.delete();
    structure?.section.delete();
  }
  return warnings;
}

/**
 * Build the cutout-bin body as a manifold: place every model, validate the
 * layout, and hand the cutters to the shared carve stage, which fills the
 * interior, subtracts them and restores the label slot the fill closed.
 *
 * Unlike the traced pocket flow, the cutters are not extended past the bin
 * top. A cutter is the model wherever the user put it, so a model raised
 * through the rim opens its pocket at the top and a fully sunk one does not.
 *
 * `ctx` is handed straight to the shared carve stage, which attaches it to the
 * one eager operation of the carve. A preview passes the context it can cancel
 * when the user supersedes it; an export passes nothing.
 */
export function buildCutoutBinBody(
  m: ManifoldToplevel,
  params: CutoutBinParams,
  ctx?: ExecutionContext,
): CutoutCarve {
  const placed: PlacedCutout[] = params.models.map((model) => ({
    name: model.name,
    cutter: placeCutter(model.solid, model.placement),
  }));
  let warnings: string[];
  let footprints: { name: string; sizeMm: SizeMm }[];
  try {
    warnings = validateCutoutPlacement(m, params, placed);
    footprints = placed.map(({ name, cutter }) => ({ name, sizeMm: sizeOf(cutter) }));
  } catch (error) {
    // Ownership only passes to the carve stage, so a failure before that call
    // has to release the cutters here.
    for (const { cutter } of placed) cutter.delete();
    throw error;
  }
  const body = buildCarvedBinBody(
    m,
    params,
    placed.map(({ cutter }) => cutter),
    'Cutout bin',
    ctx,
  );
  return { body, warnings, footprints };
}

/**
 * Generate a cutout bin as separate body and (when the parameters carry the
 * paired insert's content) preview-insert meshes, mirroring generatePocketBin
 * so the insert keeps its own color. The placement warnings ride along with
 * the meshes rather than being thrown, so a legal but questionable layout
 * still produces a downloadable bin.
 */
export function generateCutoutBin(
  m: ManifoldToplevel,
  font: Font,
  params: CutoutBinParams,
  ctx?: ExecutionContext,
): CutoutCarveResult {
  const carve = buildCutoutBinBody(m, params, ctx);
  let body = carve.body;
  let label: Manifold | null = null;
  try {
    if (params.fusedLabel != null) {
      label = buildFusedLabel(m, font, labelSpecOf(params.fusedLabel), params);
    } else if (params.insert !== null) {
      const placed = buildInsertInSlotSolids(m, font, params.insert, params);
      const withPlate = m.Manifold.union([body, placed.plate]);
      body.delete();
      placed.plate.delete();
      body = withPlate;
      label = placed.label;
    }
    return {
      meshes: {
        body: manifoldToMeshData(body),
        label: label ? manifoldToMeshData(label) : null,
      },
      warnings: carve.warnings,
      footprints: carve.footprints,
    };
  } finally {
    body.delete();
    label?.delete();
  }
}

/**
 * Generate a cutout bin as one unioned mesh for the single-mesh STL download.
 * A paired insert never rides along (it is its own part), but a fused label is
 * part of the bin, so it is unioned into the single mesh.
 */
export function generateCutoutBinUnion(
  m: ManifoldToplevel,
  font: Font,
  params: CutoutBinParams,
  ctx?: ExecutionContext,
): CutoutUnionResult {
  const carve = buildCutoutBinBody(m, params, ctx);
  let body = carve.body;
  try {
    if (params.fusedLabel != null) {
      const label = buildFusedLabel(m, font, labelSpecOf(params.fusedLabel), params);
      if (label !== null) {
        const union = m.Manifold.union([body, label]);
        body.delete();
        label.delete();
        if (union.status() !== 'NoError') {
          const status = union.status();
          union.delete();
          throw new Error(`Fused cutout bin union produced an invalid solid: ${status}`);
        }
        body = union;
      }
    }
    return {
      mesh: manifoldToMeshData(body),
      warnings: carve.warnings,
      footprints: carve.footprints,
    };
  } finally {
    body.delete();
  }
}
