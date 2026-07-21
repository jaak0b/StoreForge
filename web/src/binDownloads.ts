import {
  generateBaseplate,
  generateConnectionClip,
  generateCutoutBin,
  generateCutoutBinUnion,
  generateInsert,
  generateInsertUnion,
  generatePocketBin,
  generatePocketBinUnion,
  generateSlottedBin,
  generateSlottedBinUnion,
} from './workerClient';
import { meshToStlBlob } from './engine/gridfinity/stlExport';
import { binOuterSizeMm } from './engine/gridfinity/constants';
import { baseplateOuterMm, clipFootprintMm } from './engine/baseplate/generator';
import { INSERT_DEPTH, insertLengthMm } from './engine/label/slot';
import type { MeshData, PartMeshes } from './engine/gridfinity/types';
import { assertNever, type BinPockets, type CutoutModel, type Product } from './engine/plan/types';
import { binInteriorOf, partsOf, type PrintablePart } from './engine/plan/geometry';
import { arrangeAutoPlate, type FootprintItem, type Placement } from './engine/plate/arranger';
import { mergePlacedMeshes, type PlacedMesh } from './engine/plate/placement';
import { writePlate3mf, type PlateItem } from './engine/threeMf/writer';

/**
 * Shared download plumbing for the single-page UI: single-entry STL/3MF from
 * a queue row and merged STL / 3MF exports of a whole print batch. The plate
 * layout for batch downloads is arranged automatically (no plate preview);
 * the user rearranges parts in the slicer. A product expands into its
 * printable parts first (see engine/plan/geometry): a bin ordered with its
 * insert contributes the bin and the insert as two separately placed parts.
 */

/** One product with the number of copies to export. */
export interface DownloadProduct {
  product: Product;
  count: number;
}

// Pocket data crossing into the worker is deep-copied to strip Vue proxies,
// which the structured clone of the worker call rejects.
function plainPockets(pockets: BinPockets): BinPockets {
  return JSON.parse(JSON.stringify(pockets)) as BinPockets;
}

// Cutout model records cross the same boundary and are deep-copied for the
// same reason. Only the record travels: the model's triangles stay in the
// model store and reach the worker as bytes exactly once.
function plainModels(models: CutoutModel[]): CutoutModel[] {
  return JSON.parse(JSON.stringify(models)) as CutoutModel[];
}

/**
 * Where a generated part's placement warnings go. A cutout bin can be laid
 * out in ways that are legal but probably not what the user meant, and the
 * carve returns those as sentences rather than throwing them. They are not
 * dropped on the way to a download: the caller collects them and shows them.
 */
export type WarningSink = (message: string) => void;

/** Generates one part's separate body and label meshes. */
async function generatePartMeshes(
  part: PrintablePart,
  warn: WarningSink,
): Promise<PartMeshes> {
  switch (part.part) {
    case 'insert':
      return generateInsert(part.insert);
    case 'bin': {
      const interior = binInteriorOf(part);
      switch (interior.interior) {
        case 'models': {
          const carve = await generateCutoutBin({
            ...part.bin,
            models: plainModels(interior.models),
          });
          // The download has no model card to show a warning on, so the
          // sentence the carve wrote (which names the model) is what is shown.
          for (const warning of carve.warnings) warn(warning.message);
          return carve.meshes;
        }
        case 'pockets':
          return generatePocketBin({ ...part.bin, ...plainPockets(interior.pockets) });
        case 'walls':
          return generateSlottedBin(part.bin);
        default:
          return assertNever(interior);
      }
    }
    // A baseplate and a clip are single solids with no second-filament part,
    // so the label mesh is null and the 3MF writer emits them single-filament.
    case 'baseplate':
      return generateBaseplate(part.baseplate).then((body) => ({ body, label: null }));
    case 'clip':
      return generateConnectionClip(part.clip).then((body) => ({ body, label: null }));
    default:
      return assertNever(part);
  }
}

/** Generates one part as a single unioned mesh. */
async function generatePartUnion(
  part: PrintablePart,
  warn: WarningSink,
): Promise<MeshData> {
  switch (part.part) {
    case 'insert':
      return generateInsertUnion(part.insert);
    case 'bin': {
      const interior = binInteriorOf(part);
      switch (interior.interior) {
        case 'models': {
          const carve = await generateCutoutBinUnion({
            ...part.bin,
            models: plainModels(interior.models),
          });
          for (const warning of carve.warnings) warn(warning.message);
          return carve.mesh;
        }
        case 'pockets':
          return generatePocketBinUnion({ ...part.bin, ...plainPockets(interior.pockets) });
        case 'walls':
          return generateSlottedBinUnion(part.bin);
        default:
          return assertNever(interior);
      }
    }
    // The same generators the two-mesh path calls: a baseplate and a clip are
    // one mesh, so there is no separate union worker method to disagree with.
    case 'baseplate':
      return generateBaseplate(part.baseplate);
    case 'clip':
      return generateConnectionClip(part.clip);
    default:
      return assertNever(part);
  }
}

