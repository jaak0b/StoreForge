import { defineStore } from 'pinia';

const STORAGE_KEY = 'storeforge.settings';

/** The user's app-wide preferences, as they are persisted. */
export interface AppSettings {
  /** Whether the WebMCP local relay is loaded so a desktop AI agent can connect. */
  allowLocalAgent: boolean;
}

/** The settings of a first visit, and of a stored value that cannot be read. */
export function defaultSettings(): AppSettings {
  return { allowLocalAgent: false };
}

function loadSettings(): AppSettings {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error('Reading the stored settings failed.', error);
    return defaultSettings();
  }
  if (text === null) return defaultSettings();
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch (error) {
    console.error('The stored settings are not valid JSON; the defaults apply.', error);
    return defaultSettings();
  }
  const settings = defaultSettings();
  const allowLocalAgent = (stored as { allowLocalAgent?: unknown } | null)?.allowLocalAgent;
  if (typeof allowLocalAgent === 'boolean') {
    settings.allowLocalAgent = allowLocalAgent;
  } else {
    console.error('The stored settings have no valid allowLocalAgent value; it stays off.');
  }
  return settings;
}

/** App-wide user preferences, persisted to localStorage on every change. */
export const useSettings = defineStore('settings', {
  state: (): AppSettings => loadSettings(),
  actions: {
    persist() {
      const settings: AppSettings = { allowLocalAgent: this.allowLocalAgent };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch (error) {
        console.error('Saving the settings failed.', error);
      }
    },
    setAllowLocalAgent(allowed: boolean) {
      this.allowLocalAgent = allowed;
      this.persist();
    },
  },
});
