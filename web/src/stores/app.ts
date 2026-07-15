import { defineStore } from 'pinia';

/** The pages the app can show. */
export type AppPage = 'queue' | 'designer' | 'plate' | 'screwListImport';

/** Keyboard shortcut intents pages can react to. */
export type ShortcutKind = 'toggleSession' | 'toggleBulk' | 'escape';

/** One dispatched shortcut. The sequence number makes repeats observable. */
export interface ShortcutIntent {
  kind: ShortcutKind;
  seq: number;
}

/**
 * In-app navigation state. The queue is the home page; the designer opens
 * from it to create a new entry or edit an existing one.
 */
export const useApp = defineStore('app', {
  state: () => ({
    page: 'queue' as AppPage,
    /** Id of the queue entry being edited, or null when designing a new bin. */
    editingEntryId: null as string | null,
    /** The most recently dispatched keyboard shortcut, for pages to watch. */
    shortcutIntent: null as ShortcutIntent | null,
    /** Whether the keyboard shortcut sheet dialog is open. */
    shortcutSheetOpen: false,
  }),
  actions: {
    /** Dispatches a keyboard shortcut intent for the current page to handle. */
    sendShortcut(kind: ShortcutKind) {
      const seq = (this.shortcutIntent?.seq ?? 0) + 1;
      this.shortcutIntent = { kind, seq };
    },
    /** Opens the designer for a new bin entry. */
    openDesignerNew() {
      this.editingEntryId = null;
      this.page = 'designer';
    },
    /** Opens the designer with an existing queue entry loaded. */
    openDesignerEdit(entryId: string) {
      this.editingEntryId = entryId;
      this.page = 'designer';
    },
    /** Returns to the queue page. */
    showQueue() {
      this.editingEntryId = null;
      this.page = 'queue';
    },
    /** Opens the screw list import page. */
    showScrewListImport() {
      this.editingEntryId = null;
      this.page = 'screwListImport';
    },
    /** Opens the build plate composer. */
    showPlate() {
      this.editingEntryId = null;
      this.page = 'plate';
    },
  },
});
