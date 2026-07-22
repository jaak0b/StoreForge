<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useApp } from '../../stores/app';
import { useBinDesigner, type ProductChoice } from '../../stores/binDesigner';
import { useBinQueue } from '../../stores/binQueue';
import { cloneEdit, useCutout } from '../../stores/cutout';
import { useBinPreview } from '../../composables/useBinPreview';
import {
  useCavityEditPreview,
  type CavityCarveOutcome,
} from '../../composables/useCavityEditPreview';
import {
  generateCutoutBinPreview,
  importCutoutModel,
  type CutoutBinRequest,
  type CutoutPreviewResult,
} from '../../workerClient';
import { getModel, putModel } from '../../modelStore';
import { parseStl } from '../../engine/cutout/stlReader';
import { centredModelMesh, meshBounds, type MeshBounds } from '../../engine/cutout/cutoutMesh';
import {
  DEFAULT_CUTOUT_CLEARANCE_MM,
  DEFAULT_CUTOUT_SWEEP_ENABLED,
  maxClearanceMm,
  validateClearanceMm,
  type SizeMm,
} from '../../engine/cutout/cutoutBin';
import { DEFAULT_DRAFT_ANGLE_DEG, validateDraftAngleDeg } from '../../engine/carve/sweep';
import {
  fitBinToModels,
  interiorBoundsMm,
  restingPlacementMm,
} from '../../engine/cutout/binEnvelope';
import { proposeUnitScale } from '../../engine/cutout/unitScale';
import { modelNotStoredMessage, relinkCutoutModel } from '../../engine/plan/missingModels';
import { MIN_HEIGHT_UNITS } from '../../engine/gridfinity/constants';
import type { SlottedBinParams } from '../../engine/gridfinity/types';
import {
  assertNever,
  binOf,
  type CutoutBin,
  type CutoutModel,
  type Product,
  type QueueEntry,
} from '../../engine/plan/types';
import { describeProduct } from '../../engine/plan/rowDescriptor';
import { overallHeightMm } from '../../heightHint';
import type { CutoutGhost, CutoutGhostMoved } from './cutoutGhost';
import CutoutViewport from './CutoutViewport.vue';
import PaintToolbar from '../carve/PaintToolbar.vue';
import ModelList from './ModelList.vue';
import ModelReadout from './ModelReadout.vue';
import CarveProgressBar from '../CarveProgressBar.vue';
import LabelIconField from '../LabelIconField.vue';
import ProductSelect from '../ProductSelect.vue';
import MoreOptions from '../MoreOptions.vue';

/**
 * The Cutout bin tab of the add-bin card: import STL models of the objects the
 * bin has to hold, place them freely with the gizmo, and queue the bin whose
 * interior is carved to their shape.
 *
 * The preview runs in two tiers, which is what keeps it usable. The viewport
 * draws the imported triangles as translucent ghosts and the gizmo moves them
 * at frame rate with no CSG at all; the real carve runs in the worker once the
 * placement stops changing, and the bin shown until it lands is the previous
 * carve, marked as out of date. So the ghosts are always live and the pockets
 * are always honest, and the difference between them is labeled rather than
 * hidden.
 *
 * The one write ordering that matters is in importFile below: a model's file
 * reaches IndexedDB and the queue store's protected list before any plan
 * mutation, because persisting the plan sweeps every stored model no plan row
 * references.
 */

const app = useApp();
const designer = useBinDesigner();
const queue = useBinQueue();
const cutout = useCutout();

const { labelText, labelIcon, heightUnits, fused, notes } = storeToRefs(designer);
const { gridX, gridY } = storeToRefs(cutout);

const heightMm = computed(() => overallHeightMm(heightUnits.value));

/**
 * Step of the clearance stepper, in mm. A user interface increment rather than
 * a derived dimension: roughly an eighth of a nozzle width, fine enough to tune
 * a fit that is close but not right, and coarse enough that stepping to the
 * next sensible value is one or two clicks.
 */
const CLEARANCE_STEP_MM = 0.05;

const quantity = ref(1);
/** Files the last upload refused, each naming the file and why. */
const uploadErrors = ref<string[]>([]);
/** Exact bounds of each placed model, as the viewport measures them. */
const boundsById = ref<Record<string, MeshBounds>>({});

/**
 * A cutout bin cannot be a standalone insert: an insert has no interior for a
 * pocket. The shared product choice is coerced rather than overwritten, so
 * opening this tab never changes what another tab is designing.
 */
const productChoice = computed<ProductChoice>({
  get: () => (designer.productChoice === 'insert' ? 'plainBin' : designer.productChoice),
  set: (value) => {
    designer.productChoice = value;
  },
});

const hasLabel = computed(() => productChoice.value === 'binWithInsert');

const interior = computed(() =>
  interiorBoundsMm(cutout.gridX, cutout.gridY, designer.heightUnits),
);

const clearanceCeilingMm = computed(() => maxClearanceMm(cutout.gridX, cutout.gridY));

// ---------------------------------------------------------------------------
// The bin being designed
// ---------------------------------------------------------------------------

