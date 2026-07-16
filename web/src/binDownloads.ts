import { generateLabeledBin, generateLabeledBinUnion } from './workerClient';
import { meshToStlBlob } from './engine/gridfinity/stlExport';
import { PITCH } from './engine/gridfinity/constants';
import type { LabeledBinParams } from './engine/gridfinity/types';
import { binParamsKey } from './engine/plan/batches';
import { arrangeAutoPlate, type FootprintItem, type Placement } from './engine/plate/arranger';
import { mergePlacedMeshes, type PlacedMesh } from './engine/plate/placement';
import { writePlate3mf, type PlateItem } from './engine/threeMf/writer';

/**
 * Shared download plumbing for the single-page UI: single-bin STL/3MF from a
 * queue row and merged STL / 3MF exports of a whole print batch. The plate
 * layout for batch downloads is arranged automatically (no plate preview);
 * the user rearranges bins in the slicer.
 */

/** Footprint clearance: the base is 0.5 mm smaller than the grid pitch. */
const FOOTPRINT_CLEARANCE = 0.5;

/** One bin design with the number of copies to export. */
export interface DownloadBin {
  params: LabeledBinParams;
  count: number;
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

function fileStem(params: LabeledBinParams): string {
  return `gridfinity_bin_${params.gridX}x${params.gridY}x${params.heightUnits}`;
}

/** Downloads one bin as a single STL mesh. */
export async function downloadBinStl(params: LabeledBinParams): Promise<void> {
  const mesh = await generateLabeledBinUnion(params);
  triggerDownload(meshToStlBlob(mesh), `${fileStem(params)}.stl`);
}

/** Downloads one bin as a two-filament 3MF (body slot 1, label slot 2). */
export async function downloadBin3mf(params: LabeledBinParams): Promise<void> {
  const meshes = await generateLabeledBin(params);
  const bytes = writePlate3mf([
    {
      body: meshes.body,
      label: meshes.label,
      name: binName(params),
      instances: [{ xMm: 0, yMm: 0 }],
    },
  ]);
  triggerDownload(
    new Blob([bytes.buffer as ArrayBuffer], { type: 'model/3mf' }),
    `${fileStem(params)}.3mf`,
  );
}

interface UniqueBin {
  params: LabeledBinParams;
  placements: Placement[];
}

/**
 * Deduplicates identical bin designs and arranges every copy on an
 * automatically sized plate, so each unique design generates once.
 */
function arrangeUniqueBins(bins: DownloadBin[]): UniqueBin[] {
  const groups = new Map<string, { params: LabeledBinParams; ids: string[] }>();
  const items: FootprintItem[] = [];
  let instance = 0;
  for (const bin of bins) {
    const key = binParamsKey(bin.params);
    let group = groups.get(key);
    if (group === undefined) {
      group = { params: bin.params, ids: [] };
      groups.set(key, group);
    }
    for (let i = 0; i < bin.count; i++) {
      const id = `bin#${instance++}`;
      group.ids.push(id);
      items.push({
        id,
        widthMm: bin.params.gridX * PITCH - FOOTPRINT_CLEARANCE,
        depthMm: bin.params.gridY * PITCH - FOOTPRINT_CLEARANCE,
      });
    }
  }
  const placementById = new Map(arrangeAutoPlate(items).map((p) => [p.id, p]));
  return [...groups.values()].map((group) => ({
    params: group.params,
    placements: group.ids.map((id) => placementById.get(id)!),
  }));
}

/** The three formats a batch can be downloaded as. */
export type BatchFormat = 'stl' | '3mf-single' | '3mf-two';

/**
 * Downloads a whole batch in the given format: one merged STL, a
 * single-color 3MF (labels unioned into their bodies) or a two-filament 3MF
 * (bodies on slot 1, labels on slot 2). Progress is reported per unique bin.
 */
export async function downloadBatch(
  bins: DownloadBin[],
  format: BatchFormat,
  batchName: string,
  onProgress: (text: string) => void,
): Promise<void> {
  const unique = arrangeUniqueBins(bins);
  const stem = batchName.trim() === '' ? 'gridfinity_batch' : sanitizeFileName(batchName);
  if (format === 'stl') {
    const placed: PlacedMesh[] = [];
    for (let i = 0; i < unique.length; i++) {
      onProgress(`Generating bin ${i + 1} of ${unique.length}`);
      const mesh = await generateLabeledBinUnion(unique[i].params);
      for (const placement of unique[i].placements) {
        placed.push({ mesh, xMm: placement.xMm, yMm: placement.yMm });
      }
    }
    triggerDownload(meshToStlBlob(mergePlacedMeshes(placed)), `${stem}.stl`);
    return;
  }
  const items: PlateItem[] = [];
  for (let i = 0; i < unique.length; i++) {
    onProgress(`Generating bin ${i + 1} of ${unique.length}`);
    let body;
    let label = null;
    if (format === '3mf-two') {
      const meshes = await generateLabeledBin(unique[i].params);
      body = meshes.body;
      label = meshes.label;
    } else {
      body = await generateLabeledBinUnion(unique[i].params);
    }
    items.push({
      body,
      label,
      name: binName(unique[i].params),
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
