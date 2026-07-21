import { ref, watch, type Ref } from 'vue';
import { assertNever, type CavityEdit, type Vec3Mm } from '../engine/plan/types';
import type { CavityTool } from '../stores/cavityEditSession';

/**
 * A carve preview result carrying the edit count it was built from, tagged by
 * outcome. `Meta` is the flow-specific payload the carved variant adds (the
 * cutout carve travels with its model ids and footprints; the pocket carve just
 * its meshes), so both flows describe their result as one closed union the
 * landing switch below can exhaust. The edit count rides with the result rather
 * than in shared state because a newer request can have changed the live edit
 * list by the time an older result lands.
 */
export type CavityCarveOutcome<Meta extends object> =
  | ({ outcome: 'carved'; editCount: number } & Meta)
  | { outcome: 'superseded'; editCount: number };

/**
 * The subset of a cavity edit session this composable drives. Both the cutout
 * store and the tool-trace store spread a `createCavityEditSession()` instance,
 * so each structurally satisfies this and can be passed straight in. Reading
 * `activeTool` off the reactive store keeps the active-tool watch live.
 */
export interface CavityEditControls {
  activeTool: CavityTool | null;
  brushRadiusMm: number;
  flattenHeightMm: number;
  appendEdit(edit: CavityEdit): void;
  noteLandedCarve(landedEditCount: number): void;
  rollbackRejectedEdits(message: string | null): string | null;
}

/**
 * The preview refs this composable observes, exactly as `useBinPreview` returns
 * them.
 */
export interface CavityEditPreviewRefs<Meta extends object> {
  generating: Ref<boolean>;
  errorMessage: Ref<string | null>;
  previewResult: Ref<CavityCarveOutcome<Meta> | null>;
}

/**
 * The flow-specific hooks the two carve flows still own: what to do with a
 * carve that landed (draw it, and in the cutout flow drop the out-of-date flag),
 * and what to do when a carve finished with an error (clear the last drawn bin
 * so the viewport never keeps stale geometry the user can go on painting).
 */
export interface CavityEditPreviewHooks<Meta extends object> {
  onCarved(result: { outcome: 'carved'; editCount: number } & Meta): void;
  onCarveFailed(): void;
}

/**
 * The session-to-preview wiring shared by every carved-interior bin flow (the
 * cutout tab and the traced pocket workspace), extracted so neither hand-writes
 * it (rule 10). It owns:
 *
 * - the landing switch: a carve that reaches the worker proves every edit it was
 *   built from, so `noteLandedCarve` records the landed count (clamped inside
 *   the session to the live list in case an undo shrank it), and the carved
 *   result is handed to the flow's own `onCarved`;
 * - the rejection rollback: when a carve finishes with an edit rejection, the
 *   suspect edits unwind together and the message surfaces on `editError`. Any
 *   other failure is not the edit's fault and leaves the edit list alone. Either
 *   way a finished-with-error carve clears the drawn bin through `onCarveFailed`;
 * - clearing `editError` when the active tool changes;
 * - building add/remove/flatten edits from the session on a committed gesture.
 *
 * The flow-specific parts stay with the caller: the cutout tab's out-of-date
 * flag and model-id wrapping and its missing-file refusal watch compose through
 * the hooks and the result `Meta` without being duplicated here.
 */
export function useCavityEditPreview<Meta extends object>(
  session: CavityEditControls,
  preview: CavityEditPreviewRefs<Meta>,
  hooks: CavityEditPreviewHooks<Meta>,
): {
  editError: Ref<string | null>;
  onStrokeCommit: (points: Vec3Mm[]) => void;
  onFlattenCommit: (centerMm: Vec3Mm, normalMm: Vec3Mm) => void;
} {
  /** The error a rejected edit surfaced, shown as its own alert row. */
  const editError = ref<string | null>(null);

  watch(preview.previewResult, (result) => {
    if (result === null) return;
    switch (result.outcome) {
      case 'carved':
        // This carve reached the worker and produced a bin, so every edit it was
        // built from is known good. Recorded directly, not folded into a running
        // maximum, because useBinPreview only lands the latest ticket's outcome,
        // so this always is the most recent landed carve. An undo can still
        // shrink the live edit list below the count this carve was built from
        // before its result arrives, so noteLandedCarve clamps to the live
        // length: nothing above it could be rolled back anyway.
        session.noteLandedCarve(result.editCount);
        hooks.onCarved(result);
        return;
      case 'superseded':
        // A newer request replaced this one before it finished. Not a failure,
        // and not something to draw: the newer carve is the one being waited for.
        return;
      default:
        return assertNever(result);
    }
  });

  // A manual edit that makes the carve fail must not stay applied: it would sit
  // in the undo stack looking like a normal edit while the bin it produced is
  // gone. Every edit above the last known-good count is suspect, not just the
  // one most recently appended: the debounce can coalesce two edits into one
  // carve, or a second edit can be painted while an earlier carve is still in
  // flight, and either way a single failure means none of those edits are
  // proven. All of them are rolled back together, down to the last count that
  // did carve successfully.
  //
  // Only an edit rejection (the carve reached the worker and the folded edits
  // themselves were bad) rolls edits back. Any other failure (a missing model
  // file, divider walls, an oversized layout) is not the edit's fault, so it is
  // surfaced without touching the edit list. Either way a carve that finished
  // with an error is not showing a valid bin, so the drawn geometry is cleared.
  watch(preview.generating, (isGenerating) => {
    if (isGenerating) return;
    const rolledBack = session.rollbackRejectedEdits(preview.errorMessage.value);
    if (rolledBack !== null) editError.value = rolledBack;
    if (preview.errorMessage.value !== null) hooks.onCarveFailed();
  });

  watch(
    () => session.activeTool,
    () => {
      editError.value = null;
    },
  );

  /**
   * Fires a paint stroke's add or remove edit. Ignored when the tool changed
   * between the gesture starting and ending, which the viewport itself should
   * not allow, but is checked here too since this is where the edit is appended.
   */
  function onStrokeCommit(points: Vec3Mm[]): void {
    if (session.activeTool !== 'add' && session.activeTool !== 'remove') return;
    editError.value = null;
    session.appendEdit({ kind: session.activeTool, points, radiusMm: session.brushRadiusMm });
  }

  /** Fires a flatten click's edit. */
  function onFlattenCommit(centerMm: Vec3Mm, normalMm: Vec3Mm): void {
    if (session.activeTool !== 'flatten') return;
    editError.value = null;
    session.appendEdit({
      kind: 'flatten',
      centerMm,
      radiusMm: session.brushRadiusMm,
      normalMm,
      heightMm: session.flattenHeightMm,
    });
  }

  return { editError, onStrokeCommit, onFlattenCommit };
}