/**
 * The bin envelope and label packaging of the current design. The footprint is
 * this tab's own (the models decide it, not the manual designer's fields) and a
 * cutout bin never has divider walls, because its interior is filled solid
 * before the models are subtracted from it.
 */
const binParams = computed<SlottedBinParams>(() => {
  const withInsert = productChoice.value === 'binWithInsert';
  const isFused = withInsert && designer.fused;
  const content = {
    text: designer.labelText,
    text2: designer.labelText2,
    icon: designer.labelIcon,
  };
  return {
    gridX: cutout.gridX,
    gridY: cutout.gridY,
    heightUnits: designer.heightUnits,
    magnetHoles: designer.magnetHoles,
    walls: [],
    labelSlot: productChoice.value !== 'plainBin' && !isFused,
    insert: withInsert && !isFused ? content : null,
    fusedLabel: isFused ? content : null,
  };
});

/**
 * The carve request: the bin plus the models it carves, as plain JSON. Vue's
 * reactive proxies do not survive the structured clone of a worker call, so
 * every model record is deep copied on the way out.
 */
const carveRequest = computed<CutoutBinRequest>(() => ({
  ...binParams.value,
  models: cutout.carvableModels.map((model) => ({
    modelSourceId: model.modelSourceId,
    unitScale: model.unitScale,
    clearanceMm: model.clearanceMm,
    name: model.name,
    placement: { ...model.placement },
    sweepEnabled: model.sweepEnabled,
    draftAngleDeg: model.draftAngleDeg,
  })),
  edits: cutout.edits.map(cloneEdit),
}));

// ---------------------------------------------------------------------------
// The two preview tiers
// ---------------------------------------------------------------------------

/**
 * The model ids the carve request names, in the order the carve receives them.
 * The single mapping from a carve-order index back onto a model: the carve
 * returns its footprints and its warnings in that order, and the names it
 * quotes cannot be used, because two uploads of the same file share a name.
 */
const carveModelIds = computed(() => cutout.carvableModels.map((model) => model.id));

/**
 * A carve result with the model ids it was built from carried alongside it.
 * The ids belong to the result, not to shared state: progressive display can
 * show an older finished carve while a newer one runs, so a list recorded
 * separately would already hold the newer request's ids by the time the older
 * result lands, and its footprints and warnings would map onto the wrong rows.
 * Travelling with the result, the ids always match the carve they describe.
 */
type CutoutCarveMeta = Omit<Extract<CutoutPreviewResult, { outcome: 'carved' }>, 'outcome'> & {
  modelIds: string[];
};
type CarveResultWithIds = CavityCarveOutcome<CutoutCarveMeta>;

/**
 * Carves the preview, or refuses because a model's file is not on this device.
 *
 * The refusal is the point. A model with no bytes is simply left out of the
 * carve request, so carving anyway would produce a bin that looks finished and
 * is missing a pocket, and the user would have no way to tell. Refusing names
 * the file instead, exactly as the download does, and the ghosts of the models
 * that did resolve stay on screen so the rest of the bin is still editable.
 */
async function carvePreview(request: CutoutBinRequest): Promise<CarveResultWithIds> {
  const refusal = previewRefusal.value;
  if (refusal !== null) return Promise.reject(new Error(refusal));
  // Captured at the moment the request goes out, not when its result comes
  // back: a model removed while a carve is running would otherwise shift every
  // index under it, and the finished carve's warnings and pocket sizes would
  // land on the wrong models. The ids ride back with this request's own
  // result, so which carve they belong to is never in doubt.
  const modelIds = carveModelIds.value;
  const result = await generateCutoutBinPreview(request);
  return Object.assign(result, { modelIds, editCount: request.edits.length });
}

/** Why no bin can be carved right now, or null. */
const previewRefusal = computed<string | null>(() => {
  const missing = cutout.models.find((model) => cutout.stateOf(model.id).missing);
  return missing === undefined ? null : modelNotStoredMessage(missing);
});

const {
  meshes: previewResult,
  generating,
  errorMessage,
} = useBinPreview<CutoutBinRequest, CarveResultWithIds>(
  () => carveRequest.value,
  carvePreview,
);

/** The last carve that actually landed, which is what the viewport draws. */
const carved = shallowRef<Extract<CarveResultWithIds, { outcome: 'carved' }> | null>(null);
/** True from the first change until a carve of that change lands. */
const stale = ref(false);

watch(carveRequest, () => {
  stale.value = true;
}, { deep: true });

// A bin that cannot be carved must not go on showing the last bin that could:
// opening a plan whose model files are not on this device would otherwise show
// a plain uncarved bin with nothing saying the pockets are missing.
watch(previewRefusal, (refusal) => {
  if (refusal !== null) carved.value = null;
});

// The shared session-to-preview wiring: the landing switch (noteLandedCarve),
// the rejection rollback into editError, the active-tool clear, and the stroke
// and flatten commit builders. The cutout flow's own parts stay here as hooks:
// drawing the landed bin and dropping the out-of-date flag, and clearing the
// drawn bin when a carve fails.
const { editError, onStrokeCommit, onFlattenCommit } = useCavityEditPreview<CutoutCarveMeta>(
  cutout,
  { generating, errorMessage, previewResult },
  {
    onCarved: (result) => {
      carved.value = result;
      stale.value = false;
    },
    // A carve that finished with an error is not showing a valid bin, so the
    // drawn geometry is cleared, exactly as the missing-file refusal above does.
    onCarveFailed: () => {
      carved.value = null;
    },
  },
);

