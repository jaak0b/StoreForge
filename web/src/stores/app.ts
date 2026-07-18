import { defineStore } from 'pinia';
import type { ProductOrigin } from '../engine/plan/types';

/**
 * App-wide UI state. The app is a single page; this store carries the
 * add-bin card's editing target (routed to the tab that owns the entry's
 * kind) and the global keyboard shortcut state.
 */
export const useApp = defineStore('app', {
  state: () => ({
    /** Id of the queue entry being edited, or null for a new bin. */
    editingEntryId: null as string | null,
    /** Origin of the entry being edited; names the tab that owns the edit. */
    editingKind: null as ProductOrigin | null,
    /**
     * Monotonic counter the Ctrl+N shortcut bumps; the add-bin card watches
     * it and focuses its first field (resetting to a new bin).
     */
    focusAddSeq: 0,
    /** Whether the keyboard shortcut sheet dialog is open. */
    shortcutSheetOpen: false,
  }),
  actions: {
    /** Asks the add-bin card to reset to a new bin and take focus. */
    focusAddCard() {
      this.editingEntryId = null;
      this.editingKind = null;
      this.focusAddSeq += 1;
    },
    /** Loads a queue entry into the tab owning its origin for editing. */
    editEntry(entryId: string, kind: ProductOrigin) {
      this.editingEntryId = entryId;
      this.editingKind = kind;
      this.focusAddSeq += 1;
    },
    /** Leaves editing mode; the tabs design new bins again. */
    stopEditing() {
      this.editingEntryId = null;
      this.editingKind = null;
    },
  },
});
