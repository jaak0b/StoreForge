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
import { detectPaper, rectifyPaper } from '../engine/trace/paper';
import type {
  PaperCalibration,
  PaperCorners,
  PaperDetectionResult,
  PaperKind,
} from '../engine/trace/types';

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

// The rectified top-down sheet image, kept worker-side so the segmentation
// stages can run on it without shipping pixels back and forth.
let rectified: InstanceType<CvNamespace['Mat']> | null = null;
let rectifiedCalibration: PaperCalibration | null = null;

/** The rectified sheet plus a preview the UI can draw directly. */
export interface RectifyResult {
  calibration: PaperCalibration;
  preview: ImageData;
}

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

  /**
   * Propose sheet corners in the loaded photo. The result is a proposal only;
   * the UI lets the user drag-correct corners before calling rectify().
   */
  async detectPaper(): Promise<PaperDetectionResult> {
    const cv = await loadOpenCv();
    if (!photo) {
      throw new Error('detectPaper called before loadPhoto supplied a photo.');
    }
    return detectPaper(cv, photo);
  },

  /**
   * Rectify the loaded photo to a top-down sheet image using the given
   * corners (detected or user-adjusted), keep it worker-side for later
   * segmentation, and return the calibration plus a drawable preview.
   */
  async rectify(corners: PaperCorners, kind: PaperKind): Promise<RectifyResult> {
    const cv = await loadOpenCv();
    if (!photo) {
      throw new Error('rectify called before loadPhoto supplied a photo.');
    }
    const result = rectifyPaper(cv, photo, corners, kind);
    if (rectified) {
      rectified.delete();
    }
    rectified = result.rectified;
    rectifiedCalibration = result.calibration;
    const preview = new ImageData(
      new Uint8ClampedArray(rectified.data),
      rectified.cols,
      rectified.rows,
    );
    return Comlink.transfer(
      { calibration: rectifiedCalibration, preview },
      [preview.data.buffer],
    );
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
