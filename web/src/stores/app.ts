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
    /** Id of the drawer group whose detail view is open, or null for none. */
    viewingDrawerId: null as string | null,
  }),
  actions: {
    /**
     * Opens the drawer group detail view for the given group id. The view lives
     * inside the Baseplate tab of the add-bin card, so this leaves any entry
     * edit and bumps focusAddSeq the same way editEntry does, letting the card
     * switch to the Baseplate tab and scroll into view.
     */
    openDrawer(groupId: string) {
      this.editingEntryId = null;
      this.editingKind = null;
      this.viewingDrawerId = groupId;
      this.focusAddSeq += 1;
    },
    /** Closes the drawer group detail view, returning the tab to its designer. */
    closeDrawer() {
      this.viewingDrawerId = null;
    },
    /** Asks the add-bin card to reset to a new bin and take focus. */
    focusAddCard() {
      this.editingEntryId = null;
      this.editingKind = null;
      this.viewingDrawerId = null;
      this.focusAddSeq += 1;
    },
    /** Loads a queue entry into the tab owning its origin for editing. */
    editEntry(entryId: string, kind: ProductOrigin) {
      this.editingEntryId = entryId;
      this.editingKind = kind;
      this.viewingDrawerId = null;
      this.focusAddSeq += 1;
    },
    /** Leaves editing mode; the tabs design new bins again. */
    stopEditing() {
      this.editingEntryId = null;
      this.editingKind = null;
    },
  },
});
