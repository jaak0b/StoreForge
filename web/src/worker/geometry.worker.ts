import * as Comlink from 'comlink';
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ExecutionContext, ManifoldToplevel } from 'manifold-3d';
import { parse as parseFont } from 'opentype.js';
import type { Font } from 'opentype.js';
import fontUrl from '../assets/fonts/roboto-medium.ttf?url';
import {
  generateBin,
  generateInsert,
  generateInsertUnion,
  generateSlottedBin,
  generateSlottedBinUnion,
} from '../engine/gridfinity/binGenerator';
import { CarveCancelledError } from '../engine/gridfinity/carvedBin';
import { generatePocketBin, generatePocketBinUnion } from '../engine/trace/pocketBin';
import type { PocketBinParams } from '../engine/trace/pocketBin';
import {
  generateCutoutBin as carveCutoutBin,
  generateCutoutBinUnion as carveCutoutBinUnion,
  prepareCutoutModel,
  type CutoutCarveResult,
  type CutoutUnionResult,
} from '../engine/cutout/cutoutBin';
import { parseStl } from '../engine/cutout/stlReader';
import { meshToManifold } from '../engine/cutout/cutoutMesh';
import { assertNever } from '../engine/plan/types';
import {
  CutoutModelCache,
  CutoutSweptCache,
  carveModelNames,
  importCutoutModel,
  resolveCutoutModels,
  sweptMemoFor,
  type CutoutBinRequest,
  type CutoutModelFacts,
  type CutoutModelIdentity,
  type CutoutModelKeySpec,
  type CutoutPreviewResult,
} from './cutoutModels';
import { cutoutModelKey, type CutoutBinParams } from '../engine/cutout/cutoutBin';
import {
  reportCutoutModelCacheHit,
  reportCutoutModelPrepared,
  reportSweptCacheHit,
  reportSweptCacheMiss,
  timed,
} from './timing';
import type {
  BinParams,
  InsertParams,
  MeshData,
  PartMeshes,
  SlottedBinParams,
} from '../engine/gridfinity/types';

let manifoldPromise: Promise<ManifoldToplevel> | null = null;

function loadManifold(): Promise<ManifoldToplevel> {
  if (!manifoldPromise) {
    manifoldPromise = Module({
      locateFile: () => wasmUrl,
    }).then((m) => {
      m.setup();
      return m;
    });
  }
  return manifoldPromise;
}

let fontPromise: Promise<Font> | null = null;

function loadFont(): Promise<Font> {
  if (!fontPromise) {
    fontPromise = fetch(fontUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Loading the label font failed: HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => parseFont(buffer));
  }
  return fontPromise;
}

function meshBuffers(mesh: MeshData): ArrayBufferLike[] {
  return [mesh.vertices.buffer, mesh.indices.buffer];
}

function partBuffers(meshes: PartMeshes): ArrayBufferLike[] {
  const buffers = meshBuffers(meshes.body);
  if (meshes.label) buffers.push(...meshBuffers(meshes.label));
  return buffers;
}

function transferMesh(mesh: MeshData): MeshData {
  return Comlink.transfer(mesh, meshBuffers(mesh));
}

function transferMeshes(meshes: PartMeshes): PartMeshes {
  return Comlink.transfer(meshes, partBuffers(meshes));
}

/**
 * The worker's cache of prepared cutout model solids. Module scope because a
 * prepared solid outlives any one request: that is the entire point of it.
 */
const cutoutModels = new CutoutModelCache();

/**
 * The cache of swept, rotated cutter solids, beside the prepared-model cache
 * for the same reason: a swept solid outlives any one carve, and reusing it is
 * what keeps a drag end of a swept model at re-carve cost rather than
 * Minkowski cost. In memory only; a reload starts empty.
 */
const cutoutSwept = new CutoutSweptCache();

