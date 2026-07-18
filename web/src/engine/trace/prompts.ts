// Partitioning of segmentation click prompts for single-object SAM decoding.
// SAM's point prompts describe one object per decode, so a multi-tool click
// set is split into one prompt group per include click; each exclude click
// joins the group of its nearest include click (plain Euclidean distance in
// rectified-image pixels). The decode orchestration in the vision worker
// consumes these groups one decode at a time.
import type { SamPoint } from './types';

/** One decode prompt: a single include click plus its assigned excludes. */
export interface PromptGroup {
  /** The include click (label 1) this decode describes. */
  include: SamPoint;
  /** Exclude clicks (label 0) whose nearest include click is this group's. */
  excludes: SamPoint[];
}

/**
 * Split a mixed click set into one prompt group per include click. Each
 * exclude click is assigned to the group of the include click nearest to it
 * (ties go to the earlier include click). Returns an empty array when the
 * set holds no include click; exclude clicks alone cannot select a shape.
 */
export function partitionClicks(points: SamPoint[]): PromptGroup[] {
  const groups: PromptGroup[] = points
    .filter((point) => point.label === 1)
    .map((include) => ({ include, excludes: [] }));
  if (groups.length === 0) {
    return [];
  }
  for (const point of points) {
    if (point.label !== 0) continue;
    let best = groups[0];
    let bestDistance = Infinity;
    for (const group of groups) {
      const distance = Math.hypot(
        group.include.x - point.x,
        group.include.y - point.y,
      );
      if (distance < bestDistance) {
        best = group;
        bestDistance = distance;
      }
    }
    best.excludes.push(point);
  }
  return groups;
}

/** Flattens a prompt group into the click list its decode is prompted with. */
export function groupPoints(group: PromptGroup): SamPoint[] {
  return [group.include, ...group.excludes];
}
