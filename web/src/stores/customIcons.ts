import { defineStore } from 'pinia';
import type { CustomIconValidation } from '../engine/label/customIcon';
import type { CustomIcon } from '../engine/label/customIconFile';
import {
  parseCustomIconFile,
  serializeCustomIconFile,
} from '../engine/label/customIconFile';
import { LABEL_ICONS } from '../engine/label/icons';
import { fetchSvgText, isProbablyUrl } from '../svgSource';
import { validateCustomIcon } from '../workerClient';

const STORAGE_KEY = 'storeforge.custom-icons';

const EMPTY_NAME_PROBLEM = 'Enter a name for the icon.';
const NAME_TAKEN_PROBLEM = 'An icon with this name already exists. Choose a different name.';

/** Outcome of importing a custom icon: its new id, or the user-worded reason it was refused. */
export type IconImportResult = { ok: true; id: string } | { ok: false; error: string };

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

/**
 * Validates custom icon source exactly as the add dialog accepts it: SVG
 * markup, bare path data, or an http(s) link to an .svg file. A link is
 * fetched first; the text then goes through the worker's normalize pipeline.
 * The single validation step shared by the dialog's live preview and
 * importIcon.
 */
export async function validateIconSource(source: string): Promise<CustomIconValidation> {
  let markup = source;
  if (isProbablyUrl(source)) {
    const fetched = await fetchSvgText(source.trim());
    if (!fetched.ok) return { ok: false, error: fetched.error };
    markup = fetched.text;
  }
  return validateCustomIcon(markup);
}

/** The user-worded reason a name cannot be used for a new icon, or null when it is free. */
function iconNameProblem(icons: readonly CustomIcon[], name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return EMPTY_NAME_PROBLEM;
  if (
    LABEL_ICONS.some((icon) => icon.name === trimmed) ||
    icons.some((icon) => icon.name === trimmed)
  ) {
    return NAME_TAKEN_PROBLEM;
  }
  return null;
}

/** User-defined custom label icons, persisted to localStorage on mutation. */
export const useCustomIcons = defineStore('customIcons', {
  state: () => ({
    icons: loadIcons(),
  }),
  getters: {
    iconByName: (state) => (name: string) =>
      state.icons.find((icon) => icon.name === name) ?? null,
    /**
     * The single name check for new icons: empty names and names already used
     * by a built-in or custom icon come back as a user-worded problem.
     */
    nameProblem: (state) => (name: string) => iconNameProblem(state.icons, name),
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, serializeCustomIconFile(this.icons));
      } catch (error) {
        console.error('Saving the custom icons failed.', error);
      }
    },
    /**
     * Stores an already validated icon under a name. Returns its id. New icons
     * from user or agent input go through importIcon, which validates first.
     */
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
    /**
     * The one path that adds a custom icon from source text, used by the add
     * dialog and the agent tools: checks the name, validates the source (see
     * validateIconSource), checks the name again because another icon may have
     * taken it while validation ran, then saves under the trimmed name.
     */
    async importIcon(name: string, source: string): Promise<IconImportResult> {
      const nameProblem = iconNameProblem(this.icons, name);
      if (nameProblem !== null) return { ok: false, error: nameProblem };
      const validation = await validateIconSource(source);
      if (!validation.ok) return { ok: false, error: validation.error };
      const lateNameProblem = iconNameProblem(this.icons, name);
      if (lateNameProblem !== null) return { ok: false, error: lateNameProblem };
      return { ok: true, id: this.add(name.trim(), validation.path, validation.viewBox) };
    },
    remove(id: string) {
      this.icons = this.icons.filter((icon) => icon.id !== id);
      this.persist();
    },
    /**
     * Removes the custom icon with this name, as the icon picker's remove
     * button does. Queued bins that use it are left as they are. Returns a
     * user-worded problem for a built-in or unknown name, otherwise null.
     */
    removeByName(name: string): string | null {
      if (LABEL_ICONS.some((icon) => icon.name === name)) {
        return `The ${name} icon is built in and cannot be removed. Only custom icons can be removed.`;
      }
      const icon = this.icons.find((entry) => entry.name === name);
      if (icon === undefined) return `There is no custom icon named "${name}".`;
      this.remove(icon.id);
      return null;
    },
  },
});
