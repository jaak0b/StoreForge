import { ref } from 'vue';
import {
  CAVITY_EDIT_RADIUS_MAX_MM,
  CAVITY_EDIT_RADIUS_MIN_MM,
  FLATTEN_HEIGHT_MAX_MM,
  FLATTEN_HEIGHT_MIN_MM,
  isCavityEditRejectionMessage,
} from '../engine/carve/cavityEdits';
import {
  cavityEditRollbackCount,
  clampLastGoodEditCount,
} from '../engine/carve/cavityEditRollback';
import { assertNever, type CavityEdit } from '../engine/plan/types';

/** The active paint tool for cavity edits, or none while the gizmo owns the pointer. */
export type CavityTool = 'add' | 'remove' | 'flatten';

/**
 * Deep copies one cavity edit. Vue's reactive proxies do not survive the
 * worker's structured clone (the same reason the model records are copied
 * on the way to the worker), so every read of `edits` bound for the plan or
 * the worker goes through this. The switch ends in assertNever so a new
 * CavityEdit variant fails to compile here too. Defined once here, the single
 * home for cavity-edit copy logic, and reused by both carve flows (rule 10).
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

/** The default brush radius in mm a fresh edit session starts on. */
const DEFAULT_BRUSH_RADIUS_MM = 3;
/** The default flatten cut height in mm a fresh edit session starts on. */
const DEFAULT_FLATTEN_HEIGHT_MM = 5;

export type CavityEditSession = ReturnType<typeof createCavityEditSession>;

/**
 * The cavity-edit state shared by every carved-interior bin flow: the edit
 * list, its redo stack, the active paint tool, the brush and flatten settings,
 * and the last-known-good rollback bookkeeping that decides how far a rejected
 * carve unwinds. Extracted from the cutout store so the traced flow embeds the
 * same behaviour rather than re-implementing it (rule 10).
 *
 * Framework state only, held in Vue refs so it can be spread straight into a
 * Pinia setup store. Each store creates its own instance, so the cutout tab and
 * the tool-trace tab keep independent edit lists and independent brush settings.
 */
export function createCavityEditSession() {
  /** Cavity edits, in application order. Plan data. */
  const edits = ref<CavityEdit[]>([]);
  /** Edits undone and available for redo. Editor state, never saved. */
  const redoStack = ref<CavityEdit[]>([]);
  /** The active paint tool, or null when the gizmo owns the pointer. Editor state. */
  const activeTool = ref<CavityTool | null>(null);
  /** Brush radius in mm for the next stroke. Editor state. */
  const brushRadiusMm = ref(DEFAULT_BRUSH_RADIUS_MM);
  /** Flatten cut height in mm for the next flatten click. Editor state. */
  const flattenHeightMm = ref(DEFAULT_FLATTEN_HEIGHT_MM);
  /**
   * The number of edits the most recently LANDED successful carve was built
   * from. Every edit at or below this count is known good: some carve has
   * folded it in without failing. Not a running maximum: it is reassigned on
   * every landed carve, because a running maximum only ever grows, so undoing
   * an edit and then painting a bad one could leave the live edit count back at
   * an old high-water mark and the rejection rollback would never fire. Reset
   * to the loaded length whenever the edit list is replaced wholesale (loading
   * an entry) and to 0 when the edits are cleared.
   */
  const lastGoodEditCount = ref(0);

  /** Toggling the active tool off passes null. */
  function setActiveTool(tool: CavityTool | null): void {
    activeTool.value = tool;
  }
  /** Clamped to the shared cavity edit radius bounds. */
  function setBrushRadius(radiusMm: number): void {
    brushRadiusMm.value = Math.min(
      CAVITY_EDIT_RADIUS_MAX_MM,
      Math.max(CAVITY_EDIT_RADIUS_MIN_MM, radiusMm),
    );
  }
  /** Clamped to the shared flatten cut height bounds. */
  function setFlattenHeight(heightMm: number): void {
    flattenHeightMm.value = Math.min(
      FLATTEN_HEIGHT_MAX_MM,
      Math.max(FLATTEN_HEIGHT_MIN_MM, heightMm),
    );
  }
  /** Pushes a completed edit and clears the redo stack. */
  function appendEdit(edit: CavityEdit): void {
    edits.value.push(cloneEdit(edit));
    redoStack.value = [];
  }
  /** Pops the last edit WITHOUT pushing redo: a rejected carve. */
  function popLastEditForRejection(): void {
    edits.value.pop();
  }
  /** Moves the last edit onto the redo stack. */
  function undoEdit(): void {
    const edit = edits.value.pop();
    if (edit !== undefined) redoStack.value.push(edit);
  }
  /** Moves the last undone edit back onto the list. */
  function redoEdit(): void {
    const edit = redoStack.value.pop();
    if (edit !== undefined) edits.value.push(edit);
  }
  /** Empties the edit list and the redo stack, and forgets the known-good count. */
  function clearEdits(): void {
    edits.value = [];
    redoStack.value = [];
    lastGoodEditCount.value = 0;
  }
  /**
   * Loads an edit list from a plan: deep copies, clears the redo stack, and
   * marks every loaded edit known good (a saved bin's edits carved cleanly when
   * it was saved, so they never need re-proving).
   */
  function setEdits(list: CavityEdit[]): void {
    edits.value = list.map(cloneEdit);
    redoStack.value = [];
    lastGoodEditCount.value = edits.value.length;
  }

  /**
   * Records that a carve of `landedEditCount` edits landed successfully, so
   * every edit at or below it is now known good. Clamped to the live edit list
   * because an undo performed while the carve was in flight can shrink the list
   * below the count the carve was built from, and treating that stale, too-high
   * count as known good would make a later rejection under-roll-back.
   */
  function noteLandedCarve(landedEditCount: number): void {
    lastGoodEditCount.value = clampLastGoodEditCount(landedEditCount, edits.value.length);
  }
  /**
   * Given the message of a finished carve, rolls back the edits a rejection
   * blames and returns that message; returns null when the message is not an
   * edit rejection and nothing was rolled back. Every edit above the last
   * known-good count is suspect, not just the most recently painted one: the
   * debounce can coalesce two edits into one carve, or a second edit can be
   * painted while an earlier carve is still in flight, so a single rejection
   * means none of those edits are proven and all of them unwind together. Only
   * an edit rejection rolls edits back; any other failure (a missing model
   * file, divider walls on a carved bin) is not the edit's fault and leaves the
   * list alone.
   */
  function rollbackRejectedEdits(message: string | null): string | null {
    if (message === null || !isCavityEditRejectionMessage(message)) return null;
    let toRollBack = cavityEditRollbackCount(edits.value.length, lastGoodEditCount.value);
    while (toRollBack-- > 0) popLastEditForRejection();
    return message;
  }
  /** Clears the session back to a fresh, empty state. */
  function resetEditSession(): void {
    edits.value = [];
    redoStack.value = [];
    activeTool.value = null;
    brushRadiusMm.value = DEFAULT_BRUSH_RADIUS_MM;
    flattenHeightMm.value = DEFAULT_FLATTEN_HEIGHT_MM;
    lastGoodEditCount.value = 0;
  }

  return {
    edits,
    redoStack,
    activeTool,
    brushRadiusMm,
    flattenHeightMm,
    lastGoodEditCount,
    setActiveTool,
    setBrushRadius,
    setFlattenHeight,
    appendEdit,
    popLastEditForRejection,
    undoEdit,
    redoEdit,
    clearEdits,
    setEdits,
    noteLandedCarve,
    rollbackRejectedEdits,
    resetEditSession,
  };
}
