import { defineStore } from 'pinia';
import type { BinTemplate } from '../engine/plan/types';
import type { LabeledBinParams } from '../engine/gridfinity/types';
import { parseTemplateFile, serializeTemplateFile } from '../engine/plan/templateFile';

const STORAGE_KEY = 'gridfinity-generator.templates';

function loadTemplates(): BinTemplate[] {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error('Reading the stored templates failed.', error);
    return [];
  }
  if (text === null) return [];
  const result = parseTemplateFile(text);
  if (!result.ok) {
    console.error(`The stored templates could not be read: ${result.error}`);
    return [];
  }
  return result.templates;
}

/** Saved bin templates, persisted to localStorage on mutation. */
export const useBinTemplates = defineStore('binTemplates', {
  state: () => ({
    templates: loadTemplates(),
  }),
  getters: {
    templateById: (state) => (id: string) =>
      state.templates.find((t) => t.id === id) ?? null,
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, serializeTemplateFile(this.templates));
      } catch (error) {
        console.error('Saving the templates failed.', error);
      }
    },
    /** Saves the given design parameters as a new named template. Returns its id. */
    save(name: string, params: LabeledBinParams): string {
      const template: BinTemplate = {
        id: crypto.randomUUID(),
        name,
        params: { ...params },
        createdAt: new Date().toISOString(),
      };
      this.templates.push(template);
      this.persist();
      return template.id;
    },
    /** Renames an existing template. */
    rename(id: string, name: string) {
      const template = this.templateById(id);
      if (template === null) return;
      template.name = name;
      this.persist();
    },
    remove(id: string) {
      this.templates = this.templates.filter((t) => t.id !== id);
      this.persist();
    },
    /** Returns a copy of the template's parameters, or null if it is gone. */
    apply(id: string): LabeledBinParams | null {
      const template = this.templateById(id);
      if (template === null) return null;
      return { ...template.params };
    },
  },
});