/** The placed pocket sizes the last carve measured, by model id. */
const pocketSizeById = computed<Record<string, SizeMm>>(() => {
  const result = carved.value;
  if (result === null) return {};
  const sizes: Record<string, SizeMm> = {};
  result.footprints.forEach((footprint, index) => {
    const id = result.modelIds[index];
    if (id !== undefined) sizes[id] = footprint.sizeMm;
  });
  return sizes;
});

/**
 * What the last carve warned about, by model id. Every warning names one model,
 * so every one of them has a card of its own to be shown on and nothing is left
 * over for a block at the foot of the tab. The one placement problem that is
 * NOT a warning, divider walls on a cutout bin, is thrown by the carve and
 * reaches the user through the error alert instead.
 */
const warningsByModelId = computed<Record<string, string[]>>(() => {
  const result = carved.value;
  if (result === null) return {};
  const byId: Record<string, string[]> = {};
  for (const warning of result.warnings) {
    const id = result.modelIds[warning.modelIndex];
    if (id === undefined) continue;
    (byId[id] ??= []).push(warning.message);
  }
  return byId;
});

/** The models a warning is attached to, for the viewport's red ghosts. */
const warnedModelIds = computed<string[]>(() => Object.keys(warningsByModelId.value));

const ghosts = computed<CutoutGhost[]>(() =>
  cutout.models.flatMap((model) => {
    const mesh = cutout.stateOf(model.id).mesh;
    return mesh === null ? [] : [{ id: model.id, mesh, placement: model.placement }];
  }),
);

function onBoundsChange(moved: CutoutGhostMoved): void {
  boundsById.value = { ...boundsById.value, [moved.id]: moved.bounds };
}

/**
 * A gizmo drag in progress. The placement is written straight through on every
 * frame, which is what keeps the readout honest while the model moves; the
 * carve does not follow, because the preview debounce restarts on every one of
 * these and can only elapse once the drag has stopped.
 */
function onPlacementChange(moved: CutoutGhostMoved): void {
  cutout.setPlacement(moved.id, moved.placement);
  onBoundsChange(moved);
}

function onPlacementCommit(moved: CutoutGhostMoved): void {
  onPlacementChange(moved);
}

// ---------------------------------------------------------------------------
// Painting manual cavity edits
// ---------------------------------------------------------------------------

/** Text shown for the "Clear all edits" confirmation. */
const clearEditsDialogOpen = ref(false);

/** Whether the viewport's shortcut help popover is open. */
const shortcutHelpOpen = ref(false);

/**
 * The eye button's own sticky toggle, combined with Tab held (tracked inside
 * the viewport) to hide the model ghosts, matching the trace canvas's "hold
 * Tab or eye button" behaviour.
 */
const modelsHiddenButton = ref(false);

/**
 * The cutout-specific shortcut row appended to the paint toolbar's own rows.
 * Hiding the model ghosts is a cutout concern (the tool bin has none), so it
 * is passed in rather than owned by the shared toolbar.
 */
const extraShortcutRows: { action: string; keys: string }[] = [
  { action: 'Hide models', keys: 'Hold Tab or eye button' },
];

/** Sets the active paint tool from a viewport keyboard shortcut. */
function onSetTool(tool: 'add' | 'remove' | 'flatten' | null): void {
  cutout.setActiveTool(tool);
}

/** Steps the brush radius from the viewport's [ and ] shortcuts; the store clamps the result. */
function onStepBrushRadius(deltaMm: number): void {
  cutout.setBrushRadius(cutout.brushRadiusMm + deltaMm);
}

function onConfirmClearEdits(): void {
  // clearEdits also forgets the known-good count, so nothing is left suspect.
  cutout.clearEdits();
  // No edit remains for the rejection alert to be about.
  editError.value = null;
  clearEditsDialogOpen.value = false;
}

// ---------------------------------------------------------------------------
// Importing models
// ---------------------------------------------------------------------------

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function importRejection(fileName: string, error: unknown): string {
  return `The file "${fileName}" was not imported. ${detailOf(error)}`;
}

/**
 * Runs one model's import stage in the worker and writes back what it measured.
 * The row shows it running; the model counts as carvable only once it lands, so
 * the bin keeps generating from the models that are ready meanwhile. Returns
 * null when it succeeded, or the worded failure when it did not.
 */
async function runImportStage(model: CutoutModel): Promise<string | null> {
  cutout.setBusy(model.id, true);
  try {
    const facts = await importCutoutModel({
      modelSourceId: model.modelSourceId,
      unitScale: model.unitScale,
      clearanceMm: model.clearanceMm,
      name: model.name,
    });
    cutout.applyImportedFacts(model.id, facts);
    cutout.setPrepared(model.id, true);
    return null;
  } catch (error) {
    return detailOf(error);
  } finally {
    cutout.setBusy(model.id, false);
  }
}

