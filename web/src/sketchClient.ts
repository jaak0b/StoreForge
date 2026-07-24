import * as Comlink from 'comlink';
import type { SketchWorkerApi } from './worker/sketch.worker';
import type { Sketch } from './engine/sketch/model';
import type { DragTarget, SketchSolveResult } from './engine/sketch/solve';
import { sanitizeForWorker } from './workerSanitize';

// The only thing the UI calls for sketch solving, mirroring visionClient.ts.

let remote: Comlink.Remote<SketchWorkerApi> | null = null;

function getWorker(): Comlink.Remote<SketchWorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL('./worker/sketch.worker.ts', import.meta.url), {
      type: 'module',
    });
    remote = Comlink.wrap<SketchWorkerApi>(worker);
  }
  return remote;
}

/**
 * Solves a sketch in the sketch worker. Arguments cross the worker boundary,
 * so they are sanitized into plain structured-cloneable values here.
 */
export async function solveSketchInWorker(
  sketch: Sketch,
  drag?: DragTarget,
): Promise<SketchSolveResult> {
  const worker = getWorker();
  return worker.solve(
    sanitizeForWorker(sketch),
    drag === undefined ? undefined : sanitizeForWorker(drag),
  );
}
