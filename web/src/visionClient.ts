import * as Comlink from 'comlink';
import type {
  PhotoInfo,
  RectifyResult,
  VisionModelUrls,
  VisionSelfTestReport,
  VisionWorkerApi,
} from './worker/vision.worker';
import type {
  PaperCorners,
  PaperDetectionResult,
  PaperKind,
} from './engine/trace/types';

// Model URLs are resolved here because the worker script lives under assets/,
// so a BASE_URL-relative path would resolve against the wrong directory there.
function resolveModelUrls(): VisionModelUrls {
  const base = import.meta.env.BASE_URL;
  return {
    encoder: new URL(`${base}models/mobilesam.encoder.onnx`, document.baseURI).href,
    decoder: new URL(`${base}models/mobilesam.decoder.onnx`, document.baseURI).href,
  };
}

let remote: Comlink.Remote<VisionWorkerApi> | null = null;
let initPromise: Promise<void> | null = null;

function getWorker(): Comlink.Remote<VisionWorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL('./worker/vision.worker.ts', import.meta.url), {
      type: 'module',
    });
    remote = Comlink.wrap<VisionWorkerApi>(worker);
    initPromise = remote.init(resolveModelUrls());
  }
  return remote;
}

async function getReadyWorker(): Promise<Comlink.Remote<VisionWorkerApi>> {
  const worker = getWorker();
  await initPromise;
  return worker;
}

/** Decode a photo in the vision worker and keep it there for analysis. */
export async function loadPhoto(
  source: ImageBitmap | ArrayBuffer,
): Promise<PhotoInfo> {
  const worker = await getReadyWorker();
  const transfer: Transferable[] =
    source instanceof ImageBitmap ? [source] : [source];
  return worker.loadPhoto(Comlink.transfer(source, transfer));
}

/** Propose paper sheet corners in the loaded photo; the user may adjust them. */
export async function detectPaper(): Promise<PaperDetectionResult> {
  const worker = await getReadyWorker();
  return worker.detectPaper();
}

/**
 * Rectify the loaded photo to a top-down sheet image using the given corners.
 * The rectified image stays in the worker for segmentation; the returned
 * preview is for on-screen display only.
 */
export async function rectifyPaper(
  corners: PaperCorners,
  kind: PaperKind,
): Promise<RectifyResult> {
  const worker = await getReadyWorker();
  return worker.rectify(corners, kind);
}

/** Verify that OpenCV and both MobileSAM ONNX sessions load in the worker. */
export async function visionSelfTest(): Promise<VisionSelfTestReport> {
  const worker = await getReadyWorker();
  return worker.selfTest();
}