/**
 * Imports one chosen file as a new model.
 *
 * THE WRITE ORDER HERE IS LOAD BEARING. Persisting the plan sweeps every stored
 * model file that no plan row references, and this model has no plan row until
 * the bin is queued. So the id is registered as held by this editor BEFORE the
 * file is written, and it is only released once the bin is saved or the upload
 * is abandoned. Writing the file first leaves a window in which any plan
 * mutation deletes it, asynchronously and with nothing reporting it.
 */
async function importFile(file: File): Promise<void> {
  let mesh;
  let parsed;
  try {
    const buffer = await file.arrayBuffer();
    parsed = parseStl(buffer);
    mesh = centredModelMesh(parsed.mesh, 1);
  } catch (error) {
    uploadErrors.value.push(importRejection(file.name, error));
    return;
  }
  const rawBounds = meshBounds(parsed.mesh);

  const modelSourceId = crypto.randomUUID();
  queue.protectModel(modelSourceId);
  try {
    await putModel(modelSourceId, file);
  } catch (error) {
    queue.releaseModel(modelSourceId);
    uploadErrors.value.push(importRejection(file.name, error));
    return;
  }

  const model: CutoutModel = {
    id: crypto.randomUUID(),
    name: file.name,
    modelSourceId,
    triangleCount: parsed.triangleCount,
    unitScale: 1,
    sizeMm: { x: rawBounds.sizeX, y: rawBounds.sizeY, z: rawBounds.sizeZ },
    placement: restingPlacementMm(rawBounds.sizeZ),
    clearanceMm: DEFAULT_CUTOUT_CLEARANCE_MM,
    sweepEnabled: DEFAULT_CUTOUT_SWEEP_ENABLED,
    draftAngleDeg: DEFAULT_DRAFT_ANGLE_DEG,
  };
  cutout.addModel(model, mesh);

  const failure = await runImportStage(model);
  if (failure !== null) {
    // Nothing that cannot be prepared belongs in the bin: it would sit in the
    // list looking like a pocket that is never carved.
    discardModel(model.id, modelSourceId);
    uploadErrors.value.push(importRejection(file.name, failure));
    return;
  }
  proposeUnitsFor(model.id, model.name, rawBounds);
}

/** Offers the unit question when a model's size makes one worth asking. */
function proposeUnitsFor(id: string, name: string, rawBounds: MeshBounds): void {
  const largest = Math.max(rawBounds.sizeX, rawBounds.sizeY, rawBounds.sizeZ);
  cutout.setProposal(id, proposeUnitScale(name, largest));
}

/**
 * Drops a model from the bin and lets go of its stored file.
 *
 * The file is never deleted directly here, and that is deliberate. A model
 * removed while an existing bin is being edited is still referenced by the
 * queue row until the edit is saved, and deleting it outright would leave that
 * bin permanently without its model if the edit were then cancelled. Releasing
 * the hold and sweeping asks the one question that gets this right: is any plan
 * row still using it?
 */
function discardModel(id: string, modelSourceId: string): void {
  cutout.removeModel(id);
  delete boundsById.value[id];
  queue.releaseModel(modelSourceId);
  void queue.sweepStoredAssets();
  // The removed model's solid follows its file: it stays cached only while a
  // queue row still orders it.
  queue.retainCutoutWorkerCache();
}

async function onAddFiles(files: File[]): Promise<void> {
  uploadErrors.value = [];
  for (const file of files) await importFile(file);
}

function onRemoveModel(id: string): void {
  const model = cutout.modelById(id);
  if (model === null) return;
  discardModel(id, model.modelSourceId);
}

// ---------------------------------------------------------------------------
// Clearance, the one control that starts slow work
// ---------------------------------------------------------------------------

async function onCommitClearance(id: string, clearanceMm: number): Promise<void> {
  const model = cutout.modelById(id);
  if (model === null) return;
  const previous = model.clearanceMm;
  if (!Number.isFinite(clearanceMm) || clearanceMm === previous) {
    cutout.setClearanceDraft(id, previous);
    return;
  }
  try {
    validateClearanceMm(clearanceMm, cutout.gridX, cutout.gridY);
  } catch (error) {
    cutout.setError(id, detailOf(error));
    cutout.setClearanceDraft(id, previous);
    return;
  }
  cutout.setError(id, null);
  cutout.setBusy(id, true);
  try {
    // The committed clearance is left alone until the new solid exists, so the
    // model stays in the carve at the clearance it already has and the bin goes
    // on showing its pocket. Committing first would drop the pocket out of the
    // preview for however long the offset takes.
    await importCutoutModel({
      modelSourceId: model.modelSourceId,
      unitScale: model.unitScale,
      clearanceMm,
      name: model.name,
    });
    cutout.setClearance(id, clearanceMm);
    // The solid at the old clearance is under its own key; once nothing on the
    // page (this editor or a queue row) names it anymore, the retention drops
    // it, which is what stops a clearance tuned through five values from
    // leaving five solids in the worker's heap.
    queue.retainCutoutWorkerCache();
  } catch (error) {
    cutout.setError(
      id,
      `${detailOf(error)} The model is still using its previous clearance of ${previous} mm.`,
    );
    cutout.setClearanceDraft(id, previous);
  } finally {
    cutout.setBusy(id, false);
  }
}

