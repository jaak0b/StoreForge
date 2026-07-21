import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { MeshData } from '../engine/gridfinity/types';
import {
  CAVITY_EDIT_RADIUS_MAX_MM,
  CAVITY_EDIT_RADIUS_MIN_MM,
  FLATTEN_HEIGHT_MAX_MM,
  FLATTEN_HEIGHT_MIN_MM,
} from '../engine/cutout/cavityEdits';
import type { UnitScaleProposal } from '../engine/cutout/unitScale';
import { assertNever, type CavityEdit, type CutoutModel, type ModelPlacement } from '../engine/plan/types';

/** The active paint tool for cavity edits, or none while the gizmo owns the pointer. */
export type CavityTool = 'add' | 'remove' | 'flatten';

/**
 * Deep copies one cavity edit. Vue's reactive proxies do not survive the
 * worker's structured clone (the same reason the model records are copied
 * on the way to the worker), so every read of `edits` bound for the plan or
 * the worker goes through this. The switch ends in assertNever so a new
 * CavityEdit variant fails to compile here too. Defined once here and
 * reused by the tab, so the copy logic has one home (rule 10).
 */
export function cloneEdit(edit: CavityEdit): CavityEdit {
  switch (edit.kind) {
    case 'add':
    case 'remove':
      return {
        kind: edit.kind,
        points: edit.points.map((point) => ({ ...point })),
        radiusMm: edit.radiusMm,
      };
    case 'flatten':
      return {
        kind: 'flatten',
        centerMm: { ...edit.centerMm },
        radiusMm: edit.radiusMm,
        normalMm: { ...edit.normalMm },
        heightMm: edit.heightMm,
      };
    default:
      return assertNever(edit);
  }
}

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
 * store every time a bin is opened.
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

