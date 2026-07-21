import * as Comlink from 'comlink';
import type { GeometryWorkerApi } from './worker/geometry.worker';
import { withResolvedBinInsert, withResolvedInsertContent } from './labelIcons';
import { getModel } from './modelStore';
import { modelNotStoredMessage } from './engine/plan/missingModels';
import { cutoutModelKey } from './engine/cutout/cutoutBin';
import type { CutoutCarveResult, CutoutUnionResult } from './engine/cutout/cutoutBin';
import type {
  CutoutBinRequest,
  CutoutModelFacts,
  CutoutModelIdentity,
  CutoutModelKeySpec,
  CutoutModelRequest,
  CutoutPreviewResult,
} from './worker/cutoutModels';
import type { CustomIconValidation } from './engine/label/customIcon';
import type {
  BinParams,
  InsertParams,
  MeshData,
  PartMeshes,
  SlottedBinParams,
} from './engine/gridfinity/types';
import type { PocketBinParams } from './engine/trace/pocketBin';
import type {
  PocketBinPreviewResult,
  PocketBinRequest,
} from './worker/pocketModels';
import type {
  BaseplateParams,
  ConnectionClipParams,
} from './engine/baseplate/constants';

export type {
  CutoutBinRequest,
  CutoutModelFacts,
  CutoutModelIdentity,
  CutoutModelKeySpec,
  CutoutModelRequest,
  CutoutPreviewResult,
} from './worker/cutoutModels';
export type {
  PocketBinPreviewResult,
  PocketBinRequest,
} from './worker/pocketModels';
export type { CutoutCarveResult, CutoutUnionResult } from './engine/cutout/cutoutBin';
export type { CustomIconValidation } from './engine/label/customIcon';

let remote: Comlink.Remote<GeometryWorkerApi> | null = null;

function getWorker(): Comlink.Remote<GeometryWorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL('./worker/geometry.worker.ts', import.meta.url), {
      type: 'module',
    });
    remote = Comlink.wrap<GeometryWorkerApi>(worker);
  }
  return remote;
}

/** Generate a plain bin mesh in the geometry worker. */
export async function generateBin(params: BinParams): Promise<MeshData> {
  return getWorker().generateBin(params);
}

/**
 * Validate and normalize a custom label icon in the worker, where the manifold
 * union that merges its shapes and expands its strokes lives.
 */
export async function validateCustomIcon(input: string): Promise<CustomIconValidation> {
  return getWorker().validateCustomIcon(input);
}

/** Generate a slotted bin as separate body and preview-insert meshes. */
export async function generateSlottedBin(params: SlottedBinParams): Promise<PartMeshes> {
  return getWorker().generateSlottedBin(withResolvedBinInsert(params));
}

/** Generate a slotted bin as one unioned mesh for the STL download. */
export async function generateSlottedBinUnion(params: SlottedBinParams): Promise<MeshData> {
  return getWorker().generateSlottedBinUnion(withResolvedBinInsert(params));
}

/** Generate a label insert as separate plate and inlay meshes. */
export async function generateInsert(params: InsertParams): Promise<PartMeshes> {
  return getWorker().generateInsert(withResolvedInsertContent(params));
}

/** Generate a label insert as one unioned mesh for the STL download. */
export async function generateInsertUnion(params: InsertParams): Promise<MeshData> {
  return getWorker().generateInsertUnion(withResolvedInsertContent(params));
}

/** Generate a bin with tool-shaped pockets as separate body and preview-insert meshes. */
export async function generatePocketBin(params: PocketBinParams): Promise<PartMeshes> {
  return getWorker().generatePocketBin(withResolvedBinInsert(params));
}

/** Generate a pocket bin as one unioned mesh for the STL download. */
export async function generatePocketBinUnion(params: PocketBinParams): Promise<MeshData> {
  return getWorker().generatePocketBinUnion(withResolvedBinInsert(params));
}

/**
 * Carve a pocket bin for the live preview. A carve superseded by a newer
 * preview comes back as an outcome the caller discards, never as an error,
 * mirroring generateCutoutBinPreview.
 */
export async function generatePocketBinPreview(
  request: PocketBinRequest,
): Promise<PocketBinPreviewResult> {
  return getWorker().generatePocketBinPreview(withResolvedBinInsert(request));
}

/** Generate a baseplate mesh in the geometry worker. */
export async function generateBaseplate(params: BaseplateParams): Promise<MeshData> {
  return getWorker().generateBaseplate(params);
}

/** Generate a connection clip mesh in the geometry worker. */
export async function generateConnectionClip(
  params: ConnectionClipParams,
): Promise<MeshData> {
  return getWorker().generateConnectionClip(params);
}

