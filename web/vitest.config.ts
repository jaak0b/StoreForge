import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // See tests/helpers/opencvNodeShim.mjs for why the real package cannot be
    // imported through vitest's CJS interop.
    alias: {
      '@techstark/opencv-js': fileURLToPath(
        new URL('./tests/helpers/opencvNodeShim.mjs', import.meta.url),
      ),
    },
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30000,
  },
});