// ---------------------------------------------------------------------------
// The sweep, which only re-carves
// ---------------------------------------------------------------------------

/**
 * Both sweep controls write plan data and nothing else: the sweep runs at
 * carve time on the placed cutter, so no cached solid is invalidated and no
 * import re-runs. The carve request is computed from the models, so writing
 * the field is what triggers the re-carve.
 */
function onSetSweep(id: string, sweepEnabled: boolean): void {
  cutout.setSweepEnabled(id, sweepEnabled);
}

function onCommitDraftAngle(id: string, draftAngleDeg: number): void {
  const model = cutout.modelById(id);
  if (model === null) return;
  const previous = model.draftAngleDeg;
  if (!Number.isFinite(draftAngleDeg) || draftAngleDeg === previous) {
    cutout.setDraftAngleDraft(id, previous);
    return;
  }
  try {
    validateDraftAngleDeg(draftAngleDeg);
  } catch (error) {
    cutout.setError(id, detailOf(error));
    cutout.setDraftAngleDraft(id, previous);
    return;
  }
  cutout.setError(id, null);
  cutout.setDraftAngle(id, draftAngleDeg);
}

// ---------------------------------------------------------------------------
// The unit question
// ---------------------------------------------------------------------------

async function onAcceptUnits(id: string): Promise<void> {
  const model = cutout.modelById(id);
  const proposal = cutout.stateOf(id).proposal;
  if (model === null || proposal === null) return;
  cutout.setProposal(id, null);
  // A rescaled model is a different solid under a different key, so nothing the
  // worker holds carves it. It leaves the carve until the new one is prepared,
  // which is the same state a model has right after it is uploaded.
  cutout.setPrepared(id, false);
  cutout.setUnitScale(id, proposal.unitScale);
  // Its ghost has to be rebuilt from the file at the new scale as well.
  const blob = await getModel(model.modelSourceId);
  if (blob !== null) {
    try {
      cutout.setMesh(
        id,
        centredModelMesh(parseStl(await blob.arrayBuffer()).mesh, proposal.unitScale),
      );
    } catch (error) {
      cutout.setError(id, detailOf(error));
    }
  }
  const failure = await runImportStage({ ...model, unitScale: proposal.unitScale });
  cutout.setError(id, failure);
  queue.retainCutoutWorkerCache();
}

function onKeepUnits(id: string): void {
  // Answered once and recorded in the plan, so the question is not asked again
  // for this model or when the bin is opened later.
  cutout.setProposal(id, null);
}

// ---------------------------------------------------------------------------
// Locating a model this device does not have
// ---------------------------------------------------------------------------

/**
 * Links a chosen file to a model record whose bytes this device does not hold.
 * The record keeps its id and its model source id, so nothing else in the plan
 * changes and nothing has to be placed again; the name, the triangle count and
 * the size come from the file that was actually chosen, which is what makes a
 * substituted file visible instead of silently wrong.
 */
async function onLocateFile(id: string, file: File): Promise<void> {
  const existing = cutout.modelById(id);
  if (existing === null) return;
  cutout.setError(id, null);
  cutout.setNote(id, null);
  let parsed;
  let mesh;
  try {
    parsed = parseStl(await file.arrayBuffer());
    mesh = centredModelMesh(parsed.mesh, existing.unitScale);
  } catch (error) {
    cutout.setError(id, importRejection(file.name, error));
    return;
  }
  const rawBounds = meshBounds(parsed.mesh);
  // Held before the write, for the same reason a fresh upload is: an edit that
  // is never saved must not leave the file behind, and a plan mutation before
  // the save must not take it away.
  queue.protectModel(existing.modelSourceId);
  try {
    await putModel(existing.modelSourceId, file);
  } catch (error) {
    // Nothing was written, so nothing has to be held: the hold is released
    // rather than left standing, which would pin an id no file sits under.
    queue.releaseModel(existing.modelSourceId);
    cutout.setError(id, importRejection(file.name, error));
    return;
  }
  const relinked = relinkCutoutModel(existing, {
    name: file.name,
    triangleCount: parsed.triangleCount,
    sizeMm: {
      x: rawBounds.sizeX * existing.unitScale,
      y: rawBounds.sizeY * existing.unitScale,
      z: rawBounds.sizeZ * existing.unitScale,
    },
  });
  cutout.replaceModel(id, relinked.model);
  cutout.setNote(id, relinked.note);
  cutout.setMissing(id, false);
  cutout.setMesh(id, mesh);
  const failure = await runImportStage(relinked.model);
  if (failure !== null) {
    // The file did not import, so the model is still missing and the user can
    // try another one.
    cutout.setMissing(id, true);
    cutout.setPrepared(id, false);
    cutout.setMesh(id, null);
    cutout.setError(id, importRejection(file.name, failure));
    return;
  }
  // A re-exported file may well have changed units, so the question is asked
  // again on the file that was actually chosen.
  if (relinked.model.unitScale === 1) {
    proposeUnitsFor(id, file.name, rawBounds);
  }
}

// ---------------------------------------------------------------------------
// Fitting the bin to the models
// ---------------------------------------------------------------------------