/** The three values a cached model solid is keyed by, from anything carrying them. */
function keySpecOf(model: CutoutModelKeySpec): CutoutModelKeySpec {
  return {
    modelSourceId: model.modelSourceId,
    unitScale: model.unitScale,
    clearanceMm: model.clearanceMm,
  };
}

/**
 * Send the worker the bytes for every model solid it does not already hold,
 * reading them back from the model store.
 *
 * Every cutout carve goes through here first, so no caller can forget it and
 * no caller has to know how the cache works. What the worker reports missing
 * is the finished solid under a full key, so a model whose clearance or unit
 * scale changed is reported missing exactly like one never uploaded, and both
 * take this one path.
 *
 * The buffer is transferred into the worker, which moves it: this side must
 * not read it afterwards. That is safe because the blob hands out a fresh
 * buffer on every read and the stored original is untouched.
 */
async function uploadCutoutModel(model: CutoutModelIdentity): Promise<CutoutModelFacts> {
  const blob = await getModel(model.modelSourceId);
  if (blob === null) throw new Error(modelNotStoredMessage(model));
  const buffer = await blob.arrayBuffer();
  return getWorker().putCutoutModel(
    {
      modelSourceId: model.modelSourceId,
      unitScale: model.unitScale,
      clearanceMm: model.clearanceMm,
      name: model.name,
    },
    Comlink.transfer(buffer, [buffer]),
  );
}

/**
 * Run one model's import stage in the worker and report what it measured: the
 * scale, centring, simplification and clearance dilation that every later carve
 * of that model reuses.
 *
 * The editor calls this directly rather than letting the next carve pull the
 * model in, because this is the one genuinely slow step in the feature and the
 * user has to be told which row is busy while it runs. A carve that follows
 * finds the solid already cached and does no import work at all.
 *
 * Takes the same path a carve's own upload takes, so a first upload, a
 * clearance change and a unit scale change are one code path here as well as in
 * the worker.
 */
export async function importCutoutModel(
  model: CutoutModelIdentity,
): Promise<CutoutModelFacts> {
  return uploadCutoutModel(model);
}

async function ensureCutoutModels(models: CutoutModelRequest[]): Promise<void> {
  const worker = getWorker();
  const byKey = new Map(
    models.map((model) => [
      cutoutModelKey(model.modelSourceId, model.unitScale, model.clearanceMm),
      model,
    ]),
  );
  const missing = await worker.missingCutoutModels(models.map(keySpecOf));
  for (const spec of missing) {
    const model = byKey.get(
      cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm),
    );
    // The worker only ever reports back keys it was just given, so a key with
    // nothing behind it is not a user-fixable condition; it is this function
    // and the worker disagreeing, which must be seen rather than skipped.
    if (model === undefined) {
      throw new Error(`The geometry worker asked for an unknown cutout model: ${
        spec.modelSourceId
      }.`);
    }
    await uploadCutoutModel(model);
  }
}

/**
 * Drop every prepared model solid the worker holds that is not among these,
 * releasing its WASM memory. Called with the full set of key specs the page
 * still references, so clearances tried and abandoned do not accumulate while
 * a queued bin's solids survive its editor closing.
 *
 * A no-op while no worker exists: a worker never started holds nothing to
 * release, and every plan mutation runs through here, so releasing must not be
 * what boots the WASM for a user who never carved anything.
 */
export async function releaseCutoutModels(keep: CutoutModelKeySpec[]): Promise<void> {
  if (remote === null) return;
  return getWorker().releaseCutoutModels(keep.map(keySpecOf));
}

/**
 * Carve a cutout bin for the live preview. A carve superseded by a newer
 * preview comes back as an outcome the caller discards, never as an error.
 */
export async function generateCutoutBinPreview(
  request: CutoutBinRequest,
): Promise<CutoutPreviewResult> {
  await ensureCutoutModels(request.models);
  return getWorker().generateCutoutBinPreview(withResolvedBinInsert(request));
}

/** Carve a cutout bin as separate body and label meshes, with its warnings. */
export async function generateCutoutBin(
  request: CutoutBinRequest,
): Promise<CutoutCarveResult> {
  await ensureCutoutModels(request.models);
  return getWorker().generateCutoutBin(withResolvedBinInsert(request));
}

/** Carve a cutout bin as one unioned mesh for the STL download, with its warnings. */
export async function generateCutoutBinUnion(
  request: CutoutBinRequest,
): Promise<CutoutUnionResult> {
  await ensureCutoutModels(request.models);
  return getWorker().generateCutoutBinUnion(withResolvedBinInsert(request));
}
