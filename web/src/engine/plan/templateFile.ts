import { TEMPLATE_FILE_VERSION, type BinTemplate, type TemplateFile } from './types';
import { pickBinParams, validateBinParams } from './planFile';

/** Result of parsing a template file: either the templates or a user-worded error. */
export type TemplateParseResult =
  | { ok: true; templates: BinTemplate[] }
  | { ok: false; error: string };

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Validates one raw object as a BinTemplate. Returns null when it is valid,
 * otherwise a message naming the first offending field.
 */
export function validateTemplate(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'a template is not an object';
  }
  const template = raw as Record<string, unknown>;
  if (typeof template.id !== 'string' || template.id.length === 0) {
    return 'a template is missing its id';
  }
  const id = template.id;
  if (typeof template.name !== 'string' || template.name.trim().length === 0) {
    return `template ${id}: name must be a non-empty string`;
  }
  if (
    typeof template.params !== 'object' ||
    template.params === null ||
    Array.isArray(template.params)
  ) {
    return `template ${id}: params must be an object`;
  }
  const paramsProblem = validateBinParams(
    template.params as Record<string, unknown>,
    `template ${id}`,
  );
  if (paramsProblem !== null) return paramsProblem;
  if (!isIsoTimestamp(template.createdAt)) {
    return `template ${id}: createdAt must be an ISO 8601 timestamp`;
  }
  return null;
}

/**
 * Parses and validates template JSON text (from localStorage).
 * Rejects malformed input with a user-worded error; never drops templates silently.
 */
export function parseTemplateFile(text: string): TemplateParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The stored templates are not valid JSON (${detail}).` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'The stored templates are not a template object.' };
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.version !== TEMPLATE_FILE_VERSION) {
    return {
      ok: false,
      error: `The templates have version ${String(envelope.version)}, but this app reads version ${TEMPLATE_FILE_VERSION}.`,
    };
  }
  if (!Array.isArray(envelope.templates)) {
    return { ok: false, error: 'The templates are missing their list.' };
  }
  const templates: BinTemplate[] = [];
  const seen = new Set<string>();
  for (const item of envelope.templates) {
    const problem = validateTemplate(item);
    if (problem !== null) {
      return { ok: false, error: `The templates are invalid: ${problem}.` };
    }
    const template = item as Record<string, unknown>;
    const id = template.id as string;
    if (seen.has(id)) {
      return { ok: false, error: `The templates are invalid: template id ${id} appears twice.` };
    }
    seen.add(id);
    templates.push({
      id,
      name: template.name as string,
      params: pickBinParams(template.params as Record<string, unknown>),
      createdAt: template.createdAt as string,
    });
  }
  return { ok: true, templates };
}

/** Serializes templates to pretty-printed JSON for persistence. */
export function serializeTemplateFile(templates: BinTemplate[]): string {
  const file: TemplateFile = { version: TEMPLATE_FILE_VERSION, templates };
  return JSON.stringify(file, null, 2);
}
