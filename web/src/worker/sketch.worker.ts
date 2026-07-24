import * as Comlink from 'comlink';
import { init_planegcs_module, GcsWrapper, type ModuleStatic } from '@salusoft89/planegcs';
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { Sketch } from '../engine/sketch/model';
import { solveSketch, type DragTarget, type SketchSolveResult } from '../engine/sketch/solve';

// The sketch worker owns the PlaneGCS WASM so constraint solving never blocks
// the page or the geometry worker's carves, and the LGPL-licensed wasm ships
// as its own replaceable asset (the ?url import), following the manifold
// pattern in geometry.worker.ts.

let wrapperPromise: Promise<GcsWrapper> | null = null;

function getWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) {
    wrapperPromise = init_planegcs_module({ locateFile: () => wasmUrl }).then(
      (mod: ModuleStatic) => new GcsWrapper(new mod.GcsSystem()),
    );
  }
  return wrapperPromise as Promise<GcsWrapper>;
}

const api = {
  /** Runs the constraint solver over a sketch; see solveSketch. */
  async solve(sketch: Sketch, drag?: DragTarget): Promise<SketchSolveResult> {
    const wrapper = await getWrapper();
    return solveSketch(wrapper, sketch, drag);
  },
};

export type SketchWorkerApi = typeof api;

Comlink.expose(api);
