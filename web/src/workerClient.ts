import * as Comlink from 'comlink';
import type { GeometryWorkerApi } from './worker/geometry.worker';
import { withResolvedBinInsert, withResolvedInsertContent } from './labelIcons';
import type {
  BinParams,
  InsertParams,
  MeshData,
  PartMeshes,
  SlottedBinParams,
} from './engine/gridfinity/types';
import type { PocketBinParams } from './engine/trace/pocketBin';

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