/**
 * The part's plate footprint in millimetres. Exported for tests: the batch
 * arranger lays plates out by this, so it must agree with the generator.
 */
export function partFootprint(part: PrintablePart): { widthMm: number; depthMm: number } {
  switch (part.part) {
    case 'insert':
      return { widthMm: insertLengthMm(part.insert.cells), depthMm: INSERT_DEPTH };
    case 'bin':
      // A carved interior never reaches outside the envelope, so a cutout bin
      // occupies exactly the plate area its grid size does.
      return {
        widthMm: binOuterSizeMm(part.bin.gridX),
        depthMm: binOuterSizeMm(part.bin.gridY),
      };
    // Derived by the geometry module's own span functions, never recomputed
    // here: a locally derived outer size could silently overlap plates in a
    // batch export.
    case 'baseplate':
      return baseplateOuterMm(part.baseplate);
    case 'clip':
      return clipFootprintMm(part.clip);
    default:
      return assertNever(part);
  }
}

/** Stable key identifying one printable part, for deduplication. */
function partKey(part: PrintablePart): string {
  return JSON.stringify(part);
}

export function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Object name of one part, shown in the slicer. */
function partName(part: PrintablePart): string {
  switch (part.part) {
    case 'insert': {
      const text = part.insert.content.text;
      return text !== '' ? `${text} label insert` : `${part.insert.cells}u label insert`;
    }
    case 'bin': {
      const size = `${part.bin.gridX}x${part.bin.gridY}x${part.bin.heightUnits}`;
      return part.labelText !== undefined ? `${part.labelText} (${size})` : size;
    }
    case 'baseplate':
      return `Baseplate ${part.baseplate.unitsX}x${part.baseplate.unitsY}`;
    case 'clip':
      return part.clip.toleranceMm !== 0
        ? `Connection clip, ${part.clip.toleranceMm} mm tolerance`
        : 'Connection clip';
    default:
      return assertNever(part);
  }
}

/**
 * File name stem of a single-product download. Every bin-bearing product is
 * named by its grid size whatever the bin's origin, so a cutout bin downloads
 * under the same convention a manual or traced one does. The clip _tol
 * suffix keeps genuinely different clips from downloading over each other.
 * Exported for tests.
 */
export function fileStem(product: Product): string {
  switch (product.kind) {
    case 'insert':
      return `gridfinity_label_insert_${product.cells}u`;
    case 'bin':
    case 'binWithInsert': {
      const bin = product.bin;
      return `gridfinity_bin_${bin.gridX}x${bin.gridY}x${bin.heightUnits}`;
    }
    case 'baseplate':
      return `gridfinity_baseplate_${product.unitsX}x${product.unitsY}`;
    case 'clip': {
      // The decimal point becomes p so the stem stays a single dotless token.
      const tol =
        product.toleranceMm !== 0 ? `_tol${String(product.toleranceMm).replace('.', 'p')}` : '';
      return `gridfinity_connection_clip${tol}`;
    }
    default:
      return assertNever(product);
  }
}

/** A generated part with everywhere its copies go on the plate. */
interface ArrangedPart {
  part: PrintablePart;
  placements: Placement[];
}

/**
 * Expands the products into their printable parts, deduplicates identical
 * parts and arranges every copy on an automatically sized plate, so each
 * unique part generates once.
 */
function arrangeUniqueParts(products: DownloadProduct[]): ArrangedPart[] {
  const groups = new Map<string, { part: PrintablePart; ids: string[] }>();
  const items: FootprintItem[] = [];
  let instance = 0;
  for (const entry of products) {
    for (const part of partsOf(entry.product)) {
      const key = partKey(part);
      let group = groups.get(key);
      if (group === undefined) {
        group = { part, ids: [] };
        groups.set(key, group);
      }
      const footprint = partFootprint(part);
      for (let i = 0; i < entry.count; i++) {
        const id = `part#${instance++}`;
        group.ids.push(id);
        items.push({ id, ...footprint });
      }
    }
  }
  const placementById = new Map(arrangeAutoPlate(items).map((p) => [p.id, p]));
  return [...groups.values()].map((group) => ({
    part: group.part,
    placements: group.ids.map((id) => placementById.get(id)!),
  }));
}

