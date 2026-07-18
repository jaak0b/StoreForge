import * as Comlink from 'comlink';
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ManifoldToplevel } from 'manifold-3d';
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
import { generatePocketBin, generatePocketBinUnion } from '../engine/trace/pocketBin';
import type { PocketBinParams } from '../engine/trace/pocketBin';
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

function transferMesh(mesh: MeshData): MeshData {
  return Comlink.transfer(mesh, [mesh.vertices.buffer, mesh.indices.buffer]);
}

function transferMeshes(meshes: PartMeshes): PartMeshes {
  const buffers = [meshes.body.vertices.buffer, meshes.body.indices.buffer];
  if (meshes.label) {
    buffers.push(meshes.label.vertices.buffer, meshes.label.indices.buffer);
  }
  return Comlink.transfer(meshes, buffers);
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
  async generateSlottedBinUnion(params: BinParams): Promise<MeshData> {
    const m = await loadManifold();
    return transferMesh(generateSlottedBinUnion(m, params));
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
    const m = await loadManifold();
    return transferMesh(generatePocketBinUnion(m, params));
  },
};

export type GeometryWorkerApi = typeof api;

Comlink.expose(api);
