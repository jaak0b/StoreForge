import * as Comlink from 'comlink';
import type { GeometryWorkerApi } from './worker/geometry.worker';
import { withResolvedIconPath } from './labelIcons';
import type {
  BinParams,
  LabeledBinMeshes,
  LabeledBinParams,
  MeshData,
} from './engine/gridfinity/types';
import type { AutoGridResult, PocketBinParams } from './engine/trace/pocketBin';
import type { TracedTool, ToolPlacement } from './engine/trace/types';

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

/** Generate a labeled bin as separate body and label meshes for the preview. */
export async function generateLabeledBin(
  params: LabeledBinParams,
): Promise<LabeledBinMeshes> {
  return getWorker().generateLabeledBin(withResolvedIconPath(params));
}

/** Generate a labeled bin as one unioned mesh for the STL download. */
export async function generateLabeledBinUnion(
  params: LabeledBinParams,
): Promise<MeshData> {
  return getWorker().generateLabeledBinUnion(withResolvedIconPath(params));
}

/** Generate a bin with tool-shaped pockets as separate body and label meshes. */
export async function generatePocketBin(
  params: PocketBinParams,
): Promise<LabeledBinMeshes> {
  return getWorker().generatePocketBin(withResolvedIconPath(params));
}

/** Generate a pocket bin as one unioned mesh for the STL download. */
export async function generatePocketBinUnion(
  params: PocketBinParams,
): Promise<MeshData> {
  return getWorker().generatePocketBinUnion(withResolvedIconPath(params));
}

/**
 * Smallest bin footprint whose interior fits every placed pocket with the
 * margin, plus the offset that centres the layout in that footprint.
 */
export async function autoPocketGridSize(
  tools: TracedTool[],
  placements: ToolPlacement[],
  marginMm: number,
): Promise<AutoGridResult> {
  // Deep JSON copies strip Vue reactivity proxies, which structured clone rejects.
  return getWorker().autoPocketGridSize(
    JSON.parse(JSON.stringify(tools)) as TracedTool[],
    JSON.parse(JSON.stringify(placements)) as ToolPlacement[],
    marginMm,
  );
}