/**
 * Resolve a carve request into engine params wired to the swept-solid cache.
 * The single place every cutout carve endpoint goes through, so none of them
 * can forget the eviction: the cache keeps exactly the swept solids the
 * current carve names, which is what stops a model rotated through many
 * angles from accumulating one solid per angle.
 */
function cutoutCarveParams(request: CutoutBinRequest): CutoutBinParams {
  const models = resolveCutoutModels(cutoutModels, request.models);
  const keptKeys: string[] = [];
  const nameByKey = new Map<string, string>();
  for (const model of models) {
    if (model.sweptKey === undefined) continue;
    keptKeys.push(model.sweptKey);
    nameByKey.set(model.sweptKey, model.name);
  }
  cutoutSwept.release(keptKeys);
  const sweptMemo = sweptMemoFor(cutoutSwept, (event) => {
    const name = nameByKey.get(event.key) ?? event.key;
    switch (event.outcome) {
      case 'hit':
        reportSweptCacheHit(name);
        return;
      case 'miss':
        reportSweptCacheMiss(name, event.elapsedMs);
        return;
      default:
        return assertNever(event);
    }
  });
  return { ...request, models, sweptMemo };
}

/**
 * The ExecutionContext of the preview carve currently in flight, so a newer
 * preview can cancel the one it supersedes.
 *
 * What this can and cannot do is worth being exact about. The worker has one
 * JavaScript thread, and it is blocked inside the eager operation for the
 * whole time that operation runs, so a cancellation asked for while a carve is
 * evaluating is not delivered until that carve has already returned. What the
 * context does cover is the window before the eager operation starts, which a
 * request spends awaiting the manifold instance and the font. Export carves
 * deliberately never take part: a download must not be cancelled by a preview
 * regenerating behind it.
 */
let activePreviewContext: ExecutionContext | null = null;

/**
 * Create an ExecutionContext. The constructor exists on the loaded module but
 * is not declared on the ManifoldToplevel type, so the cast is what reaches
 * it; the ExecutionContext interface itself is declared and typed.
 */
function newExecutionContext(m: ManifoldToplevel): ExecutionContext {
  const factory = m as unknown as { ExecutionContext: new () => ExecutionContext };
  return new factory.ExecutionContext();
}

