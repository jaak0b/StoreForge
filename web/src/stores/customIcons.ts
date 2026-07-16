import { defineStore } from 'pinia';
import type { CustomIcon } from '../engine/label/customIconFile';
import {
  parseCustomIconFile,
  serializeCustomIconFile,
} from '../engine/label/customIconFile';

const STORAGE_KEY = 'gridfinity-generator.custom-icons';

function loadIcons(): CustomIcon[] {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error('Reading the stored custom icons failed.', error);
    return [];
  }
  if (text === null) return [];
  const result = parseCustomIconFile(text);
  if (!result.ok) {
    console.error(`The stored custom icons could not be read: ${result.error}`);
    return [];
  }
  return result.icons;
}

/** User-defined custom label icons, persisted to localStorage on mutation. */
export const useCustomIcons = defineStore('customIcons', {
  state: () => ({
    icons: loadIcons(),
  }),
  getters: {
    iconByName: (state) => (name: string) =>
      state.icons.find((icon) => icon.name === name) ?? null,
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, serializeCustomIconFile(this.icons));
      } catch (error) {
        console.error('Saving the custom icons failed.', error);
      }
    },
    /** Adds a validated icon under a name. Returns its id. */
    add(name: string, path: string, viewBox: [number, number, number, number]): string {
      const icon: CustomIcon = {
        id: crypto.randomUUID(),
        name,
        path,
        viewBox: [...viewBox] as [number, number, number, number],
        createdAt: new Date().toISOString(),
      };
      this.icons.push(icon);
      this.persist();
      return icon.id;
    },
    remove(id: string) {
      this.icons = this.icons.filter((icon) => icon.id !== id);
      this.persist();
    },
  },
});