const fittable = computed(() =>
  cutout.models.flatMap((model) => {
    const bounds = boundsById.value[model.id];
    return bounds === undefined
      ? []
      : [
          {
            bounds,
            clearanceMm: model.clearanceMm,
            sweepEnabled: model.sweepEnabled,
            draftAngleDeg: model.draftAngleDeg,
          },
        ];
  }),
);

/**
 * Grows the bin around the models where they stand. Nothing here happens on its
 * own: a model reaching through a wall is often exactly what the user wants,
 * because that is how a pocket is opened through the side of a bin, so the bin
 * only ever resizes when this button is pressed.
 */
function fitBin(): void {
  const fit = fitBinToModels(fittable.value);
  if (fit === null) return;
  cutout.gridX = fit.gridX;
  cutout.gridY = fit.gridY;
  designer.heightUnits = fit.heightUnits;
}

// ---------------------------------------------------------------------------
// Editing an existing entry
// ---------------------------------------------------------------------------

const editingEntry = computed<QueueEntry | null>(() => {
  if (app.editingKind !== 'cutout' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && binOf(entry.product)?.origin === 'cutout' ? entry : null;
});

/** Reads a model's file back and rebuilds its ghost, or marks it missing. */
async function loadStoredModel(model: CutoutModel): Promise<void> {
  let blob: Blob | null;
  try {
    blob = await getModel(model.modelSourceId);
  } catch (error) {
    cutout.setMissing(model.id, true);
    cutout.setError(model.id, detailOf(error));
    return;
  }
  if (blob === null) {
    cutout.setMissing(model.id, true);
    return;
  }
  try {
    cutout.setMesh(
      model.id,
      centredModelMesh(parseStl(await blob.arrayBuffer()).mesh, model.unitScale),
    );
  } catch (error) {
    // The stored file is there but unreadable, which the user fixes the same
    // way as a missing one: by pointing at the file again.
    cutout.setMissing(model.id, true);
    cutout.setError(model.id, detailOf(error));
    return;
  }
  const failure = await runImportStage(model);
  if (failure !== null) cutout.setError(model.id, failure);
}

/**
 * The designer choice a stored product was ordered as. A cutout bin is never a
 * standalone insert, but the case is answered rather than left out: a product
 * kind added later must not fall silently into one of the others.
 */
function choiceOf(product: Product): ProductChoice {
  switch (product.kind) {
    case 'binWithInsert':
      return 'binWithInsert';
    case 'bin':
      return product.labelSlot ? 'bin' : 'plainBin';
    case 'insert':
      return 'plainBin';
    case 'baseplate':
    case 'clip':
      // Neither ever reaches this tab: their edits route to the Baseplate
      // tab. Answered like the insert case rather than left to a fallthrough.
      return 'plainBin';
    default:
      return assertNever(product);
  }
}

/** Loads a cutout queue entry into the tab for editing. */
function loadEntry(bin: CutoutBin, entry: QueueEntry): void {
  // Opening a second bin without saving the first leaves the first bin's models
  // held by nothing; letting go of them here is what keeps an abandoned design
  // from pinning its files in storage for the rest of the session.
  releaseHeldModels();
  cutout.reset();
  cutout.gridX = bin.gridX;
  cutout.gridY = bin.gridY;
  // setEdits also marks every loaded edit known good: they carved cleanly when
  // the bin was saved, so they do not need re-proving.
  cutout.setEdits(bin.edits);
  // A rejection alert from the previous entry does not belong to this one.
  editError.value = null;
  boundsById.value = {};
  const models = JSON.parse(JSON.stringify(bin.models)) as CutoutModel[];
  for (const model of models) {
    cutout.models.push(model);
    cutout.trackLoadedModel(model);
    // Every model the editor holds is protected for as long as it holds it, so
    // an upload made during this edit cannot be swept before the bin is saved.
    queue.protectModel(model.modelSourceId);
    void loadStoredModel(model);
  }
  // The abandoned design's solids lose their editor reference here exactly as
  // its files did above; whatever the queue still orders stays cached.
  queue.retainCutoutWorkerCache();
  const content = entry.product.kind === 'binWithInsert' ? entry.product.insert : null;
  designer.$patch({
    productChoice: choiceOf(entry.product),
    fused: entry.product.kind === 'binWithInsert' ? entry.product.fused ?? false : false,
    heightUnits: bin.heightUnits,
    magnetHoles: bin.magnetHoles,
    labelText: content?.text ?? '',
    labelText2: content?.text2 ?? '',
    labelIcon: content?.icon ?? null,
    notes: entry.notes ?? '',
  });
  quantity.value = entry.quantity;
}

// The watch source is null unless this tab owns the edit, so the cutout tab
// never loads another origin's entry by construction.
watch(
  () => (app.editingKind === 'cutout' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null) return;
    const bin = binOf(entry.product);
    if (bin === null || bin.origin !== 'cutout') return;
    loadEntry(bin, entry);
  },
  { immediate: true },
);

