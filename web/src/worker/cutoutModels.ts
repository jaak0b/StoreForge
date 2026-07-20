/**
 * How a cutout carve crosses the worker boundary, and the cache of prepared
 * model solids that makes it affordable.
 *
 * A prepared model solid is a WASM heap object, so it cannot cross a thread
 * boundary and it cannot live on the main thread. The main thread therefore
 * names models rather than sending them: it uploads a model's original bytes
 * once, and every later carve refers to that model by the same three values
 * the cache is keyed by. The worker turns those names back into solids.
 *
 * The split is what the feature's whole responsiveness argument rests on. The
 * slow import stage (scale, centre, simplify, dilate) runs once per model per
 * unit scale per clearance; the fast edit stage (rotate, translate, subtract)
 * runs on every placement change. Dragging a model is cheap only because the
 * dilation it reuses was computed and kept.
 *
 * This module holds no manifold instance and performs no geometry itself, so
 * it is testable without the WASM: the import decision takes the preparation
 * as a parameter.
 */
import {
  cutoutModelKey,
  type CutoutModelSpec,
  type CutoutPlacementWarning,
  type CutoutPrepareTimings,
  type ModelPlacement,
  type PreparedCutoutModel,
  type SizeMm,
} from '../engine/cutout/cutoutBin';
import { modelNotStoredMessage } from '../engine/plan/missingModels';
import type { PartMeshes, SlottedBinParams } from '../engine/gridfinity/types';

/**
 * What a cached prepared solid is keyed by. All three parts are load bearing
 * and each is here for the same reason: it changes the solid that gets cached.
 * The unit scale rescales the model before it is simplified and dilated, so it
 * invalidates an entry exactly as a clearance change does.
 *
 * Omitting either has the same silent failure mode, and it is the worst kind:
 * the preview renders, the solid is watertight, the download succeeds, and the
 * printed part is simply the wrong size, with nothing anywhere looking wrong.
 */
export interface CutoutModelKeySpec {
  modelSourceId: string;
  unitScale: number;
  clearanceMm: number;
}

/** A key spec plus the file name every message and timing line about it quotes. */
export interface CutoutModelIdentity extends CutoutModelKeySpec {
  name: string;
}

/** One model as a carve request names it: which cached solid, and where it goes. */
export interface CutoutModelRequest extends CutoutModelIdentity {
  placement: ModelPlacement;
}

/**
 * A cutout bin as a worker request describes it: the ordinary slotted bin
 * parameters plus the models to carve out of its interior, named rather than
 * carried.
 */
export interface CutoutBinRequest extends SlottedBinParams {
  models: CutoutModelRequest[];
}

/** What the caller learns about a model the worker prepared or already had. */
export interface CutoutModelFacts {
  /** Triangle count as imported, before any simplification. */
  triangleCount: number;
  /** The model's own bounding box in mm after the unit scale, before rotation. */
  sizeMm: SizeMm;
}

/**
 * What one import did. The two outcomes are separate members rather than a
 * flag because they are separate events with different evidence: a miss
 * carries what the work cost, a hit carries nothing because no work ran.
 */
export type CutoutModelImport =
  | { outcome: 'hit'; facts: CutoutModelFacts }
  | {
      outcome: 'miss';
      facts: CutoutModelFacts;
      timings: CutoutPrepareTimings;
      /** Wall clock for the whole import, including parse, scale and centring. */
      totalMs: number;
    };

/**
 * A carve result as it crosses back, or the fact that a newer request replaced
 * this one before it finished.
 *
 * Supersession is returned as a value rather than thrown because an error does
 * not survive the structured clone that carries it across the worker boundary
 * with its identity intact: the caller would receive a plain Error and could
 * only tell supersession from a genuine failure by matching on its message.
 * A superseded preview is not a failure and must never reach the user as one.
 */
export type CutoutPreviewResult =
  | {
      outcome: 'carved';
      meshes: PartMeshes;
      warnings: CutoutPlacementWarning[];
      footprints: { name: string; sizeMm: SizeMm }[];
    }
  | { outcome: 'superseded' };

