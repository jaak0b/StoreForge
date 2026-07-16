import { defineStore } from 'pinia';

/**
 * App-wide UI state. The app is a single page; this store carries the
 * add-bin card's editing target and the global keyboard shortcut state.
 */
export const useApp = defineStore('app', {
  state: () => ({
    /** Id of the queue entry loaded into the Manual tab, or null for a new bin. */
    editingEntryId: null as string | null,
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
      this.focusAddSeq += 1;
    },
    /** Loads a queue entry into the Manual tab for editing. */
    editEntry(entryId: string) {
      this.editingEntryId = entryId;
      this.focusAddSeq += 1;
    },
    /** Leaves editing mode; the Manual tab designs a new bin again. */
    stopEditing() {
      this.editingEntryId = null;
    },
  },
});
