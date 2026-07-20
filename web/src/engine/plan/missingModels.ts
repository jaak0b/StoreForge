import type { SizeMm } from '../cutout/cutoutBin';
import type { CutoutBin, CutoutModel } from './types';

/**
 * A plan carries a cutout model's metadata and placement but never its
 * triangles, which live in this device's model store under the model's opaque
 * modelSourceId. Open a plan on another machine, or on the same machine after
 * the site data was cleared, and every model resolves to nothing.
 *
 * Following the trace photo precedent, that is a normal condition and not a
 * failure: the bin is intact apart from the triangles, so the app neither
 * discards it nor pretends it is whole. This module owns that condition. It
 * says which models a bin is missing, words what the user is told about them,
 * and re-links a located file to the model record it belongs to.
 *
 * What it must never allow is a bin generating with an empty model list, which
 * would export as a solid block of plastic and waste a real print. Generation
 * refuses with the message below instead.
 */

/** The facts a freshly imported file contributes to a model record. */
export interface ImportedModelFacts {
  /** The chosen file's name, as the file system reports it. */
  name: string;
  /** Triangle count as imported. */
  triangleCount: number;
  /** Bounding box of the imported model in mm, after the unit scale applies. */
  sizeMm: SizeMm;
}

/** A model record re-linked to a located file, plus anything to tell the user. */
export interface RelinkedModel {
  /** The updated model record, which keeps the record's identity and placement. */
  model: CutoutModel;
  /** A non-blocking note to show once, or null when there is nothing to say. */
  note: string | null;
}

/**
 * The models of a cutout bin whose bytes this device does not have, in the
 * bin's own order. An empty result means the bin can be generated.
 */
export function missingCutoutModels(
  bin: CutoutBin,
  storedModelIds: ReadonlySet<string>,
): CutoutModel[] {
  return bin.models.filter((model) => !storedModelIds.has(model.modelSourceId));
}

/** Joins quoted file names into an English list: "a", "a" and "b", "a", "b" and "c". */
function quotedNameList(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * What a plan listing says about a bin whose models this device does not have,
 * naming them so the user can find the files without opening the bin. Returns
 * an empty string when nothing is missing.
 */
export function describeMissingModels(models: CutoutModel[]): string {
  if (models.length === 0) return '';
  const names = quotedNameList(models.map((model) => model.name));
  const noun = models.length === 1 ? 'the model' : 'the models';
  const tail = models.length === 1 ? 'which is' : 'which are';
  return `This bin needs ${noun} ${names}, ${tail} not stored on this device.`;
}

/**
 * Why a bin whose model bytes are absent cannot be generated. This blocks
 * generation, which is the point: the alternative is a solid block of plastic.
 */
export function modelNotStoredMessage(model: CutoutModel): string {
  return (
    `The model "${model.name}" is not stored on this device, so this bin cannot be ` +
    'generated. Upload the model again, or remove it from the bin.'
  );
}

/**
 * Links a located file to an existing model record, keeping the record's id
 * and its modelSourceId so nothing else in the plan has to change.
 *
 * The placement, the unit scale and the clearance are preserved exactly: they
 * are the user's own work and re-doing them is the thing this flow exists to
 * avoid. The name, the triangle count and the size come from the chosen file.
 *
 * The app cannot verify that the chosen file is the original one, because STL
 * carries no name, no checksum and no identity of any kind, and a stored hash
 * of the original bytes could only ever say no, never yes: it would refuse a
 * file that is genuinely the right model re-exported from CAD. So a different
 * file is accepted and the substitution is made visible instead. The stored
 * name becomes the new file's name, so later messages describe what the bin
 * actually contains, the size readout is recomputed so a wrong file shows
 * itself there, and the placement is kept so a wrong model sits wrong visibly
 * in the preview rather than being silently re-centred.
 */
export function relinkCutoutModel(
  existing: CutoutModel,
  imported: ImportedModelFacts,
): RelinkedModel {
  const model: CutoutModel = {
    ...existing,
    name: imported.name,
    triangleCount: imported.triangleCount,
    sizeMm: imported.sizeMm,
  };
  const renamed = imported.name !== existing.name;
  return {
    model,
    note: renamed
      ? `The file "${imported.name}" was linked to the model previously stored as ` +
        `"${existing.name}". Check the size readout if you expected a different model.`
      : null,
  };
}
