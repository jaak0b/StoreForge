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
  manifoldToMeshData,
} from '../engine/gridfinity/binGenerator';
import {
  generateBaseplate as buildBaseplate,
  generateConnectionClip as buildConnectionClip,
} from '../engine/baseplate/generator';
import type {
  BaseplateParams,
  ConnectionClipParams,
} from '../engine/baseplate/constants';
import { CarveCancelledError } from '../engine/gridfinity/carvedBin';
import { normalizeCustomIcon, type CustomIconValidation } from '../engine/label/customIcon';
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
  cutoutCarveRecipeKey,
  importCutoutModel,
  resolveCutoutModels,
  restoreCutoutModels,
  restoreSweptSolids,
  sweptKeyOf,
  sweptMemoFor,
  type CutoutBinRequest,
  type CutoutModelFacts,
  type CutoutModelIdentity,
  type CutoutModelKeySpec,
  type CutoutPreviewResult,
} from './cutoutModels';
import { CavityEditedBodyCache } from './cavityEditedBodyCache';
import {
  pocketCarveRecipeKey,
  type PocketPreviewResult,
  type PocketBinRequest,
} from './pocketModels';
import { cutoutModelKey, type CutoutBinParams } from '../engine/cutout/cutoutBin';
import { persistedSolidsFor } from './persistedSolids';
import {
  reportCutoutModelCacheHit,
  reportCutoutModelPersistedHit,
  reportCutoutModelPrepared,
  reportSweptCacheHit,
  reportSweptCacheMiss,
  reportSweptPersistedHit,
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
 * The worker's single-entry memo for the edited body (after cavity edits are
 * folded onto a carve), beside the other two caches for the same reason: the
 * edited body outlives any one carve, so appending one more stroke reuses it
 * instead of refolding every earlier edit.
 */
const cavityEdited = new CavityEditedBodyCache();

/**
 * The pocket flow's own edited-body memo, a separate cache from the cutout
 * flow's above so the two flows never evict each other's edited body: only one
 * bin is edited at a time, but keeping the caches apart means switching between
 * a cutout bin and a pocket bin does not throw away the other's warm body.
 */
const pocketEdited = new CavityEditedBodyCache();

/**
 * Resolve a carve request into engine params wired to the swept-solid cache,
 * and run the carve with every borrowed solid pinned. The single place every
 * cutout carve endpoint goes through, so none of them can forget either the
 * eviction (the swept cache keeps exactly the keys the current carve names,
 * which is what stops a rotated model accumulating one solid per angle) or
 * the pinning.
 *
 * The pinning is the use-after-free guard: this function awaits the persisted
 * tier, and the worker's single thread services other Comlink messages during
 * that suspension, so a plan mutation's releaseCutoutModels or a concurrent
 * carve's own swept release can run while this carve's borrowed solids are in
 * flight. Both cache scopes span the carve itself, because params borrow the
 * solids and the eager carve is what consumes them; the caches defer any
 * eviction of a pinned key until the scopes close (their whilePinned owns
 * that argument).
 */
