import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { loadOpenCv } from '../../src/worker/opencvLoader';

// The worker itself cannot run under node (Comlink, OffscreenCanvas), so this
// smoke test exercises the same libraries the worker loads: the shared opencv
// loader and onnxruntime-web sessions over the committed MobileSAM models.

function modelPath(name: string): string {
  return fileURLToPath(new URL(`../../public/models/${name}`, import.meta.url));
}

describe('vision worker dependencies', () => {
  it('loads opencv.js in node and builds a Mat', async () => {
    const cv = await loadOpenCv();
    const mat = new cv.Mat(3, 5, cv.CV_8UC3);
    expect(mat.rows).toBe(3);
    expect(mat.cols).toBe(5);
    mat.delete();
  });

  it('creates the MobileSAM encoder session with the expected tensors', async () => {
    const bytes = await readFile(modelPath('mobilesam.encoder.onnx'));
    const session = await ort.InferenceSession.create(new Uint8Array(bytes));
    expect(session.inputNames).toEqual(['input_image']);
    expect(session.outputNames).toEqual(['image_embeddings']);
  });

  it('creates the MobileSAM decoder session with the expected tensors', async () => {
    const bytes = await readFile(modelPath('mobilesam.decoder.onnx'));
    const session = await ort.InferenceSession.create(new Uint8Array(bytes));
    expect(session.inputNames).toEqual([
      'image_embeddings',
      'point_coords',
      'point_labels',
      'mask_input',
      'has_mask_input',
      'orig_im_size',
    ]);
    expect(session.outputNames).toEqual(['masks', 'iou_predictions', 'low_res_masks']);
  });
});
