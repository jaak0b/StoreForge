// Static import on purpose: the opencv.js CJS module exports a Promise, and a
// dynamic import() would try to unwrap the module namespace as a thenable via
// an unbound `then`, which throws. Laziness is preserved because this module
// is only ever pulled into the vision worker chunk, which loads on first use.
import cvModule from '@techstark/opencv-js';

/** The opencv.js namespace once its WASM runtime has initialized. */
export type CvNamespace = typeof import('@techstark/opencv-js');

let cvPromise: Promise<CvNamespace> | null = null;

// Depending on the bundler's CJS interop, the default export is either the
// initialized cv namespace or a Promise resolving to it.
async function resolveCv(candidate: unknown): Promise<CvNamespace> {
  if (candidate && typeof (candidate as CvNamespace).Mat === 'function') {
    return candidate as CvNamespace;
  }
  if (candidate instanceof Promise) {
    const cv = (await candidate) as CvNamespace;
    if (typeof cv.Mat === 'function') {
      return cv;
    }
  }
  throw new Error('The opencv.js module did not expose a cv namespace or a loading promise.');
}

/** Await opencv.js WASM initialization, once per thread. */
export function loadOpenCv(): Promise<CvNamespace> {
  if (!cvPromise) {
    cvPromise = resolveCv(cvModule);
  }
  return cvPromise;
}