async function withCutoutCarve<T>(
  m: ManifoldToplevel,
  request: CutoutBinRequest,
  carve: (params: CutoutBinParams) => T,
): Promise<T> {
  const keptKeys: string[] = [];
  const nameByKey = new Map<string, string>();
  for (const model of request.models) {
    const key = sweptKeyOf(model);
    if (key === null) continue;
    keptKeys.push(key);
    nameByKey.set(key, model.name);
  }
  return cutoutModels.whilePinned(request.models, () =>
    cutoutSwept.whilePinned(keptKeys, async () => {
      cutoutSwept.release(keptKeys);
      // The sweep memo the carve consults is synchronous, so persisted swept
      // solids are prefetched here, by the keys this carve is about to name;
      // whatever a record answers is a memory hit by the time the memo asks.
      const persisted = persistedSolidsFor(m);
      const restored = await restoreSweptSolids(cutoutSwept, keptKeys, persisted);
      for (const { key, loadMs } of restored) {
        reportSweptPersistedHit(nameByKey.get(key) ?? key, loadMs);
      }
      const sweptMemo = sweptMemoFor(
        cutoutSwept,
        (event) => {
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
        },
        (key, entry) => persisted.saveSwept(key, entry),
      );
      const models = resolveCutoutModels(cutoutModels, request.models);
      return carve({
        ...request,
        models,
        sweptMemo,
        editedMemo: cavityEdited,
        editedRecipeKey: cutoutCarveRecipeKey(request),
      });
    }),
  );
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
   * Carve a pocket bin for the live preview, cancelling whatever preview it
   * supersedes. The mirror of generateCutoutBinPreview: it shares the same
   * activePreviewContext (only one bin is previewed at a time, so a pocket
   * preview and a cutout preview never race), and it wires the pocket flow's
   * own edited-body memo and recipe key so appending one stroke reuses the
   * previous carve. A superseded carve comes back as an outcome rather than an
   * error, because it is not a failure and must never reach the user as one.
   */
  async generatePocketBinPreview(
    request: PocketBinRequest,
  ): Promise<PocketPreviewResult> {
    // Before the first await, so the predecessor is asked to stop at the
    // earliest moment this request can ask anything at all.
    activePreviewContext?.cancel();
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    const ctx = newExecutionContext(m);
    activePreviewContext = ctx;
    try {
      const meshes = generatePocketBin(
        m,
        font,
        {
          ...request,
          editedMemo: pocketEdited,
          editedRecipeKey: pocketCarveRecipeKey(request),
        },
        ctx,
      );
      const result: PocketPreviewResult = { outcome: 'carved', meshes };
      return Comlink.transfer(result, partBuffers(meshes));
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
   * Validate and normalize a custom label icon into a single filled path,
   * unioning filled shapes and expanded strokes. Runs here because the union
   * and the stroke offsetting are Clipper2 (manifold) operations.
   */
  async validateCustomIcon(input: string): Promise<CustomIconValidation> {
    const m = await loadManifold();
    return normalizeCustomIcon(m, input);
  },

  /**
   * Generate a baseplate mesh. No font: a baseplate carries no text, so this
   * deliberately does not touch the label pipeline.
   */
  async generateBaseplate(params: BaseplateParams): Promise<MeshData> {
    const m = await loadManifold();
    const solid = buildBaseplate(m, params);
    try {
      return transferMesh(manifoldToMeshData(solid));
    } finally {
      solid.delete();
    }
  },

  /** Generate a connection clip mesh. No font, for the same reason as the baseplate. */
  async generateConnectionClip(params: ConnectionClipParams): Promise<MeshData> {
    const m = await loadManifold();
    const solid = buildConnectionClip(m, params);
    try {
      return transferMesh(manifoldToMeshData(solid));
    } finally {
      solid.delete();
    }
  },

  /**
   * Which of these prepared solids the worker does not hold, so the caller can
   * send the bytes for exactly those. A miss is a normal condition, not a
   * failure: a first upload and a clearance change are the same request here.
   */
  async missingCutoutModels(specs: CutoutModelKeySpec[]): Promise<CutoutModelKeySpec[]> {
    // A spec a persisted record answers is restored into the in-memory cache
    // here and never reported missing, so after a reload the main thread does
    // not read and send bytes for a model whose prepared solid survived. The
    // restore reports the model key's parts; the file name lives with the
    // request objects and this endpoint only sees key specs.
    const m = await loadManifold();
    const restored = await restoreCutoutModels(cutoutModels, specs, persistedSolidsFor(m));
    for (const { spec, loadMs } of restored) {
      reportCutoutModelPersistedHit(
        { name: spec.modelSourceId, unitScale: spec.unitScale, clearanceMm: spec.clearanceMm },
        loadMs,
      );
    }
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
    const persisted = persistedSolidsFor(m);
    // A persisted record can answer this import outright: restore it into the
    // in-memory cache first, so the import below becomes a hit and skips the
    // parse and the whole prepare stage.
    const restored = await restoreCutoutModels(cutoutModels, [spec], persisted);
    const result = importCutoutModel(
      cutoutModels,
      spec,
      () => {
        const solid = timed('STL parse', [spec.name], () =>
          meshToManifold(m, parseStl(buffer).mesh),
        );
        return prepareCutoutModel(m, solid, spec);
      },
      (keySpec, prepared) => persisted.savePrepared(keySpec, prepared),
    );
    switch (result.outcome) {
      case 'hit':
        if (restored.length > 0) {
          reportCutoutModelPersistedHit(spec, restored[0].loadMs);
        } else {
          reportCutoutModelCacheHit(spec);
        }
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
    // The edited-body memo is derived from the current model set, so a plan
    // mutation that releases models cannot strand a body built over solids
    // that no longer exist.
    cavityEdited.clear();
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
      const carve = await withCutoutCarve(m, request, (params) =>
        timed('carve', carveModelNames(request.models), () =>
          carveCutoutBin(m, font, params, ctx),
        ),
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
    const carve = await withCutoutCarve(m, request, (params) =>
      timed('carve', carveModelNames(request.models), () =>
        carveCutoutBin(m, font, params),
      ),
    );
    return Comlink.transfer(carve, partBuffers(carve.meshes));
  },

  /** The same, as one unioned mesh for the single-mesh STL export. */
  async generateCutoutBinUnion(request: CutoutBinRequest): Promise<CutoutUnionResult> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    const carve = await withCutoutCarve(m, request, (params) =>
      timed('carve', carveModelNames(request.models), () =>
        carveCutoutBinUnion(m, font, params),
      ),
    );
    return Comlink.transfer(carve, meshBuffers(carve.mesh));
  },
};

export type GeometryWorkerApi = typeof api;

Comlink.expose(api);
