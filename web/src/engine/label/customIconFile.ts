/**
 * Persistence format for user-defined custom label icons, mirroring the
 * template file envelope. Parsing revalidates the stored path data so a
 * corrupted store can never feed an unusable path into the label pipeline.
 */

import { validateCustomIcon } from './customIcon';

/** One saved custom icon. */
export interface CustomIcon {
  /** Stable unique identifier (UUID). */
  id: string;
  /** User-chosen display name, also the labelIcon reference key. */
  name: string;
  /** SVG path d attribute describing the filled silhouette. */
  path: string;
  /** Tight bounding box of the path: [minX, minY, width, height]. */
  viewBox: [number, number, number, number];
  /** ISO 8601 timestamp of when the icon was added. */
  createdAt: string;
}

/** Versioned envelope the custom icons are persisted as. */
export interface CustomIconFile {
  /** Envelope format version. Currently always 1. */
  version: 1;
  /** All saved custom icons. */
  icons: CustomIcon[];
}

/** The current custom icon envelope format version. */
export const CUSTOM_ICON_FILE_VERSION = 1;

/** Result of parsing a custom icon file: the icons or a user-worded error. */
export type CustomIconParseResult =
  | { ok: true; icons: CustomIcon[] }
  | { ok: false; error: string };

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Validates one raw object as a CustomIcon. Returns null when it is valid,
 * otherwise a message naming the first offending field.
 */
export function validateCustomIconEntry(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'an icon is not an object';
  }
  const icon = raw as Record<string, unknown>;
  if (typeof icon.id !== 'string' || icon.id.length === 0) {
    return 'an icon is missing its id';
  }
  const id = icon.id;
  if (typeof icon.name !== 'string' || icon.name.trim().length === 0) {
    return `icon ${id}: name must be a non-empty string`;
  }
  if (typeof icon.path !== 'string') {
    return `icon ${id}: path must be a string`;
  }
  const pathCheck = validateCustomIcon(icon.path);
  if (!pathCheck.ok) {
    return `icon ${id}: ${pathCheck.error}`;
  }
  if (
    !Array.isArray(icon.viewBox) ||
    icon.viewBox.length !== 4 ||
    icon.viewBox.some((n) => typeof n !== 'number' || !Number.isFinite(n))
  ) {
    return `icon ${id}: viewBox must be four finite numbers`;
  }
  if (!isIsoTimestamp(icon.createdAt)) {
    return `icon ${id}: createdAt must be an ISO 8601 timestamp`;
  }
  return null;
}

/**
 * Parses and validates custom icon JSON text (from localStorage).
 * Rejects malformed input with a user-worded error; never drops icons silently.
 */
export function parseCustomIconFile(text: string): CustomIconParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The stored icons are not valid JSON (${detail}).` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'The stored icons are not an icon object.' };
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.version !== CUSTOM_ICON_FILE_VERSION) {
    return {
      ok: false,
      error: `The icons have version ${String(envelope.version)}, but this app reads version ${CUSTOM_ICON_FILE_VERSION}.`,
    };
  }
  if (!Array.isArray(envelope.icons)) {
    return { ok: false, error: 'The icons are missing their list.' };
  }
  const icons: CustomIcon[] = [];
  const seen = new Set<string>();
  for (const item of envelope.icons) {
    const problem = validateCustomIconEntry(item);
    if (problem !== null) {
      return { ok: false, error: `The icons are invalid: ${problem}.` };
    }
    const icon = item as Record<string, unknown>;
    const id = icon.id as string;
    if (seen.has(id)) {
      return { ok: false, error: `The icons are invalid: icon id ${id} appears twice.` };
    }
    seen.add(id);
    icons.push({
      id,
      name: icon.name as string,
      path: icon.path as string,
      viewBox: [...(icon.viewBox as number[])] as [number, number, number, number],
      createdAt: icon.createdAt as string,
    });
  }
  return { ok: true, icons };
}

/** Serializes custom icons to pretty-printed JSON for persistence. */
export function serializeCustomIconFile(icons: CustomIcon[]): string {
  const file: CustomIconFile = { version: CUSTOM_ICON_FILE_VERSION, icons };
  return JSON.stringify(file, null, 2);
}