// Ctrl+N asks for a new bin. It reaches this tab only when no edit is running,
// exactly as it does on the manual tab.
watch(
  () => app.focusAddSeq,
  () => {
    if (app.editingEntryId === null) resetTab();
  },
);

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Why the bin cannot be queued right now, or null when it can. A cutout bin
 * with no models is the one state that is refused outright: it carves nothing,
 * so it would print as a solid brick.
 */
const submitBlocker = computed<string | null>(() =>
  cutout.models.length === 0
    ? 'Add at least one model before adding the bin to the queue.'
    : null,
);

/** Lets go of every model file this editor was holding for the sweep. */
function releaseHeldModels(): void {
  for (const model of cutout.models) queue.releaseModel(model.modelSourceId);
}

function resetTab(): void {
  releaseHeldModels();
  cutout.reset();
  boundsById.value = {};
  uploadErrors.value = [];
  carved.value = null;
  quantity.value = 1;
  designer.labelText = '';
  designer.labelText2 = '';
  designer.labelIcon = null;
  designer.notes = '';
  // Solids only this editor was naming are unreferenced now; the ones queued
  // bins still order stay cached, so re-opening a queue entry repeats no import.
  queue.retainCutoutWorkerCache();
  // Files an abandoned design uploaded are unreferenced now; the sweep is what
  // collects them, and it runs off a plan change.
  void queue.sweepStoredAssets();
}

/** The product this tab currently designs. */
function designedProduct(): Product {
  const bin: CutoutBin = {
    origin: 'cutout',
    gridX: cutout.gridX,
    gridY: cutout.gridY,
    heightUnits: designer.heightUnits,
    magnetHoles: designer.magnetHoles,
    models: JSON.parse(JSON.stringify(cutout.models)) as CutoutModel[],
    edits: cutout.edits.map(cloneEdit),
  };
  const params = binParams.value;
  if (params.fusedLabel != null) {
    return { kind: 'binWithInsert', bin, insert: params.fusedLabel, fused: true };
  }
  if (params.insert !== null) {
    return { kind: 'binWithInsert', bin, insert: params.insert };
  }
  return { kind: 'bin', bin, labelSlot: params.labelSlot };
}

// The queue's refusal of an invalid design, shown beside the save button.
const saveError = ref<string | null>(null);

