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
import {
  buildDecoderPrompt,
  ENCODER_INPUT_SIZE,
  LOW_RES_MASK_SIZE,
  lowResMaskToMat,
  prepareEncoderInput,
  selectMaskIndex,
} from '../engine/trace/sam';
import { maskToContour } from '../engine/trace/contour';
import type { MaskContourFailure } from '../engine/trace/contour';
import type {
  PaperCalibration,
  PaperCorners,
  PaperDetectionResult,
  PaperKind,
  SamPoint,
  TracedOutline,
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

// The MobileSAM image embedding of the current rectified sheet, cached so
// every click prompt reuses the expensive encoder pass. Invalidated whenever
// rectify() replaces the rectified image.
interface CachedEmbedding {
  tensor: ort.Tensor;
  /** Multiply rectified-pixel coordinates by this to get encoder-space coordinates. */
  scale: number;
  /** Pixel size of the resized image fed to the encoder. */
  encoderWidth: number;
  encoderHeight: number;
  encodeMs: number;
}
let embedding: CachedEmbedding | null = null;

/** Timing report from preparing the rectified sheet for segmentation. */
export interface EmbedResult {
  /** Encoder wall time in milliseconds; 0 when the cached embedding was reused. */
  encodeMs: number;
  /** True when a previously computed embedding was reused. */
  cached: boolean;
}

/** A traced outline from one set of click prompts, or a user-worded failure. */
export type SegmentResult =
  | {
      ok: true;
      outline: TracedOutline;
      /** The decoder's own quality estimate for the chosen mask, 0..1. */
      iouScore: number;
      /** Decoder plus post-processing wall time in milliseconds. */
      decodeMs: number;
      /** The chosen mask at rectified resolution, for drawing as a UI overlay. */
      maskPreview: ImageData;
    }
  | { ok: false; error: string };

/** Semi-transparent blue for the mask overlay preview. */
const MASK_OVERLAY_RGBA = [66, 133, 244, 140] as const;

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

/** User-worded message for a maskToContour failure reason. */
function messageForContourFailure(reason: MaskContourFailure): string {
  switch (reason) {
    case 'noContainingRegion':
      return 'Add an include click on the tool itself. The traced shape contained none of your clicks, which happens when every include click landed on the background rather than a part.';
    case 'empty':
      return 'No usable shape was found at that click. Try clicking nearer the middle of the tool, or add more include clicks along it.';
  }
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
    // The embedding belongs to the previous rectified image.
    embedding = null;
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

  /**
   * Run the MobileSAM encoder over the rectified sheet and cache the image
   * embedding for segmentAt. Reuses the cache until rectify() runs again.
   */
  async embedImage(): Promise<EmbedResult> {
    if (!rectified) {
      throw new Error('embedImage called before rectify produced a sheet image.');
    }
    if (embedding) {
      return { encodeMs: 0, cached: true };
    }
    const [cv, encoder] = await Promise.all([loadOpenCv(), loadEncoder()]);
    const input = prepareEncoderInput(cv, rectified);
    const start = performance.now();
    const outputs = await encoder.run({
      input_image: new ort.Tensor('float32', input.data, [input.height, input.width, 3]),
    });
    const encodeMs = performance.now() - start;
    embedding = {
      tensor: outputs.image_embeddings as ort.Tensor,
      scale: input.scale,
      encoderWidth: input.width,
      encoderHeight: input.height,
      encodeMs,
    };
    return { encodeMs, cached: false };
  },

  /**
   * Segment the rectified sheet at the given click prompts (rectified-image
   * pixels) and return the traced outline in sheet millimeters plus a mask
   * overlay for the UI.
   */
  async segmentAt(points: SamPoint[]): Promise<SegmentResult> {
    if (!embedding || !rectified || !rectifiedCalibration) {
      return {
        ok: false,
        error:
          'The sheet image has not been prepared for segmentation yet. Wait for the preparation step to finish, then click the tool again.',
      };
    }
    const includePoint = points.find((point) => point.label === 1);
    if (!includePoint) {
      return {
        ok: false,
        error: 'Click on the tool itself first; exclude clicks alone cannot select a shape.',
      };
    }
    const includePoints = points
      .filter((point) => point.label === 1)
      .map((point) => ({ x: point.x, y: point.y }));
    const excludePoints = points
      .filter((point) => point.label === 0)
      .map((point) => ({ x: point.x, y: point.y }));
    const [cv, decoder] = await Promise.all([loadOpenCv(), loadDecoder()]);
    const prompt = buildDecoderPrompt(points, embedding.scale);
    const start = performance.now();
    const outputs = await decoder.run({
      image_embeddings: embedding.tensor,
      point_coords: new ort.Tensor('float32', prompt.coords, [1, prompt.pointCount, 2]),
      point_labels: new ort.Tensor('float32', prompt.labels, [1, prompt.pointCount]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
      orig_im_size: new ort.Tensor(
        'float32',
        new Float32Array([rectified.rows, rectified.cols]),
        [2],
      ),
    });
    const iou = (outputs.iou_predictions as ort.Tensor).data as Float32Array;
    const lowResMasks = (outputs.low_res_masks as ort.Tensor).data as Float32Array;
    const maskIndex = selectMaskIndex(
      lowResMasks,
      iou,
      includePoints,
      excludePoints,
      (embedding.scale * LOW_RES_MASK_SIZE) / ENCODER_INPUT_SIZE,
    );
    const maskWidth = rectified.cols;
    const maskHeight = rectified.rows;
    const maskMat = lowResMaskToMat(
      cv,
      lowResMasks,
      maskIndex,
      { width: embedding.encoderWidth, height: embedding.encoderHeight },
      maskWidth,
      maskHeight,
    );
    try {
      const result = maskToContour(cv, maskMat, {
        mmPerPixel: rectifiedCalibration.mmPerPixel,
        includePoints,
      });
      if (!result.ok) {
        return { ok: false, error: messageForContourFailure(result.reason) };
      }
      const outline = result.outline;
      const maskPreview = new ImageData(maskWidth, maskHeight);
      const mask = maskMat.data;
      for (let i = 0; i < maskWidth * maskHeight; i += 1) {
        if (mask[i]) {
          maskPreview.data.set(MASK_OVERLAY_RGBA, i * 4);
        }
      }
      const decodeMs = performance.now() - start;
      return Comlink.transfer(
        { ok: true, outline, iouScore: iou[maskIndex], decodeMs, maskPreview },
        [maskPreview.data.buffer],
      );
    } finally {
      maskMat.delete();
    }
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
