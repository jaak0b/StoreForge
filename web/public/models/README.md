# MobileSAM ONNX models

Committed to git so the GitHub Pages deploy (which uploads `web/dist` as built) serves them; Vite
copies everything in `public/` into `dist/` verbatim.

## Source

Both files come from the archive `mobile_sam_20230629.zip` (35 MB) in the Hugging Face repository
[vietanhdev/segment-anything-onnx-models](https://huggingface.co/vietanhdev/segment-anything-onnx-models),
downloaded 2026-07-17 from:

    https://huggingface.co/vietanhdev/segment-anything-onnx-models/resolve/main/mobile_sam_20230629.zip

They were exported with [samexporter](https://github.com/vietanhdev/samexporter) (MIT) from the
official [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) weights (Apache-2.0). The Hugging
Face model repository is published under Apache-2.0. Files were renamed from the archive names
(`mobile_sam.encoder.onnx`, `sam_vit_h_4b8939.decoder.onnx`; the decoder file name is the upstream
archive's naming quirk, the decoder is the SAM prompt/mask decoder used with the MobileSAM encoder).

## Files

| File | Size (bytes) | Role |
| --- | --- | --- |
| `mobilesam.encoder.onnx` | 28,157,093 | Image encoder (preprocessing baked in via samexporter `--use-preprocess`) |
| `mobilesam.decoder.onnx` | 16,500,272 | Prompt/mask decoder |

## Tensor specs

Read from the model graphs with onnxruntime-web 1.27 `InferenceSession` metadata.

### Encoder

Inputs:

| Name | Shape | Type |
| --- | --- | --- |
| `input_image` | `[image_height, image_width, 3]` | float32 |

Raw RGB pixel values 0-255 in HWC order; mean/std normalization, channel permutation, and padding
to the 1024 px encoder size happen inside the graph. The longer image side must be resized to at
most 1024 px before feeding (upstream config: `input_size: 1024`).

Outputs:

| Name | Shape | Type |
| --- | --- | --- |
| `image_embeddings` | `[1, 256, 64, 64]` | float32 |

### Decoder

Inputs:

| Name | Shape | Type |
| --- | --- | --- |
| `image_embeddings` | `[1, 256, 64, 64]` | float32 |
| `point_coords` | `[1, num_points, 2]` | float32 |
| `point_labels` | `[1, num_points]` | float32 |
| `mask_input` | `[1, 1, 256, 256]` | float32 |
| `has_mask_input` | `[1]` | float32 |
| `orig_im_size` | `[2]` | float32 |

Point coordinates are in the 1024-scaled image space; labels: 1 foreground, 0 background,
2/3 box corners, -1 padding.

Outputs:

| Name | Shape | Type |
| --- | --- | --- |
| `masks` | `[1, num_masks, orig_h, orig_w]` | float32 |
| `iou_predictions` | `[1, num_masks]` | float32 |
| `low_res_masks` | `[1, num_masks, 256, 256]` | float32 |

**Export quirk: `masks` is only correct for 683 x 1024 encoder inputs.** The decoder's mask
upsampling was traced with SAM's demo image (resized to 683 x 1024), which froze the crop of the
padded 1024 x 1024 frame into the graph. Verified empirically (2026-07-17) by feeding synthetic
images at other aspect ratios: the `masks` output comes back scaled by 683 / actual-height along y.
Consumers must ignore `masks` and instead upsample `low_res_masks` themselves (the low-res planes
cover the full padded 1024 x 1024 frame with no baked-in crop); `engine/trace/sam.ts`
`lowResMaskToMat` does this.