/**
 * Collects the warnings one download produced, in order and without repeats.
 * A part is generated once and placed many times, so the same sentence would
 * otherwise arrive once per copy.
 */
function collectWarnings(): { warn: WarningSink; warnings: string[] } {
  const seen = new Set<string>();
  const warnings: string[] = [];
  return {
    warnings,
    warn: (message) => {
      if (seen.has(message)) return;
      seen.add(message);
      warnings.push(message);
    },
  };
}

/**
 * Downloads one product as a single STL mesh (all its parts arranged side by
 * side) and returns whatever the generation warned about, for the caller to
 * show. Only a cutout bin produces any.
 */
export async function downloadProductStl(product: Product): Promise<string[]> {
  const arranged = arrangeUniqueParts([{ product, count: 1 }]);
  const { warn, warnings } = collectWarnings();
  if (arranged.length === 1) {
    const mesh = await generatePartUnion(arranged[0].part, warn);
    triggerDownload(meshToStlBlob(mesh), `${fileStem(product)}.stl`);
    return warnings;
  }
  const placed: PlacedMesh[] = [];
  for (const { part, placements } of arranged) {
    const mesh = await generatePartUnion(part, warn);
    for (const placement of placements) {
      placed.push({ mesh, xMm: placement.xMm, yMm: placement.yMm });
    }
  }
  triggerDownload(meshToStlBlob(mergePlacedMeshes(placed)), `${fileStem(product)}.stl`);
  return warnings;
}

/** Downloads one product as a two-filament 3MF (body slot 1, label slot 2). */
export async function downloadProduct3mf(product: Product): Promise<string[]> {
  const arranged = arrangeUniqueParts([{ product, count: 1 }]);
  const { warn, warnings } = collectWarnings();
  const items: PlateItem[] = [];
  for (const { part, placements } of arranged) {
    const meshes = await generatePartMeshes(part, warn);
    items.push({
      body: meshes.body,
      label: meshes.label,
      name: partName(part),
      instances: placements.map((p) => ({ xMm: p.xMm, yMm: p.yMm })),
    });
  }
  const bytes = writePlate3mf(items);
  triggerDownload(
    new Blob([bytes.buffer as ArrayBuffer], { type: 'model/3mf' }),
    `${fileStem(product)}.3mf`,
  );
  return warnings;
}

/** The three formats a batch can be downloaded as. */
export type BatchFormat = 'stl' | '3mf-single' | '3mf-two';

/**
 * Downloads a whole batch in the given format: one merged STL, a
 * single-color 3MF (inserts as plain single-color parts) or a two-filament
 * 3MF (bodies on slot 1, insert labels on slot 2). Progress is reported per
 * unique part, and whatever the generation warned about comes back for the
 * caller to show.
 */
export async function downloadBatch(
  products: DownloadProduct[],
  format: BatchFormat,
  batchName: string,
  onProgress: (text: string) => void,
): Promise<string[]> {
  const unique = arrangeUniqueParts(products);
  const { warn, warnings } = collectWarnings();
  const stem = batchName.trim() === '' ? 'gridfinity_batch' : sanitizeFileName(batchName);
  if (format === 'stl') {
    const placed: PlacedMesh[] = [];
    for (let i = 0; i < unique.length; i++) {
      onProgress(`Generating part ${i + 1} of ${unique.length}`);
      const mesh = await generatePartUnion(unique[i].part, warn);
      for (const placement of unique[i].placements) {
        placed.push({ mesh, xMm: placement.xMm, yMm: placement.yMm });
      }
    }
    triggerDownload(meshToStlBlob(mergePlacedMeshes(placed)), `${stem}.stl`);
    return warnings;
  }
  const items: PlateItem[] = [];
  for (let i = 0; i < unique.length; i++) {
    onProgress(`Generating part ${i + 1} of ${unique.length}`);
    let body;
    let label = null;
    if (format === '3mf-two') {
      const meshes = await generatePartMeshes(unique[i].part, warn);
      body = meshes.body;
      label = meshes.label;
    } else {
      body = await generatePartUnion(unique[i].part, warn);
    }
    items.push({
      body,
      label,
      name: partName(unique[i].part),
      instances: unique[i].placements.map((p) => ({ xMm: p.xMm, yMm: p.yMm })),
    });
  }
  const bytes = writePlate3mf(items);
  const suffix = format === '3mf-two' ? '' : '_single_color';
  triggerDownload(
    new Blob([bytes.buffer as ArrayBuffer], { type: 'model/3mf' }),
    `${stem}${suffix}.3mf`,
  );
  return warnings;
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[^a-z0-9-]+/gi, '_').toLowerCase();
}
