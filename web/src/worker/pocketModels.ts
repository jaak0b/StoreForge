/**
 * How a pocket-bin carve crosses the worker boundary, mirroring cutoutModels
 * for the traced pocket flow.
 *
 * Unlike a cutout carve, a pocket carve names no external model solids: its
 * tools are plain outline data that travel inside the request itself, so there
 * is no prepared-model cache, no swept cache and no pin ledger here. What the
 * two flows share is the manual cavity edits folded onto the carved body, and
 * with them the edited-body memo and its recipe key, which live flow-neutral in
 * cavityEditedBodyCache and are reused rather than restated (rule 10).
 */
import { carveRecipeKey } from './cavityEditedBodyCache';
import type { PartMeshes, SlottedBinParams } from '../engine/gridfinity/types';
import type { ToolPlacement, TracedTool } from '../engine/trace/types';
import type { CavityEdit } from '../engine/plan/types';

/**
 * A pocket bin as a worker request describes it: the ordinary slotted bin
 * parameters plus the tools and placements whose pockets are sunk into its
 * interior, and the manual cavity edits folded on afterward. The serializable
 * shape that crosses Comlink: it deliberately omits the editedMemo and
 * editedRecipeKey of PocketBinParams, which are the worker's own and cannot
 * cross a thread boundary, exactly as CutoutBinRequest omits them.
 */
export interface PocketBinRequest extends SlottedBinParams {
  tools: TracedTool[];
  placements: ToolPlacement[];
  /** Manual cavity edits, in application order. Empty means none. */
  edits: CavityEdit[];
}

/**
 * A pocket-bin preview carve as it crosses back, or the fact that a newer
 * request replaced this one before it finished.
 *
 * Supersession is returned as a value rather than thrown for the same reason
 * the cutout preview returns it: an error does not survive the structured clone
 * that carries it across the worker boundary with its identity intact, so a
 * superseded preview would otherwise be indistinguishable from a genuine
 * failure. A superseded preview is not a failure and must never reach the user
 * as one.
 */
export type PocketPreviewResult =
  | { outcome: 'carved'; meshes: PartMeshes }
  | { outcome: 'superseded' };

/**
 * Deterministic identity of a pocket carve recipe without its edits, for the
 * edited-body memo: the bin's own envelope fields plus its tools and
 * placements (which carry each pocket's draft angle). Edits are excluded by
 * construction, which is what lets appending one edit reuse the previous
 * carve's edited body instead of missing on every keystroke of a stroke. The
 * same pattern cutoutCarveRecipeKey follows, through the same shared
 * carveRecipeKey so the exclude-edits invariant lives in one place.
 */
export function pocketCarveRecipeKey(request: PocketBinRequest): string {
  const { tools, placements, edits: _edits, ...bin } = request;
  return carveRecipeKey({ bin, tools, placements });
}
