// MobileSAM tensor preparation shared by the vision worker and the node
// integration tests. The models are the samexporter export documented in
// web/public/models/README.md: the encoder takes raw RGB [H, W, 3] float32
// with normalization and padding baked into the graph, and the decoder is the
// standard SAM prompt decoder whose point coordinates live in the space of
// the image as fed to the encoder.
import type { Cv, CvMat } from './paper';
import type { PixelPoint, SamPoint } from './types';

/**
 * The encoder's working resolution. Following SAM's ResizeLongestSide
 * convention (and the samexporter export config `input_size: 1024`), the
 * image's longer side is resized to exactly this many pixels before encoding;
 * the graph pads the shorter side internally.
 */
export const ENCODER_INPUT_SIZE = 1024;

/** Raw encoder input plus the scale mapping source pixels to encoder pixels. */
export interface EncoderInput {
  /** RGB pixel values 0-255 in HWC order. */
  data: Float32Array;
  /** Width of the resized image fed to the encoder. */
  width: number;
  /** Height of the resized image fed to the encoder. */
  height: number;
  /** Multiply source-image pixel coordinates by this to get encoder-space coordinates. */
  scale: number;
}

/**
 * Resize an RGBA/RGB/gray Mat so its longer side is ENCODER_INPUT_SIZE and
 * flatten it to the float32 HWC RGB buffer the encoder expects.
 */
export function prepareEncoderInput(cv: Cv, mat: CvMat): EncoderInput {
  const longSide = Math.max(mat.cols, mat.rows);
  const scale = ENCODER_INPUT_SIZE / longSide;
  const width = Math.round(mat.cols * scale);
  const height = Math.round(mat.rows * scale);
  const resized = new cv.Mat();
  const rgb = new cv.Mat();
  try {
    cv.resize(mat, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
    if (resized.channels() === 4) {
      cv.cvtColor(resized, rgb, cv.COLOR_RGBA2RGB);
    } else if (resized.channels() === 3) {
      resized.copyTo(rgb);
    } else {
      cv.cvtColor(resized, rgb, cv.COLOR_GRAY2RGB);
    }
    return { data: Float32Array.from(rgb.data), width, height, scale };
  } finally {
    resized.delete();
    rgb.delete();
  }
}

/** Flat decoder prompt tensors built from click points. */
export interface DecoderPrompt {
  /** [1, N, 2] point coordinates in encoder space, flattened. */
  coords: Float32Array;
  /** [1, N] point labels, flattened. */
  labels: Float32Array;
  /** N, the padded point count. */
  pointCount: number;
}

/**
 * Convert click points from source-image pixels to the decoder's prompt
 * tensors. Coordinates are scaled into encoder space, and the SAM ONNX
 * convention of appending a (0, 0) point with label -1 when no box prompt is
 * present is applied.
 */
export function buildDecoderPrompt(points: SamPoint[], scale: number): DecoderPrompt {
  const pointCount = points.length + 1;
  const coords = new Float32Array(pointCount * 2);
  const labels = new Float32Array(pointCount);
  points.forEach((point, i) => {
    coords[i * 2] = point.x * scale;
    coords[i * 2 + 1] = point.y * scale;
    labels[i] = point.label;
  });
  labels[pointCount - 1] = -1;
  return { coords, labels, pointCount };
}

/** Index of the mask the decoder scored highest in iou_predictions. */
export function bestMaskIndex(iouPredictions: Float32Array): number {
  let best = 0;
  for (let i = 1; i < iouPredictions.length; i += 1) {
    if (iouPredictions[i] > iouPredictions[best]) {
      best = i;
    }
  }
  return best;
}

/** Side length of the decoder's low_res_masks planes. */
export const LOW_RES_MASK_SIZE = 256;

/**
 * Choose the low_res_masks plane to use. Among planes whose binarized mask
 * (logit > 0) covers every include point and no exclude point, pick the
 * highest predicted IoU. If no plane satisfies the criterion, fall back to
 * plain argmax IoU so segmentation still returns a refinable mask.
 *
 * Points are in rectified-image pixels. scaleToLowRes maps a rectified pixel
 * to the 256-grid low-res plane: embedding.scale * LOW_RES_MASK_SIZE / ENCODER_INPUT_SIZE.
 */
export function selectMaskIndex(
  lowResMasks: Float32Array,
  iouPredictions: Float32Array,
  includePoints: PixelPoint[],
  excludePoints: PixelPoint[],
  scaleToLowRes: number,
): number {
  const size = LOW_RES_MASK_SIZE;
  const planeStride = size * size;
  const planeCount = iouPredictions.length;
  const clamp = (value: number): number => Math.min(Math.max(value, 0), size - 1);
  const logitAt = (plane: number, pt: PixelPoint): number => {
    const gx = clamp(Math.floor(pt.x * scaleToLowRes));
    const gy = clamp(Math.floor(pt.y * scaleToLowRes));
    return lowResMasks[plane * planeStride + gy * size + gx];
  };
  let best = -1;
  for (let plane = 0; plane < planeCount; plane += 1) {
    const qualifies =
      includePoints.every((pt) => logitAt(plane, pt) > 0) &&
      excludePoints.every((pt) => logitAt(plane, pt) <= 0);
    if (qualifies && (best === -1 || iouPredictions[plane] > iouPredictions[best])) {
      best = plane;
    }
  }
  return best === -1 ? bestMaskIndex(iouPredictions) : best;
}

/**
 * Turn one plane of the decoder's `low_res_masks` output (logits,
 * [1, M, 256, 256]) into a binary CV_8UC1 Mat at the source image's
 * resolution. The caller owns the returned Mat.
 *
 * The decoder's full-resolution `masks` output is NOT used: this particular
 * samexporter export traced the mask upsampling with a 683 x 1024 example
 * image, freezing that crop into the graph, so `masks` is misplaced for any
 * other aspect ratio (see web/public/models/README.md). The low-res planes
 * cover the padded 1024 x 1024 encoder frame with no baked-in crop, so the
 * crop to the real image region and the upsample are done here instead:
 * a low-res plane maps 4:1 onto the encoder frame, the region covering the
 * resized image is cut out, and that region is resized to the source image.
 */
export function lowResMaskToMat(
  cv: Cv,
  lowResMasks: Float32Array,
  maskIndex: number,
  encoder: { width: number; height: number },
  outWidth: number,
  outHeight: number,
): CvMat {
  const size = LOW_RES_MASK_SIZE;
  const plane = new cv.Mat(size, size, cv.CV_32FC1);
  plane.data32F.set(lowResMasks.subarray(maskIndex * size * size, (maskIndex + 1) * size * size));
  const contentWidth = Math.round((encoder.width * size) / ENCODER_INPUT_SIZE);
  const contentHeight = Math.round((encoder.height * size) / ENCODER_INPUT_SIZE);
  const upsampled = new cv.Mat();
  const mask = new cv.Mat();
  try {
    const content = plane.roi(new cv.Rect(0, 0, contentWidth, contentHeight));
    try {
      cv.resize(content, upsampled, new cv.Size(outWidth, outHeight), 0, 0, cv.INTER_LINEAR);
    } finally {
      content.delete();
    }
    // Logits above zero are inside the mask.
    cv.threshold(upsampled, mask, 0, 255, cv.THRESH_BINARY);
    const binary = new cv.Mat();
    mask.convertTo(binary, cv.CV_8U);
    return binary;
  } finally {
    plane.delete();
    upsampled.delete();
    mask.delete();
  }
}
