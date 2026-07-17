// Test-only stand-in for '@techstark/opencv-js'. The real package is CJS whose
// exports object is a Promise; vitest's CJS interop wraps such modules in a
// proxy that forwards `then`, which makes awaiting the module namespace throw.
// Loading it with plain require and re-exporting as an ESM default sidesteps
// the interop entirely. The Vite browser build imports the real package.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default require('@techstark/opencv-js');
