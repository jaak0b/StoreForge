import Module from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';

let instance: Promise<ManifoldToplevel> | null = null;

/** Load and initialize the manifold-3d WASM module once per test run. */
export function loadManifold(): Promise<ManifoldToplevel> {
  if (!instance) {
    instance = Module().then((m) => {
      m.setup();
      return m;
    });
  }
  return instance;
}
