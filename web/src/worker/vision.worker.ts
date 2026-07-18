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
  bestMaskIndex,
  buildDecoderPrompt,
  lowResMaskToMat,
  prepareEncoderInput,
} from '../engine/trace/sam';
import { maskToContours } from '../engine/trace/contour';
import { pointInPolygon } from '../engine/trace/edit';
import { partitionClicks } from '../engine/trace/prompts';
import type { CvMat } from '../engine/trace/paper';
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

/** Traced outlines from one set of click prompts, or a user-worded failure. */
export type SegmentResult =
  | {
      ok: true;
      /**
       * One outline per distinct shape in the mask; the outline containing
       * (or nearest) the first include click comes first.
       */
      outlines: TracedOutline[];
      /** The lowest per-decode quality estimate across all decodes, 0..1. */
      iouScore: number;
      /** Wall time over all decodes plus post-processing, in milliseconds. */
      decodeMs: number;
      /** All decode masks composited at rectified resolution, for a UI overlay. */
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
   * pixels) and return the traced outlines in sheet millimeters plus a mask
   * overlay for the UI.
   *
   * SAM's point prompts describe a single object per decode, so the clicks
   * are partitioned into one prompt group per include click (excludes join
   * their nearest include) and decoded sequentially against the one cached
   * embedding. Each decode keeps only the click-gated component, so a mask
   * bleeding onto a visually similar unclicked tool never surfaces as a
   * tool. An include click landing inside an already-traced outline is a
   * refinement of that tool: its group is merged into that decode's points
   * and the merged prompt is decoded again, replacing the earlier outline
   * instead of adding a duplicate.
   *
   * Diagnostics: iouScore is the lowest per-decode estimate (the weakest
   * mask bounds the result's quality) and decodeMs is the wall time over
   * all decodes including post-processing.
   */
  async segmentAt(points: SamPoint[]): Promise<SegmentResult> {
    if (!embedding || !rectified || !rectifiedCalibration) {
      return {
        ok: false,
        error:
          'The sheet image has not been prepared for segmentation yet. Wait for the preparation step to finish, then click the tool again.',
      };
    }
    const groups = partitionClicks(points);
    if (groups.length === 0) {
      return {
        ok: false,
        error: 'Click on the tool itself first; exclude clicks alone cannot select a shape.',
      };
    }
    const [cv, decoder] = await Promise.all([loadOpenCv(), loadDecoder()]);
    const cached = embedding;
    const sheet = rectified;
    const mmPerPixel = rectifiedCalibration.mmPerPixel;
    const maskWidth = sheet.cols;
    const maskHeight = sheet.rows;
    const start = performance.now();

    const decodeOnce = async (
      promptPoints: SamPoint[],
    ): Promise<{ maskMat: CvMat; iouScore: number }> => {
      const prompt = buildDecoderPrompt(promptPoints, cached.scale);
      const outputs = await decoder.run({
        image_embeddings: cached.tensor,
        point_coords: new ort.Tensor('float32', prompt.coords, [1, prompt.pointCount, 2]),
        point_labels: new ort.Tensor('float32', prompt.labels, [1, prompt.pointCount]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
        orig_im_size: new ort.Tensor(
          'float32',
          new Float32Array([sheet.rows, sheet.cols]),
          [2],
        ),
      });
      const iou = (outputs.iou_predictions as ort.Tensor).data as Float32Array;
      const maskIndex = bestMaskIndex(iou);
      const maskMat = lowResMaskToMat(
        cv,
        (outputs.low_res_masks as ort.Tensor).data as Float32Array,
        maskIndex,
        { width: cached.encoderWidth, height: cached.encoderHeight },
        maskWidth,
        maskHeight,
      );
      return { maskMat, iouScore: iou[maskIndex] };
    };

    /** One traced tool: its prompt points, gated outline, and decode mask. */
    interface TracedEntry {
      includes: SamPoint[];
      excludes: SamPoint[];
      outline: TracedOutline;
      iouScore: number;
      mask: CvMat;
    }
    const entries: TracedEntry[] = [];
    try {
      for (const group of groups) {
        // A later include click inside an existing outline refines that
        // tool rather than starting a new one.
        const target = entries.find((entry) =>
          pointInPolygon(entry.outline.outer, {
            x: group.include.x * mmPerPixel,
            y: group.include.y * mmPerPixel,
          }),
        );
        const includes = target ? [...target.includes, group.include] : [group.include];
        const excludes = target
          ? [...target.excludes, ...group.excludes]
          : [...group.excludes];
        const { maskMat, iouScore } = await decodeOnce([...includes, ...excludes]);
        // The first outline is the component containing (or nearest) this
        // decode's primary include click; bleed components are discarded.
        const outline = maskToContours(cv, maskMat, {
          mmPerPixel,
          includePoint: includes[0],
        })[0];
        if (outline === undefined) {
          maskMat.delete();
          continue;
        }
        if (target) {
          target.mask.delete();
          target.includes = includes;
          target.excludes = excludes;
          target.outline = outline;
          target.iouScore = iouScore;
          target.mask = maskMat;
        } else {
          entries.push({ includes, excludes, outline, iouScore, mask: maskMat });
        }
      }
      if (entries.length === 0) {
        return {
          ok: false,
          error:
            'No usable shape was found at that click. Try clicking nearer the middle of the tool, or add more include clicks along it.',
        };
      }
      const maskPreview = new ImageData(maskWidth, maskHeight);
      for (const entry of entries) {
        const mask = entry.mask.data;
        for (let i = 0; i < maskWidth * maskHeight; i += 1) {
          if (mask[i]) {
            maskPreview.data.set(MASK_OVERLAY_RGBA, i * 4);
          }
        }
      }
      const decodeMs = performance.now() - start;
      return Comlink.transfer(
        {
          ok: true,
          outlines: entries.map((entry) => entry.outline),
          iouScore: Math.min(...entries.map((entry) => entry.iouScore)),
          decodeMs,
          maskPreview,
        },
        [maskPreview.data.buffer],
      );
    } finally {
      for (const entry of entries) {
        entry.mask.delete();
      }
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