const api = {
  async generateBin(params: BinParams): Promise<MeshData> {
    const m = await loadManifold();
    return transferMesh(generateBin(m, params));
  },
  async generateSlottedBin(params: SlottedBinParams): Promise<PartMeshes> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMeshes(generateSlottedBin(m, font, params));
  },
  async generateSlottedBinUnion(params: SlottedBinParams): Promise<MeshData> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMesh(generateSlottedBinUnion(m, font, params));
  },
  async generateInsert(params: InsertParams): Promise<PartMeshes> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMeshes(generateInsert(m, font, params));
  },
  async generateInsertUnion(params: InsertParams): Promise<MeshData> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMesh(generateInsertUnion(m, font, params));
  },
  async generatePocketBin(params: PocketBinParams): Promise<PartMeshes> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMeshes(generatePocketBin(m, font, params));
  },
  async generatePocketBinUnion(params: PocketBinParams): Promise<MeshData> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMesh(generatePocketBinUnion(m, font, params));
  },

  /**
   * Which of these prepared solids the worker does not hold, so the caller can
   * send the bytes for exactly those. A miss is a normal condition, not a
   * failure: a first upload and a clearance change are the same request here.
   */
  async missingCutoutModels(specs: CutoutModelKeySpec[]): Promise<CutoutModelKeySpec[]> {
    return cutoutModels.missing(specs);
  },

  /**
   * Import one model into the cache: parse it, weld it, scale it to
   * millimetres, centre it, simplify it and dilate it by its clearance. The
   * buffer is transferred rather than copied, so the main thread must not read
   * it afterwards; the authoritative copy of a model's bytes is the blob in
   * the model store.
   *
   * An import already answered by the cache does none of that work, which is
   * the observation the timing lines are there to make visible.
   */
  async putCutoutModel(
    spec: CutoutModelIdentity,
    buffer: ArrayBuffer,
  ): Promise<CutoutModelFacts> {
    const m = await loadManifold();
    const result = importCutoutModel(cutoutModels, spec, () => {
      const solid = timed('STL parse', [spec.name], () =>
        meshToManifold(m, parseStl(buffer).mesh),
      );
      return prepareCutoutModel(m, solid, spec);
    });
    switch (result.outcome) {
      case 'hit':
        reportCutoutModelCacheHit(spec);
        return result.facts;
      case 'miss':
        reportCutoutModelPrepared(
          spec,
          result.timings,
          result.facts.triangleCount,
          result.totalMs,
        );
        return result.facts;
      default:
        return assertNever(result);
    }
  },

  /**
   * Free every cached solid the caller no longer names. This is what keeps a
   * clearance tuned through several values, or a unit scale correction
   * accepted after the fact, from accumulating superseded solids in the WASM
   * heap: those entries are under their own keys, so the caller simply stops
   * naming them.
   */
  async releaseCutoutModels(keep: CutoutModelKeySpec[]): Promise<void> {
    cutoutModels.release(keep);
    // A swept solid is derived from a prepared one, so it goes when its
    // source goes: keeping it would hold WASM memory for a solid nothing can
    // name anymore.
    cutoutSwept.retainForModelKeys(
      keep.map((spec) =>
        cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm),
      ),
    );
  },

  /**
   * Carve a cutout bin for the live preview, cancelling whatever preview it
   * supersedes. A superseded carve comes back as an outcome rather than an
   * error, because it is not a failure and must never reach the user as one.
   */
  async generateCutoutBinPreview(request: CutoutBinRequest): Promise<CutoutPreviewResult> {
    // Before the first await, so the predecessor is asked to stop at the
    // earliest moment this request can ask anything at all.
    activePreviewContext?.cancel();
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    const ctx = newExecutionContext(m);
    activePreviewContext = ctx;
    try {
      const params = cutoutCarveParams(request);
      const carve = timed('carve', carveModelNames(request.models), () =>
        carveCutoutBin(m, font, params, ctx),
      );
      const result: CutoutPreviewResult = { outcome: 'carved', ...carve };
      return Comlink.transfer(result, partBuffers(carve.meshes));
    } catch (error) {
      if (error instanceof CarveCancelledError) return { outcome: 'superseded' };
      throw error;
    } finally {
      // Each request owns the context it created, whether or not it is still
      // the active one by the time it finishes.
      if (activePreviewContext === ctx) activePreviewContext = null;
      ctx.delete();
    }
  },

  /**
   * Carve a cutout bin as separate body and label meshes for the two-filament
   * export. No ExecutionContext: an export must never be cancelled by a
   * preview regenerating behind it.
   *
   * The placement warnings cross with the meshes rather than being unwrapped
   * away here. They describe a layout the user is entitled to choose, so they
   * are not errors, but they are information the caller has to be able to act
   * on, and this boundary is not the place to decide it does not matter.
   */
  async generateCutoutBin(request: CutoutBinRequest): Promise<CutoutCarveResult> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    const params = cutoutCarveParams(request);
    const carve = timed('carve', carveModelNames(request.models), () =>
      carveCutoutBin(m, font, params),
    );
    return Comlink.transfer(carve, partBuffers(carve.meshes));
  },

  /** The same, as one unioned mesh for the single-mesh STL export. */
  async generateCutoutBinUnion(request: CutoutBinRequest): Promise<CutoutUnionResult> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    const params = cutoutCarveParams(request);
    const carve = timed('carve', carveModelNames(request.models), () =>
      carveCutoutBinUnion(m, font, params),
    );
    return Comlink.transfer(carve, meshBuffers(carve.mesh));
  },
};

export type GeometryWorkerApi = typeof api;

Comlink.expose(api);
