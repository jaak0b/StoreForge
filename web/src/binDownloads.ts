import {
  generateInsert,
  generateInsertUnion,
  generatePocketBin,
  generatePocketBinUnion,
  generateSlottedBin,
  generateSlottedBinUnion,
} from './workerClient';
import { meshToStlBlob } from './engine/gridfinity/stlExport';
import { binOuterSizeMm } from './engine/gridfinity/constants';
import { INSERT_DEPTH, insertLengthMm } from './engine/label/slot';
import type { MeshData, PartMeshes } from './engine/gridfinity/types';
import type { BinPockets, Product } from './engine/plan/types';
import { partsOf, type PrintablePart } from './engine/plan/geometry';
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

/** Generates one part's separate body and label meshes. */
function generatePartMeshes(part: PrintablePart): Promise<PartMeshes> {
  if (part.part === 'insert') return generateInsert(part.insert);
  if (part.pockets === undefined) return generateSlottedBin(part.bin);
  return generatePocketBin({ ...part.bin, ...plainPockets(part.pockets) });
}

/** Generates one part as a single unioned mesh. */
function generatePartUnion(part: PrintablePart): Promise<MeshData> {
  if (part.part === 'insert') return generateInsertUnion(part.insert);
  if (part.pockets === undefined) return generateSlottedBinUnion(part.bin);
  return generatePocketBinUnion({ ...part.bin, ...plainPockets(part.pockets) });
}

/** The part's plate footprint in millimetres. */
function partFootprint(part: PrintablePart): { widthMm: number; depthMm: number } {
  if (part.part === 'insert') {
    return { widthMm: insertLengthMm(part.insert.cells), depthMm: INSERT_DEPTH };
  }
  return {
    widthMm: binOuterSizeMm(part.bin.gridX),
    depthMm: binOuterSizeMm(part.bin.gridY),
  };
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
  if (part.part === 'insert') {
    const text = part.insert.content.text;
    return text !== '' ? `${text} label insert` : `${part.insert.cells}u label insert`;
  }
  const size = `${part.bin.gridX}x${part.bin.gridY}x${part.bin.heightUnits}`;
  return part.labelText !== undefined ? `${part.labelText} (${size})` : size;
}

/** File name stem of a single-product download. */
function fileStem(product: Product): string {
  if (product.kind === 'insert') {
    return `gridfinity_label_insert_${product.cells}u`;
  }
  const bin = product.bin;
  return `gridfinity_bin_${bin.gridX}x${bin.gridY}x${bin.heightUnits}`;
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

/** Downloads one product as a single STL mesh (all its parts arranged side by side). */
export async function downloadProductStl(product: Product): Promise<void> {
  const arranged = arrangeUniqueParts([{ product, count: 1 }]);
  if (arranged.length === 1) {
    const mesh = await generatePartUnion(arranged[0].part);
    triggerDownload(meshToStlBlob(mesh), `${fileStem(product)}.stl`);
    return;
  }
  const placed: PlacedMesh[] = [];
  for (const { part, placements } of arranged) {
    const mesh = await generatePartUnion(part);
    for (const placement of placements) {
      placed.push({ mesh, xMm: placement.xMm, yMm: placement.yMm });
    }
  }
  triggerDownload(meshToStlBlob(mergePlacedMeshes(placed)), `${fileStem(product)}.stl`);
}

/** Downloads one product as a two-filament 3MF (body slot 1, label slot 2). */
export async function downloadProduct3mf(product: Product): Promise<void> {
  const arranged = arrangeUniqueParts([{ product, count: 1 }]);
  const items: PlateItem[] = [];
  for (const { part, placements } of arranged) {
    const meshes = await generatePartMeshes(part);
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
}

/** The three formats a batch can be downloaded as. */
export type BatchFormat = 'stl' | '3mf-single' | '3mf-two';

/**
 * Downloads a whole batch in the given format: one merged STL, a
 * single-color 3MF (inserts as plain single-color parts) or a two-filament
 * 3MF (bodies on slot 1, insert labels on slot 2). Progress is reported per
 * unique part.
 */
export async function downloadBatch(
  products: DownloadProduct[],
  format: BatchFormat,
  batchName: string,
  onProgress: (text: string) => void,
): Promise<void> {
  const unique = arrangeUniqueParts(products);
  const stem = batchName.trim() === '' ? 'gridfinity_batch' : sanitizeFileName(batchName);
  if (format === 'stl') {
    const placed: PlacedMesh[] = [];
    for (let i = 0; i < unique.length; i++) {
      onProgress(`Generating part ${i + 1} of ${unique.length}`);
      const mesh = await generatePartUnion(unique[i].part);
      for (const placement of unique[i].placements) {
        placed.push({ mesh, xMm: placement.xMm, yMm: placement.yMm });
      }
    }
    triggerDownload(meshToStlBlob(mergePlacedMeshes(placed)), `${stem}.stl`);
    return;
  }
  const items: PlateItem[] = [];
  for (let i = 0; i < unique.length; i++) {
    onProgress(`Generating part ${i + 1} of ${unique.length}`);
    let body;
    let label = null;
    if (format === '3mf-two') {
      const meshes = await generatePartMeshes(unique[i].part);
      body = meshes.body;
      label = meshes.label;
    } else {
      body = await generatePartUnion(unique[i].part);
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
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[^a-z0-9-]+/gi, '_').toLowerCase();
}