export const useCutout = defineStore('cutout', {
  state: () => ({
    /** The models carved out of the bin, in list order. Plan data. */
    models: [] as CutoutModel[],
    /**
     * Which model the gizmo is attached to and the list highlights, or null.
     * One piece of state written by two input paths (a click in the viewport
     * and a click on a row), because a model buried inside the bin cannot be
     * clicked in the viewport at all and the list has to be able to reach it.
     */
    selectedModelId: null as string | null,
    /** Bin footprint in grid cells. Height and the rest live in binDesigner. */
    gridX: 1,
    gridY: 1,
    /** Editor-only state per model id. Never saved. */
    editorState: {} as Record<string, ModelEditorState>,
    /** Manual cavity edits, in application order. Plan data. */
    edits: [] as CavityEdit[],
    /** Edits undone and available for redo. Editor state, never saved. */
    redoStack: [] as CavityEdit[],
    /** The active paint tool, or null when the gizmo owns the pointer. Editor state. */
    activeTool: null as CavityTool | null,
    /** Brush radius in mm for the next stroke. Editor state. */
    brushRadiusMm: 3,
    /** Flatten cut height in mm for the next flatten click. Editor state. */
    flattenHeightMm: 5,
  }),
  getters: {
    modelById: (state) => (id: string): CutoutModel | null =>
      state.models.find((model) => model.id === id) ?? null,
    selectedModel(state): CutoutModel | null {
      if (state.selectedModelId === null) return null;
      return state.models.find((model) => model.id === state.selectedModelId) ?? null;
    },
    /**
     * The editor state of a model, or a blank one for an id the store does not
     * know. Read-only: mutate through the actions, which keep the record and
     * its state together.
     */
    stateOf: (state) => (id: string): ModelEditorState =>
      state.editorState[id] ?? freshState(0, 0),
    /**
     * The models that can be carved right now: the ones the worker holds a
     * prepared solid for at their committed clearance and scale. A model still
     * being imported is left out, so the bin keeps carving the models that are
     * ready instead of failing on the one that is not.
     */
    carvableModels(state): CutoutModel[] {
      return state.models.filter((model) => {
        const editor = state.editorState[model.id];
        return editor !== undefined && !editor.missing && editor.prepared;
      });
    },
    /** True when this device is missing the file of at least one model. */
    hasMissingModel(state): boolean {
      return state.models.some((model) => state.editorState[model.id]?.missing === true);
    },
  },
  actions: {
    /** Clears the tab back to a new, empty cutout bin. */
    reset() {
      this.models = [];
      this.selectedModelId = null;
      this.gridX = 1;
      this.gridY = 1;
      this.editorState = {};
      this.edits = [];
      this.redoStack = [];
      this.activeTool = null;
      this.brushRadiusMm = 3;
      this.flattenHeightMm = 5;
    },
    select(id: string | null) {
      this.selectedModelId = id !== null && this.modelById(id) !== null ? id : null;
    },
    /**
     * Adds a model to the bin and selects it. The mesh is marked raw: it is
     * megabytes of typed arrays that nothing reacts to, and the viewport
     * compares it by identity to decide whether to rebuild its geometry.
     */
    addModel(model: CutoutModel, mesh: MeshData | null) {
      this.models.push(model);
      this.editorState[model.id] = freshState(model.clearanceMm, model.draftAngleDeg);
      if (mesh !== null) this.editorState[model.id].mesh = markRaw(mesh);
      this.selectedModelId = model.id;
    },
    removeModel(id: string) {
      this.models = this.models.filter((model) => model.id !== id);
      delete this.editorState[id];
      if (this.selectedModelId === id) this.selectedModelId = null;
    },
    setPlacement(id: string, placement: ModelPlacement) {
      const model = this.modelById(id);
      if (model === null) return;
      model.placement = { ...placement };
    },
    /** Writes a committed clearance, keeping the field in step with it. */
    setClearance(id: string, clearanceMm: number) {
      const model = this.modelById(id);
      if (model === null) return;
      model.clearanceMm = clearanceMm;
      this.setClearanceDraft(id, clearanceMm);
    },
    setClearanceDraft(id: string, clearanceMm: number) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.clearanceDraft = clearanceMm;
    },
    /** Turns the upward sweep of one model's pocket on or off. */
    setSweepEnabled(id: string, sweepEnabled: boolean) {
      const model = this.modelById(id);
      if (model !== null) model.sweepEnabled = sweepEnabled;
    },
    /** Writes a committed draft angle, keeping the field in step with it. */
    setDraftAngle(id: string, draftAngleDeg: number) {
      const model = this.modelById(id);
      if (model === null) return;
      model.draftAngleDeg = draftAngleDeg;
      this.setDraftAngleDraft(id, draftAngleDeg);
    },
    setDraftAngleDraft(id: string, draftAngleDeg: number) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.draftAngleDraft = draftAngleDeg;
    },
    setUnitScale(id: string, unitScale: number) {
      const model = this.modelById(id);
      if (model !== null) model.unitScale = unitScale;
    },
    /** Applies what an import measured: the file's own facts, never the placement. */
    applyImportedFacts(
      id: string,
      facts: { triangleCount: number; sizeMm: CutoutModel['sizeMm'] },
    ) {
      const model = this.modelById(id);
      if (model === null) return;
      model.triangleCount = facts.triangleCount;
      model.sizeMm = { ...facts.sizeMm };
    },
    setMesh(id: string, mesh: MeshData | null) {
      const editor = this.editorState[id];
      if (editor === undefined) return;
      editor.mesh = mesh === null ? null : markRaw(mesh);
    },
    setMissing(id: string, missing: boolean) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.missing = missing;
    },
    setPrepared(id: string, prepared: boolean) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.prepared = prepared;
    },
    /**
     * Swaps a model record for an updated one, keeping its place in the list.
     * Used when a located file is linked to a record that was missing its
     * bytes: the record keeps its id, so nothing else has to change.
     */
    replaceModel(id: string, model: CutoutModel) {
      const index = this.models.findIndex((entry) => entry.id === id);
      if (index !== -1) this.models[index] = model;
    },
    setBusy(id: string, busy: boolean) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.busy = busy;
    },
    setError(id: string, error: string | null) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.error = error;
    },
    setNote(id: string, note: string | null) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.note = note;
    },
    setProposal(id: string, proposal: UnitScaleProposal | null) {
      const editor = this.editorState[id];
      if (editor !== undefined) editor.proposal = proposal;
    },
    /** Rebuilds the editor state of a model loaded back from a plan. */
    trackLoadedModel(model: CutoutModel) {
      this.editorState[model.id] = freshState(model.clearanceMm, model.draftAngleDeg);
    },
    /** Toggling the active tool off passes null. */
    setActiveTool(tool: CavityTool | null) {
      this.activeTool = tool;
    },
    /** Clamped to the shared cavity edit radius bounds. */
    setBrushRadius(radiusMm: number) {
      this.brushRadiusMm = Math.min(
        CAVITY_EDIT_RADIUS_MAX_MM,
        Math.max(CAVITY_EDIT_RADIUS_MIN_MM, radiusMm),
      );
    },
    /** Clamped to the shared flatten cut height bounds. */
    setFlattenHeight(heightMm: number) {
      this.flattenHeightMm = Math.min(
        FLATTEN_HEIGHT_MAX_MM,
        Math.max(FLATTEN_HEIGHT_MIN_MM, heightMm),
      );
    },
    /** Pushes a completed edit and clears the redo stack. */
    appendEdit(edit: CavityEdit) {
      this.edits.push(cloneEdit(edit));
      this.redoStack = [];
    },
    /** Pops the last edit WITHOUT pushing redo: a rejected carve. */
    rollbackEdit() {
      this.edits.pop();
    },
    /** Moves the last edit onto the redo stack. */
    undoEdit() {
      const edit = this.edits.pop();
      if (edit !== undefined) this.redoStack.push(edit);
    },
    /** Moves the last undone edit back onto the list. */
    redoEdit() {
      const edit = this.redoStack.pop();
      if (edit !== undefined) this.edits.push(edit);
    },
    /** Empties the edit list and the redo stack. */
    clearEdits() {
      this.edits = [];
      this.redoStack = [];
    },
    /** Loads an edit list from a plan: deep copies, clears the redo stack. */
    setEdits(edits: CavityEdit[]) {
      this.edits = edits.map(cloneEdit);
      this.redoStack = [];
    },
  },
});
