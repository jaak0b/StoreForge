import * as Comlink from 'comlink';
import type { GeometryWorkerApi } from './worker/geometry.worker';
import { withResolvedIconPath } from './labelIcons';
import type {
  BinParams,
  LabeledBinMeshes,
  LabeledBinParams,
  MeshData,
} from './engine/gridfinity/types';

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
