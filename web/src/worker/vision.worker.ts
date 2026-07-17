import * as Comlink from 'comlink';
// The wasm-only build: the default onnxruntime-web entry also emits the much
// larger WebGPU (jsep) WASM asset, which this worker never uses.
import * as ort from 'onnxruntime-web/wasm';
// The single-file ort bundle still fetches its WASM binary at runtime; pointing
// wasmPaths at the Vite-hashed asset URL keeps the binary inside the worker
// chunk's asset graph instead of requiring a copy step into public/.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { loadOpenCv } from './opencvLoader';
import type { CvNamespace } from './opencvLoader';

/** Absolute URLs of the MobileSAM ONNX models, resolved on the main thread. */
export interface VisionModelUrls {
  encoder: string;
  decoder: string;
}

/** Pixel dimensions of the currently loaded photo. */
export interface PhotoInfo {
  width: number;
  height: number;
}

/** Raw diagnostics from the self test, one row per subsystem. */
export interface VisionSelfTestReport {
  opencvVersion: string;
  encoderInputNames: string[];
  encoderOutputNames: string[];
  decoderInputNames: string[];
  decoderOutputNames: string[];
}

let modelUrls: VisionModelUrls | null = null;
let encoderPromise: Promise<ort.InferenceSession> | null = null;
let decoderPromise: Promise<ort.InferenceSession> | null = null;

function createSession(url: string): Promise<ort.InferenceSession> {
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
  return ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
}

function loadEncoder(): Promise<ort.InferenceSession> {
  if (!modelUrls) {
    throw new Error('Vision worker used before init() supplied the model URLs.');
  }
  if (!encoderPromise) {
    encoderPromise = createSession(modelUrls.encoder);
  }
  return encoderPromise;
}

function loadDecoder(): Promise<ort.InferenceSession> {
  if (!modelUrls) {
    throw new Error('Vision worker used before init() supplied the model URLs.');
  }
  if (!decoderPromise) {
    decoderPromise = createSession(modelUrls.decoder);
  }
  return decoderPromise;
}

// The photo currently being analyzed, kept worker-side so later stages
// (paper detection, embedding, segmentation) can reuse it without transfers.
let photo: InstanceType<CvNamespace['Mat']> | null = null;

async function toImageData(source: ImageBitmap | ArrayBuffer): Promise<ImageData> {
  const bitmap =
    source instanceof ImageBitmap
      ? source
      : await createImageBitmap(new Blob([source]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Creating a 2D canvas context in the vision worker failed.');
  }
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return data;
}

const api = {
  /** Store model URLs resolved on the main thread; must be called before use. */
  init(urls: VisionModelUrls): void {
    modelUrls = urls;
  },

  /**
   * Decode a photo (ImageBitmap or encoded image bytes), keep it as a cv.Mat
   * for later processing stages, and report its dimensions.
   */
  async loadPhoto(source: ImageBitmap | ArrayBuffer): Promise<PhotoInfo> {
    const cv = await loadOpenCv();
    const imageData = await toImageData(source);
    const mat = cv.matFromImageData(imageData);
    if (photo) {
      photo.delete();
    }
    photo = mat;
    return { width: mat.cols, height: mat.rows };
  },

  /** Load OpenCV and both ONNX sessions, returning raw readiness diagnostics. */
  async selfTest(): Promise<VisionSelfTestReport> {
    const [cv, encoder, decoder] = await Promise.all([
      loadOpenCv(),
      loadEncoder(),
      loadDecoder(),
    ]);
    const probe = new cv.Mat(2, 2, cv.CV_8UC1);
    probe.delete();
    return {
      opencvVersion: (cv as { version?: string }).version ?? 'unknown',
      encoderInputNames: [...encoder.inputNames],
      encoderOutputNames: [...encoder.outputNames],
      decoderInputNames: [...decoder.inputNames],
      decoderOutputNames: [...decoder.outputNames],
    };
  },
};

export type VisionWorkerApi = typeof api;

Comlink.expose(api);
