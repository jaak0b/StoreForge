// Rollback bookkeeping for manual cavity edits, shared by every carved-bin
// editor (the cutout and traced pocket flows). A
// carve that reaches the worker and comes back as an edit rejection means
// every edit above the last carve that actually landed successfully is
// suspect, not just the most recently painted one, and all of them are
// popped back off together. Framework-agnostic and pure so the threshold
// logic can be tested without Pinia or the worker.

/**
 * How many edits must be popped off the live edit list to fall back to the
 * last known-good count. `currentLength` is the live edit list length;
 * `lastGoodEditCount` is the edit count of the most recently LANDED
 * successful carve, not a running maximum: a running maximum only ever grows,
 * so an undo followed by a bad edit can leave the live length back at the
 * high-water mark and the rejection loop would never fire, leaving the bad
 * edit stuck. Returns 0 when nothing needs rolling back.
 */
export function cavityEditRollbackCount(
  currentLength: number,
  lastGoodEditCount: number,
): number {
  return Math.max(0, currentLength - lastGoodEditCount);
}

/**
 * Clamps a landed carve's edit count to never exceed the live edit list: an
 * undo performed while that carve was still in flight can shrink the edit
 * list below the count the carve was built from before its result lands, and
 * treating that stale, too-high count as "known good" would let a later
 * rejection loop under-roll-back. The live length is always a safe ceiling,
 * because nothing above it can be rolled back anyway.
 */
export function clampLastGoodEditCount(landedEditCount: number, currentLength: number): number {
  return Math.min(landedEditCount, currentLength);
}
