import { assertNever } from '../../engine/plan/types';
import type { TracedTool } from '../../engine/trace/types';

/**
 * The edit affordance a tool row shows, by outline source: a photo-traced
 * tool re-traces from its stored clicks, a sketched tool reopens its stored
 * sketch for editing, and a primitive shape has nothing to reopen. Shared by
 * every place a tool row renders its edit button (the advanced drawer's tool
 * list, the selection toolbar's menu), so they never drift out of step.
 */
export function editActionOf(tool: TracedTool): 'retrace' | 'editSketch' | 'none' {
  switch (tool.source.kind) {
    case 'photo':
      return 'retrace';
    case 'sketch':
      return 'editSketch';
    case 'primitive':
      return 'none';
    default:
      return assertNever(tool.source);
  }
}