/**
 * The worker's cache of finished import-stage solids: scaled to millimetres,
 * centred, simplified and dilated, ready to be transformed and subtracted.
 *
 * Eviction is explicit rather than automatic. A solid is WASM heap memory that
 * nothing collects, and the worker cannot know when a model left the bin, so
 * the main thread says which entries it still wants and everything else goes.
 * Tuning a clearance through five values must not leave five solids behind,
 * and accepting a unit scale correction must not leave the pre-correction
 * solid behind; both fall out of keeping only what the caller still names.
 */
export class CutoutModelCache {
  private readonly entries = new Map<string, PreparedCutoutModel>();

  private static keyOf(spec: CutoutModelKeySpec): string {
    return cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm);
  }

  /** The prepared model under this key, or undefined when it is not cached. */
  get(spec: CutoutModelKeySpec): PreparedCutoutModel | undefined {
    return this.entries.get(CutoutModelCache.keyOf(spec));
  }

  /**
   * Which of these specs the cache does not hold, in the order given. A miss
   * is not an error: it is how the worker asks for the bytes it needs, and a
   * first upload and a clearance change take the same path because of it.
   */
  missing(specs: CutoutModelKeySpec[]): CutoutModelKeySpec[] {
    return specs.filter((spec) => !this.entries.has(CutoutModelCache.keyOf(spec)));
  }

  /**
   * Take ownership of a prepared model. Replacing an entry deletes the solid
   * it supersedes, so re-importing under a key already held cannot leak.
   */
  put(spec: CutoutModelKeySpec, prepared: PreparedCutoutModel): void {
    const key = CutoutModelCache.keyOf(spec);
    this.entries.get(key)?.solid.delete();
    this.entries.set(key, prepared);
  }

  /** Delete every cached solid whose key is not among the ones to keep. */
  release(keep: CutoutModelKeySpec[]): void {
    const kept = new Set(keep.map((spec) => CutoutModelCache.keyOf(spec)));
    for (const [key, prepared] of this.entries) {
      if (kept.has(key)) continue;
      prepared.solid.delete();
      this.entries.delete(key);
    }
  }

  /** How many solids are held. For the eviction tests and for diagnostics. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Import one model, or recognise that its prepared solid is already cached.
 *
 * The single home for that decision, and the reason the feature is usable at
 * all: a hit skips the parse, the simplify and the Minkowski sum entirely, and
 * those are the whole cost of an import. `prepare` is a parameter so the
 * decision can be exercised without a manifold instance, and so a test can
 * count how many times the expensive work actually ran.
 */
export function importCutoutModel(
  cache: CutoutModelCache,
  spec: CutoutModelKeySpec,
  prepare: () => PreparedCutoutModel,
): CutoutModelImport {
  const cached = cache.get(spec);
  if (cached !== undefined) {
    return {
      outcome: 'hit',
      facts: { triangleCount: cached.triangleCount, sizeMm: cached.sizeMm },
    };
  }
  const startedAt = Date.now();
  const prepared = prepare();
  const totalMs = Date.now() - startedAt;
  cache.put(spec, prepared);
  return {
    outcome: 'miss',
    facts: { triangleCount: prepared.triangleCount, sizeMm: prepared.sizeMm },
    timings: prepared.timings,
    totalMs,
  };
}

/**
 * Turn the models a carve request names into the cutter specs the carve
 * consumes. A model whose solid is not cached blocks generation with the same
 * sentence the plan layer uses for a model this device has no bytes for,
 * because from the user's side it is the same condition: the model the bin
 * needs is not available, and the answer is to upload it again.
 *
 * The returned specs borrow the cached solids; the carve never takes ownership
 * of them, so they stay cached for the next placement change.
 */
export function resolveCutoutModels(
  cache: CutoutModelCache,
  requests: CutoutModelRequest[],
): CutoutModelSpec[] {
  return requests.map((request) => {
    const cached = cache.get(request);
    if (cached === undefined) throw new Error(modelNotStoredMessage(request));
    return { name: request.name, solid: cached.solid, placement: request.placement };
  });
}

/** The model names one timing line about a whole carve quotes. */
export function carveModelNames(requests: CutoutModelRequest[]): string[] {
  return requests.map((request) => request.name);
}
