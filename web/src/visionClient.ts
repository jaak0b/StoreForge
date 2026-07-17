import * as Comlink from 'comlink';
import type {
  PhotoInfo,
  VisionModelUrls,
  VisionSelfTestReport,
  VisionWorkerApi,
} from './worker/vision.worker';

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

/** Verify that OpenCV and both MobileSAM ONNX sessions load in the worker. */
export async function visionSelfTest(): Promise<VisionSelfTestReport> {
  const worker = await getReadyWorker();
  return worker.selfTest();
}
