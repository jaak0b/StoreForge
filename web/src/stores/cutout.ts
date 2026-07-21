import { defineStore } from 'pinia';
import { computed, markRaw, ref } from 'vue';
import type { MeshData } from '../engine/gridfinity/types';
import type { UnitScaleProposal } from '../engine/cutout/unitScale';
import type { CutoutModel, ModelPlacement } from '../engine/plan/types';
import { createCavityEditSession } from './cavityEditSession';

// The cavity-edit tool type and the edit clone helper live in the shared edit
// session now; re-exported here so the cutout tab keeps importing them from the
// store it already talks to.
export { cloneEdit, type CavityTool } from './cavityEditSession';

/**
 * What the Cutout bin tab is designing: the imported models, where each of them
 * sits, and the bin footprint they are carved into.
 *
 * The tab's state lives here rather than in the component because the add-bin
 * card keeps every tab mounted and a tab switch must not throw away an upload,
 * which cost the user a wait and a Minkowski sum. The height, the magnet holes,
 * the product choice and the label content are deliberately NOT here: those are
 * shared designer state that every tab writes, and they stay in binDesigner
 * where the manual and traced flows already keep them. Only the footprint is
 * duplicated, for the same reason the traced flow duplicates it: this tab sizes
 * the bin from its contents, and that must not reach across and resize whatever
 * the manual tab is designing.
 *
 * Everything in `models` is plan data and is saved verbatim into the queue
 * entry. Everything in `editorState` is not: it is what the editor knows about
 * a model right now (its triangles for the ghost, whether this device has its
 * file, whether its import stage is running) and it is rebuilt from the model
 * store every time a bin is opened. The manual cavity edits are held in the
 * shared edit session, which the traced flow embeds the same way.
 */

/** What the editor knows about one model beyond what the plan stores. */
export interface ModelEditorState {
  /**
   * The model's triangles in the centred millimetre frame the carve places
   * from, for the viewport ghost. Null while the file has not been read, which
   * is both the loading state and the missing state.
   */
  mesh: MeshData | null;
  /** True once this device has been found not to hold the model's file. */
  missing: boolean;
  /**
   * True once the worker holds a prepared solid for the model AT ITS COMMITTED
   * clearance and unit scale, which is what makes it carvable.
   *
   * Deliberately not the same thing as `busy`. A clearance being recomputed
   * leaves the committed clearance alone until the new solid exists, so the
   * model stays carvable throughout and the bin keeps showing its pocket; a
   * model whose scale changed, or that has only just been uploaded, has no
   * solid under its committed key at all and has to drop out of the carve until
   * it does.
   */
  prepared: boolean;
  /** True while this model's import stage runs, which is the one slow step. */
  busy: boolean;
  /** What went wrong with this row's last action, as a user-worded sentence. */
  error: string | null;
  /** A note about this row that does not block anything, such as a re-linked file. */
  note: string | null;
  /** An unanswered question about the model's units, or null. */
  proposal: UnitScaleProposal | null;
  /**
   * The clearance the field currently shows, which is not the committed value:
   * a clearance is committed on blur or Enter, because every committed value is
   * a fresh Minkowski sum and the values typed on the way to 0.45 are not
   * decisions the user made.
   */
  clearanceDraft: number;
  /**
   * The draft angle the field currently shows, committed on blur or Enter for
   * the same reason as the clearance: only a committed value re-carves, so the
   * values typed on the way to the intended angle cost nothing.
   */
  draftAngleDraft: number;
}

function freshState(clearanceMm: number, draftAngleDeg: number): ModelEditorState {
  return {
    mesh: null,
    missing: false,
    prepared: false,
    busy: false,
    error: null,
    note: null,
    proposal: null,
    clearanceDraft: clearanceMm,
    draftAngleDraft: draftAngleDeg,
  };
}

