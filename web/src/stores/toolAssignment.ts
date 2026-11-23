import { defineStore } from 'pinia';
import {
  DEFAULT_TOOL_ASSIGNMENT,
  parseToolNumber,
  type ToolAssignment,
  type ToolNumberParse,
} from '../engine/threeMf/toolAssignment';

/**
 * The filament slots every two-filament 3MF download writes the body and the
 * label with. Shared by all 3MF download places so they use the same values.
 * Kept in memory only: a page reload starts again from the defaults. The
 * fields' text is stored as typed, so the tool dialog can show an invalid
 * entry's error.
 *
 * Every two-filament 3MF download asks for its tools through
 * requestAssignment, which opens the one ToolAssignmentDialog and resolves
 * with the confirmed assignment, or null when the user cancels.
 */
export const useToolAssignment = defineStore('toolAssignment', {
  state: () => ({
    bodyText: String(DEFAULT_TOOL_ASSIGNMENT.body),
    labelText: String(DEFAULT_TOOL_ASSIGNMENT.label),
    dialogOpen: false,
    /** Settles the open dialog's request; null while no request is open. */
    pendingResolve: null as ((assignment: ToolAssignment | null) => void) | null,
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
  actions: {
    /**
     * Opens the tool dialog and resolves with the confirmed assignment, or
     * null when the dialog is cancelled. A request made while another is open
     * cancels the older one.
     */
    requestAssignment(): Promise<ToolAssignment | null> {
      this.settle(null);
      return new Promise((resolve) => {
        this.pendingResolve = resolve;
        this.dialogOpen = true;
      });
    },
    /**
     * Confirms the open request with the typed assignment. Returns false and
     * leaves the dialog open while a field is invalid.
     */
    confirmRequest(): boolean {
      const assignment = this.assignment;
      if (assignment === null) return false;
      this.settle(assignment);
      return true;
    },
    /** Closes the dialog without an assignment. */
    cancelRequest(): void {
      this.settle(null);
    },
    settle(assignment: ToolAssignment | null): void {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.dialogOpen = false;
      resolve?.(assignment);
    },
  },
});
