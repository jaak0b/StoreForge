import { defineStore } from 'pinia';
import {
  DEFAULT_TOOL_ASSIGNMENT,
  parseToolNumber,
  type ToolAssignment,
  type ToolNumberParse,
} from '../engine/threeMf/toolAssignment';

/**
 * The filament slots every two-filament 3MF download writes the body and the
 * label with. Shared by all 3MF download places so they show and use the same
 * values. Kept in memory only: a page reload starts again from the defaults.
 * The fields' text is stored as typed, so an invalid entry shows its error in
 * every place and blocks every 3MF download until it is fixed.
 */
export const useToolAssignment = defineStore('toolAssignment', {
  state: () => ({
    bodyText: String(DEFAULT_TOOL_ASSIGNMENT.body),
    labelText: String(DEFAULT_TOOL_ASSIGNMENT.label),
  }),
  getters: {
    body(state): ToolNumberParse {
      return parseToolNumber(state.bodyText);
    },
    label(state): ToolNumberParse {
      return parseToolNumber(state.labelText);
    },
    /** The assignment to download with, or null while either field is invalid. */
    assignment(): ToolAssignment | null {
      const body = this.body;
      const label = this.label;
      return body.ok && label.ok ? { body: body.value, label: label.value } : null;
    },
  },
});
