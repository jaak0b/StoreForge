import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { loadOpenCv } from '../../src/worker/opencvLoader';
import {
  bestMaskIndex,
  buildDecoderPrompt,
  lowResMaskToMat,
  prepareEncoderInput,
} from '../../src/engine/trace/sam';
import { maskToContour } from '../../src/engine/trace/contour';
import type { MmPoint } from '../../src/engine/trace/types';

// End-to-end run of the committed MobileSAM encoder and decoder on a
// synthetic rectified sheet: a dark rectangle on a bright background with an
// include click inside must come back as an outline of about the drawn area.
// This is the same tensor path the vision worker takes (shared helpers in
// engine/trace/sam.ts). One image runs in a couple of seconds in the node
// WASM backend, so the file stays in the default test run.

function modelPath(name: string): string {
  return fileURLToPath(new URL(`../../public/models/${name}`, import.meta.url));
}

/** Measured signed shoelace area of a returned polygon. */
function measuredArea(points: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

describe('MobileSAM click-to-segment integration', () => {
  it(
    'traces a dark rectangle on a bright sheet from one include click',
    { timeout: 300_000 },
    async () => {
      const cv = await loadOpenCv();
      // A 512 x 384 px synthetic rectified sheet at 0.25 mm/px: bright paper
      // with a dark 200 x 120 px tool blank spanning 156..356 x 132..252.
      const sheet = new cv.Mat(384, 512, cv.CV_8UC4, new cv.Scalar(225, 225, 225, 255));
      cv.rectangle(
        sheet,
        new cv.Point(156, 132),
        new cv.Point(356, 252),
        new cv.Scalar(45, 45, 50, 255),
        -1,
      );

      const input = prepareEncoderInput(cv, sheet);
      const encoder = await ort.InferenceSession.create(
        new Uint8Array(await readFile(modelPath('mobilesam.encoder.onnx'))),
      );
      const encodeStart = performance.now();
      const encoded = await encoder.run({
        input_image: new ort.Tensor('float32', input.data, [input.height, input.width, 3]),
      });
      const encodeMs = performance.now() - encodeStart;

      const decoder = await ort.InferenceSession.create(
        new Uint8Array(await readFile(modelPath('mobilesam.decoder.onnx'))),
      );
      // One include click at the rectangle's center, (256, 192) px.
      const prompt = buildDecoderPrompt([{ x: 256, y: 192, label: 1 }], input.scale);
      const decodeStart = performance.now();
      const decoded = await decoder.run({
        image_embeddings: encoded.image_embeddings,
        point_coords: new ort.Tensor('float32', prompt.coords, [1, prompt.pointCount, 2]),
        point_labels: new ort.Tensor('float32', prompt.labels, [1, prompt.pointCount]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
        orig_im_size: new ort.Tensor('float32', new Float32Array([384, 512]), [2]),
      });
      const decodeMs = performance.now() - decodeStart;
      // Raw timing rows for the report; the assertion is on geometry only.
      console.log(`encoder ms: ${encodeMs.toFixed(0)}`);
      console.log(`decoder ms: ${decodeMs.toFixed(0)}`);

      const iou = decoded.iou_predictions.data as Float32Array;
      const maskIndex = bestMaskIndex(iou);
      const maskMat = lowResMaskToMat(
        cv,
        decoded.low_res_masks.data as Float32Array,
        maskIndex,
        { width: input.width, height: input.height },
        512,
        384,
      );
      const result = maskToContour(cv, maskMat, {
        mmPerPixel: 0.25,
        includePoints: [{ x: 256, y: 192 }],
      });
      maskMat.delete();
      sheet.delete();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const outline = result.outline;
      // The drawn blank is 200 x 120 px at 0.25 mm/px: 50 x 30 mm, area
      // 1500 mm^2, hand-derived once. 15 percent tolerance covers SAM's soft
      // mask boundary on a synthetic image.
      const area = measuredArea(outline.outer);
      expect(area).toBeGreaterThan(1275);
      expect(area).toBeLessThan(1725);
      // The outline must stay centered on the drawn rectangle: center of the
      // drawn blank is (64, 48) mm, hand-derived once. 2 mm covers the
      // low-res mask's 1 px (about 1.3 mm here) boundary quantization.
      const xs = outline.outer.map((p) => p.x);
      const ys = outline.outer.map((p) => p.y);
      expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 64)).toBeLessThan(2);
      expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 48)).toBeLessThan(2);
    },
  );
});
