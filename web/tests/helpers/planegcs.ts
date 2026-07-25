import { fileURLToPath } from 'node:url';
import { init_planegcs_module, GcsWrapper, DebugMode } from '@salusoft89/planegcs';

/**
 * Loads the PlaneGCS WASM from node_modules for node-side tests, the same
 * disk-loading pattern tests/vision/visionSmoke.spec.ts uses for the
 * MobileSAM models. In the browser the sketch worker resolves the wasm with
 * a Vite ?url import instead.
 */
export async function loadGcsWrapper(): Promise<GcsWrapper> {
  const wasmPath = fileURLToPath(
    new URL(
      '../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm',
      import.meta.url,
    ),
  );
  const mod = await init_planegcs_module({ locateFile: () => wasmPath });
  const wrapper = new GcsWrapper(new mod.GcsSystem());
  // Match the sketch worker's quiet-mode setting (web/src/worker/sketch.worker.ts) so
  // tests exercise the same configuration and don't spam diagnostic solver output.
  wrapper.debug_mode = DebugMode.NoDebug;
  return wrapper;
}
