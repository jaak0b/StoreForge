import * as Comlink from 'comlink';
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ManifoldToplevel } from 'manifold-3d';
import { parse as parseFont } from 'opentype.js';
import type { Font } from 'opentype.js';
import fontUrl from '../assets/fonts/roboto-medium.ttf?url';
import {
  generateBin,
  generateLabeledBin,
  generateLabeledBinUnion,
} from '../engine/gridfinity/binGenerator';
import { autoGridSize, generatePocketBin, generatePocketBinUnion } from '../engine/trace/pocketBin';
import type { PocketBinParams } from '../engine/trace/pocketBin';
import type { TracedTool, ToolPlacement } from '../engine/trace/types';
import type {
  BinParams,
  LabeledBinMeshes,
  LabeledBinParams,
  MeshData,
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

const api = {
  async generateBin(params: BinParams): Promise<MeshData> {
    const m = await loadManifold();
    return transferMesh(generateBin(m, params));
  },
  async generateLabeledBin(params: LabeledBinParams): Promise<LabeledBinMeshes> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    const meshes = generateLabeledBin(m, font, params);
    const buffers = [meshes.body.vertices.buffer, meshes.body.indices.buffer];
    if (meshes.label) {
      buffers.push(meshes.label.vertices.buffer, meshes.label.indices.buffer);
    }
    return Comlink.transfer(meshes, buffers);
  },
  async generateLabeledBinUnion(params: LabeledBinParams): Promise<MeshData> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMesh(generateLabeledBinUnion(m, font, params));
  },
  async generatePocketBin(params: PocketBinParams): Promise<LabeledBinMeshes> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    const meshes = generatePocketBin(m, font, params);
    const buffers = [meshes.body.vertices.buffer, meshes.body.indices.buffer];
    if (meshes.label) {
      buffers.push(meshes.label.vertices.buffer, meshes.label.indices.buffer);
    }
    return Comlink.transfer(meshes, buffers);
  },
  async generatePocketBinUnion(params: PocketBinParams): Promise<MeshData> {
    const [m, font] = await Promise.all([loadManifold(), loadFont()]);
    return transferMesh(generatePocketBinUnion(m, font, params));
  },
  async autoPocketGridSize(
    tools: TracedTool[],
    placements: ToolPlacement[],
    marginMm: number,
  ): Promise<{ gridX: number; gridY: number }> {
    const m = await loadManifold();
    return autoGridSize(m, tools, placements, marginMm);
  },
};

export type GeometryWorkerApi = typeof api;

Comlink.expose(api);