export const useCutout = defineStore('cutout', () => {
  /** The models carved out of the bin, in list order. Plan data. */
  const models = ref<CutoutModel[]>([]);
  /**
   * Which model the gizmo is attached to and the list highlights, or null.
   * One piece of state written by two input paths (a click in the viewport
   * and a click on a row), because a model buried inside the bin cannot be
   * clicked in the viewport at all and the list has to be able to reach it.
   */
  const selectedModelId = ref<string | null>(null);
  /** Bin footprint in grid cells. Height and the rest live in binDesigner. */
  const gridX = ref(1);
  const gridY = ref(1);
  /** Editor-only state per model id. Never saved. */
  const editorState = ref<Record<string, ModelEditorState>>({});

  /** The manual cavity edits and their tool state, shared with the traced flow. */
  const editSession = createCavityEditSession();

  function modelById(id: string): CutoutModel | null {
    return models.value.find((model) => model.id === id) ?? null;
  }
  const selectedModel = computed<CutoutModel | null>(() => {
    if (selectedModelId.value === null) return null;
    return models.value.find((model) => model.id === selectedModelId.value) ?? null;
  });
  /**
   * The editor state of a model, or a blank one for an id the store does not
   * know. Read-only: mutate through the actions, which keep the record and
   * its state together.
   */
  function stateOf(id: string): ModelEditorState {
    return editorState.value[id] ?? freshState(0, 0);
  }
  /**
   * The models that can be carved right now: the ones the worker holds a
   * prepared solid for at their committed clearance and scale. A model still
   * being imported is left out, so the bin keeps carving the models that are
   * ready instead of failing on the one that is not.
   */
  const carvableModels = computed<CutoutModel[]>(() =>
    models.value.filter((model) => {
      const editor = editorState.value[model.id];
      return editor !== undefined && !editor.missing && editor.prepared;
    }),
  );
  /** Clears the tab back to a new, empty cutout bin. */
  function reset(): void {
    models.value = [];
    selectedModelId.value = null;
    gridX.value = 1;
    gridY.value = 1;
    editorState.value = {};
    editSession.resetEditSession();
  }
  function select(id: string | null): void {
    selectedModelId.value = id !== null && modelById(id) !== null ? id : null;
  }
  /**
   * Adds a model to the bin and selects it. The mesh is marked raw: it is
   * megabytes of typed arrays that nothing reacts to, and the viewport
   * compares it by identity to decide whether to rebuild its geometry.
   */
  function addModel(model: CutoutModel, mesh: MeshData | null): void {
    models.value.push(model);
    editorState.value[model.id] = freshState(model.clearanceMm, model.draftAngleDeg);
    if (mesh !== null) editorState.value[model.id].mesh = markRaw(mesh);
    selectedModelId.value = model.id;
  }
  function removeModel(id: string): void {
    models.value = models.value.filter((model) => model.id !== id);
    delete editorState.value[id];
    if (selectedModelId.value === id) selectedModelId.value = null;
  }
  function setPlacement(id: string, placement: ModelPlacement): void {
    const model = modelById(id);
    if (model === null) return;
    model.placement = { ...placement };
  }
  /** Writes a committed clearance, keeping the field in step with it. */
  function setClearance(id: string, clearanceMm: number): void {
    const model = modelById(id);
    if (model === null) return;
    model.clearanceMm = clearanceMm;
    setClearanceDraft(id, clearanceMm);
  }
  function setClearanceDraft(id: string, clearanceMm: number): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.clearanceDraft = clearanceMm;
  }
  /** Turns the upward sweep of one model's pocket on or off. */
  function setSweepEnabled(id: string, sweepEnabled: boolean): void {
    const model = modelById(id);
    if (model !== null) model.sweepEnabled = sweepEnabled;
  }
  /** Writes a committed draft angle, keeping the field in step with it. */
  function setDraftAngle(id: string, draftAngleDeg: number): void {
    const model = modelById(id);
    if (model === null) return;
    model.draftAngleDeg = draftAngleDeg;
    setDraftAngleDraft(id, draftAngleDeg);
  }
  function setDraftAngleDraft(id: string, draftAngleDeg: number): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.draftAngleDraft = draftAngleDeg;
  }
  function setUnitScale(id: string, unitScale: number): void {
    const model = modelById(id);
    if (model !== null) model.unitScale = unitScale;
  }
  /** Applies what an import measured: the file's own facts, never the placement. */
  function applyImportedFacts(
    id: string,
    facts: { triangleCount: number; sizeMm: CutoutModel['sizeMm'] },
  ): void {
    const model = modelById(id);
    if (model === null) return;
    model.triangleCount = facts.triangleCount;
    model.sizeMm = { ...facts.sizeMm };
  }
  function setMesh(id: string, mesh: MeshData | null): void {
    const editor = editorState.value[id];
    if (editor === undefined) return;
    editor.mesh = mesh === null ? null : markRaw(mesh);
  }
  function setMissing(id: string, missing: boolean): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.missing = missing;
  }
  function setPrepared(id: string, prepared: boolean): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.prepared = prepared;
  }
  /**
   * Swaps a model record for an updated one, keeping its place in the list.
   * Used when a located file is linked to a record that was missing its
   * bytes: the record keeps its id, so nothing else has to change.
   */
  function replaceModel(id: string, model: CutoutModel): void {
    const index = models.value.findIndex((entry) => entry.id === id);
    if (index !== -1) models.value[index] = model;
  }
  function setBusy(id: string, busy: boolean): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.busy = busy;
  }
  function setError(id: string, error: string | null): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.error = error;
  }
  function setNote(id: string, note: string | null): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.note = note;
  }
  function setProposal(id: string, proposal: UnitScaleProposal | null): void {
    const editor = editorState.value[id];
    if (editor !== undefined) editor.proposal = proposal;
  }
  /** Rebuilds the editor state of a model loaded back from a plan. */
  function trackLoadedModel(model: CutoutModel): void {
    editorState.value[model.id] = freshState(model.clearanceMm, model.draftAngleDeg);
  }

  return {
    models,
    selectedModelId,
    gridX,
    gridY,
    editorState,
    // The shared cavity-edit session, spread so the tab reads and writes edits
    // (edits, redoStack, activeTool, brushRadiusMm, flattenHeightMm,
    // appendEdit, undoEdit, redoEdit, clearEdits, setEdits, the rollback
    // bookkeeping) straight off the store, exactly as before the extraction.
    ...editSession,
    modelById,
    selectedModel,
    stateOf,
    carvableModels,
    reset,
    select,
    addModel,
    removeModel,
    setPlacement,
    setClearance,
    setClearanceDraft,
    setSweepEnabled,
    setDraftAngle,
    setDraftAngleDraft,
    setUnitScale,
    applyImportedFacts,
    setMesh,
    setMissing,
    setPrepared,
    replaceModel,
    setBusy,
    setError,
    setNote,
    setProposal,
    trackLoadedModel,
  };
});
