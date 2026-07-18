import {
  generateLabeledBin,
  generateLabeledBinUnion,
  generateLabelInsert,
  generateLabelInsertUnion,
  generatePocketBin,
  generatePocketBinUnion,
} from './workerClient';
import { meshToStlBlob } from './engine/gridfinity/stlExport';
import { binOuterSizeMm } from './engine/gridfinity/constants';
import { labelModeOf } from './engine/gridfinity/binGenerator';
import { INSERT_DEPTH, insertLengthMm } from './engine/label/slot';
import type { LabeledBinMeshes, LabeledBinParams, MeshData } from './engine/gridfinity/types';
import type { BinPockets } from './engine/plan/types';
import { binParamsKey } from './engine/plan/batches';
import { arrangeAutoPlate, type FootprintItem, type Placement } from './engine/plate/arranger';
import { mergePlacedMeshes, type PlacedMesh } from './engine/plate/placement';
import { writePlate3mf, type PlateItem } from './engine/threeMf/writer';

/**
 * Shared download plumbing for the single-page UI: single-bin STL/3MF from a
 * queue row and merged STL / 3MF exports of a whole print batch. The plate
 * layout for batch downloads is arranged automatically (no plate preview);
 * the user rearranges bins in the slicer. An entry expands into its printable
 * parts first: a 'slot-insert' entry contributes its slotted bin and its
 * label insert as two separately placed parts, an 'insert' entry only the
 * insert, everything else the bin itself.
 */

/** One bin design with the number of copies to export. */
export interface DownloadBin {
  params: LabeledBinParams;
  count: number;
  /** Tool pockets of the bin, when it has any. */
  pockets?: BinPockets;
}

/** One printable part of a queue entry: the bin body or the label insert. */
interface EntryPart {
  params: LabeledBinParams;
  pockets?: BinPockets;
  part: 'bin' | 'insert';
}

/** Expands an entry into the parts its label mode calls for. */
function partsOf(params: LabeledBinParams, pockets?: BinPockets): EntryPart[] {
  const mode = labelModeOf(params);
  if (mode === 'insert') return [{ params, part: 'insert' }];
  if (mode === 'slot-insert') {
    // The bin part is exported as a plain slotted bin so the insert never
    // rides along inside the slot; the insert is its own placed part.
    return [
      { params: { ...params, labelMode: 'slot' }, pockets, part: 'bin' },
      { params, part: 'insert' },
    ];
  }
  return [{ params, pockets, part: 'bin' }];
}

// Pocket data crossing into the worker is deep-copied to strip Vue proxies,
// which the structured clone of the worker call rejects.
function plainPockets(pockets: BinPockets): BinPockets {
  return JSON.parse(JSON.stringify(pockets)) as BinPockets;
}

/** Generates one part's separate body and label meshes. */
function generatePartMeshes(part: EntryPart): Promise<LabeledBinMeshes> {
  if (part.part === 'insert') return generateLabelInsert(part.params);
  if (part.pockets === undefined) return generateLabeledBin(part.params);
  return generatePocketBin({ ...part.params, ...plainPockets(part.pockets) });
}

/** Generates one part as a single unioned mesh. */
function generatePartUnion(part: EntryPart): Promise<MeshData> {
  if (part.part === 'insert') return generateLabelInsertUnion(part.params);
  if (part.pockets === undefined) return generateLabeledBinUnion(part.params);
  return generatePocketBinUnion({ ...part.params, ...plainPockets(part.pockets) });
}

/** The part's plate footprint in millimetres. */
function partFootprint(part: EntryPart): { widthMm: number; depthMm: number } {
  if (part.part === 'insert') {
    return { widthMm: insertLengthMm(part.params.gridX), depthMm: INSERT_DEPTH };
  }
  return {
    widthMm: binOuterSizeMm(part.params.gridX),
    depthMm: binOuterSizeMm(part.params.gridY),
  };
}

export function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function binName(params: LabeledBinParams): string {
  const size = `${params.gridX}x${params.gridY}x${params.heightUnits}`;
  return params.labelText !== '' ? `${params.labelText} (${size})` : size;
}

/** Object name of one part, shown in the slicer. */
function partName(part: EntryPart): string {
  const name = binName(part.params);
  return part.part === 'insert' ? `${name} label insert` : name;
}

function fileStem(params: LabeledBinParams): string {
  if (labelModeOf(params) === 'insert') {
    return `gridfinity_label_insert_${params.gridX}u`;
  }
  return `gridfinity_bin_${params.gridX}x${params.gridY}x${params.heightUnits}`;
}

/** A generated part with everywhere its copies go on the plate. */
interface ArrangedPart {
  part: EntryPart;
  placements: Placement[];
}

/**
 * Expands the bins into their printable parts, deduplicates identical parts
 * and arranges every copy on an automatically sized plate, so each unique
 * part generates once.
 */
function arrangeUniqueParts(bins: DownloadBin[]): ArrangedPart[] {
  const groups = new Map<string, { part: EntryPart; ids: string[] }>();
  const items: FootprintItem[] = [];
  let instance = 0;
  for (const bin of bins) {
    for (const part of partsOf(bin.params, bin.pockets)) {
      const key = `${part.part}:${binParamsKey(part.params, part.pockets)}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { part, ids: [] };
        groups.set(key, group);
      }
      const footprint = partFootprint(part);
      for (let i = 0; i < bin.count; i++) {
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

/** Downloads one queue entry as a single STL mesh (all its parts arranged side by side). */
export async function downloadBinStl(
  params: LabeledBinParams,
  pockets?: BinPockets,
): Promise<void> {
  const arranged = arrangeUniqueParts([{ params, count: 1, pockets }]);
  if (arranged.length === 1) {
    const mesh = await generatePartUnion(arranged[0].part);
    triggerDownload(meshToStlBlob(mesh), `${fileStem(params)}.stl`);
    return;
  }
  const placed: PlacedMesh[] = [];
  for (const { part, placements } of arranged) {
    const mesh = await generatePartUnion(part);
    for (const placement of placements) {
      placed.push({ mesh, xMm: placement.xMm, yMm: placement.yMm });
    }
  }
  triggerDownload(meshToStlBlob(mergePlacedMeshes(placed)), `${fileStem(params)}.stl`);
}

/** Downloads one queue entry as a two-filament 3MF (body slot 1, label slot 2). */
export async function downloadBin3mf(
  params: LabeledBinParams,
  pockets?: BinPockets,
): Promise<void> {
  const arranged = arrangeUniqueParts([{ params, count: 1, pockets }]);
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
    `${fileStem(params)}.3mf`,
  );
}

/** The three formats a batch can be downloaded as. */
export type BatchFormat = 'stl' | '3mf-single' | '3mf-two';

/**
 * Downloads a whole batch in the given format: one merged STL, a
 * single-color 3MF (labels unioned into their bodies) or a two-filament 3MF
 * (bodies on slot 1, labels on slot 2). Progress is reported per unique part.
 */
export async function downloadBatch(
  bins: DownloadBin[],
  format: BatchFormat,
  batchName: string,
  onProgress: (text: string) => void,
): Promise<void> {
  const unique = arrangeUniqueParts(bins);
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