function saveEntry(): void {
  if (submitBlocker.value !== null) return;
  const cleanNotes = notes.value.trim();
  const product = designedProduct();
  const entry = editingEntry.value;
  // The model files are already in IndexedDB and still held, so the queue
  // mutation below (which sweeps) finds every one of them referenced.
  if (entry !== null) {
    saveError.value = queue.update(entry.id, {
      product,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    if (saveError.value !== null) return;
    app.stopEditing();
  } else {
    saveError.value = queue.add(product, quantity.value, cleanNotes);
    if (saveError.value !== null) return;
  }
  resetTab();
}

function cancelEdit(): void {
  app.stopEditing();
  resetTab();
}

function editingTitle(entry: QueueEntry): string {
  return describeProduct(entry.product).title;
}
</script>

<template>
  <v-row>
    <v-col cols="12" md="7">
      <PaintToolbar
        v-model:shortcut-help-open="shortcutHelpOpen"
        :session="cutout"
        :extra-shortcut-rows="extraShortcutRows"
        class="mb-2"
      >
        <v-btn
          icon
          size="small"
          variant="text"
          :disabled="cutout.edits.length === 0"
          @click="clearEditsDialogOpen = true"
        >
          <v-icon icon="mdi-delete" size="20" />
          <v-tooltip activator="parent" location="bottom">Clear all edits.</v-tooltip>
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          :color="modelsHiddenButton ? 'primary' : undefined"
          @click="modelsHiddenButton = !modelsHiddenButton"
        >
          <v-icon :icon="modelsHiddenButton ? 'mdi-eye-off' : 'mdi-eye'" size="20" />
          <v-tooltip activator="parent" location="bottom">
            Hide the model ghosts. Holding Tab does the same while held.
          </v-tooltip>
        </v-btn>
      </PaintToolbar>

      <v-dialog v-model="clearEditsDialogOpen" max-width="480">
        <v-card>
          <v-card-title>Clear all edits</v-card-title>
          <v-card-text>
            Remove all manual cavity edits from this bin? The models and their pockets are kept.
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="clearEditsDialogOpen = false">Cancel</v-btn>
            <v-btn color="error" variant="flat" @click="onConfirmClearEdits">
              Remove all edits
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-card variant="outlined" class="viewport-card">
        <CutoutViewport
          :meshes="carved?.meshes ?? null"
          :ghosts="ghosts"
          :selected-model-id="cutout.selectedModelId"
          :warned-model-ids="warnedModelIds"
          :paint-tool="cutout.activeTool"
          :brush-radius-mm="cutout.brushRadiusMm"
          :flatten-height-mm="cutout.flattenHeightMm"
          :can-undo="cutout.edits.length > 0"
          :can-redo="cutout.redoStack.length > 0"
          :models-hidden-button="modelsHiddenButton"
          @update:selected-model-id="cutout.select($event)"
          @placement-change="onPlacementChange"
          @placement-commit="onPlacementCommit"
          @bounds-change="onBoundsChange"
          @stroke-commit="onStrokeCommit"
          @flatten-commit="onFlattenCommit"
          @set-tool="onSetTool"
          @step-brush-radius="onStepBrushRadius"
          @undo="cutout.undoEdit()"
          @redo="cutout.redoEdit()"
          @toggle-shortcut-help="shortcutHelpOpen = !shortcutHelpOpen"
        />
      </v-card>

      <!--
        The chip and the status sentence share a line and the progress bar takes
        one of its own. A full width bar on the same line squeezes the chip,
        which then truncates its own label and runs under the sentence.
      -->
      <div class="mt-2">
        <div class="d-flex align-center ga-2">
          <v-chip v-if="stale" size="small" color="warning" label class="flex-shrink-0">
            Out of date
          </v-chip>
          <span v-if="generating" class="text-caption text-medium-emphasis">
            Carving the bin.
          </span>
        </div>
        <CarveProgressBar v-if="generating" class="mt-1" />
      </div>

      <div class="text-caption text-medium-emphasis mb-1 mt-4">
        Bin size (grid units of 42 mm; height units of 7 mm)
      </div>
      <div class="d-flex align-center ga-2">
        <v-text-field
          v-model.number="gridX"
          type="number"
          min="1"
          step="1"
          label="Width"
          density="comfortable"
          hide-details
        />
        <span class="text-medium-emphasis">x</span>
        <v-text-field
          v-model.number="gridY"
          type="number"
          min="1"
          step="1"
          label="Depth"
          density="comfortable"
          hide-details
        />
        <span class="text-medium-emphasis">x</span>
        <v-text-field
          v-model.number="heightUnits"
          type="number"
          :min="MIN_HEIGHT_UNITS"
          step="0.5"
          label="Height"
          density="comfortable"
          hide-details
        />
      </div>
      <div v-if="heightMm !== null" class="text-caption text-medium-emphasis mt-1">
        {{ heightMm }} mm overall
      </div>
      <v-btn
        variant="outlined"
        size="small"
        class="mt-2"
        prepend-icon="mdi-arrow-expand-all"
        :disabled="fittable.length === 0"
        @click="fitBin"
      >
        Fit bin to models
      </v-btn>
      <div class="text-caption text-medium-emphasis mt-1">
        The bin is only resized when you press this button, so a model can be
        left reaching through a wall on purpose.
      </div>

      <ProductSelect v-model="productChoice" v-model:fused="fused" hide-insert-only class="mt-4" />
      <LabelIconField v-if="hasLabel" v-model:text="labelText" v-model:icon="labelIcon" class="mt-4" />

      <MoreOptions
        per-bin-fields
        :quantity="quantity"
        @update:quantity="quantity = $event"
      />

      <v-alert v-if="uploadErrors.length > 0" type="error" class="mt-4" density="compact">
        <p v-for="failure in uploadErrors" :key="failure" class="mb-1">{{ failure }}</p>
      </v-alert>
      <v-alert
        v-if="previewRefusal || errorMessage"
        type="error"
        class="mt-4"
        density="compact"
      >
        {{ previewRefusal ?? errorMessage }}
      </v-alert>
      <v-alert v-if="editError" type="error" class="mt-4" density="compact">
        {{ editError }}
      </v-alert>
      <div class="d-flex ga-2 mt-4">
        <v-btn
          color="primary"
          variant="flat"
          size="large"
          class="flex-grow-1"
          :disabled="submitBlocker !== null"
          @click="saveEntry"
        >
          {{ editingEntry !== null ? 'Save changes' : 'Add to queue' }}
        </v-btn>
        <v-btn v-if="editingEntry !== null" variant="outlined" size="large" @click="cancelEdit">
          Cancel edit
        </v-btn>
      </div>
      <div v-if="submitBlocker" class="text-caption text-medium-emphasis mt-2">
        {{ submitBlocker }}
      </div>
      <v-alert v-if="saveError" type="error" density="compact" class="mt-2">
        {{ saveError }}
      </v-alert>
      <v-alert
        v-if="editingEntry !== null"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        Editing "{{ editingTitle(editingEntry) }}"; saving updates the queue row.
      </v-alert>
    </v-col>

    <v-col cols="12" md="5">
      <ModelList
        :max-clearance-mm="clearanceCeilingMm"
        :clearance-step-mm="CLEARANCE_STEP_MM"
        :warnings-by-id="warningsByModelId"
        @add="onAddFiles"
        @locate="onLocateFile"
        @remove="onRemoveModel"
        @commit-clearance="onCommitClearance"
        @set-sweep="onSetSweep"
        @commit-draft-angle="onCommitDraftAngle"
        @accept-units="onAcceptUnits"
        @keep-units="onKeepUnits"
      />
      <v-divider class="my-4" />
      <ModelReadout
        :model="cutout.selectedModel"
        :bounds="cutout.selectedModelId === null ? null : boundsById[cutout.selectedModelId] ?? null"
        :interior="interior"
        :pocket-size-mm="cutout.selectedModelId === null ? null : pocketSizeById[cutout.selectedModelId] ?? null"
      />
    </v-col>
  </v-row>
</template>

<style scoped>
.viewport-card {
  min-height: 420px;
}
</style>
