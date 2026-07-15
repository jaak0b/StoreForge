import type { LabeledBinParams } from '../gridfinity/types';
import { PLAN_FILE_VERSION, type BinEntry, type BinStatus, type PlanFile } from './types';

/** Result of parsing a plan file: either the plan or a user-worded error. */
export type PlanParseResult =
  | { ok: true; plan: PlanFile }
  | { ok: false; error: string };

function isPositiveInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Validates the LabeledBinParams fields on a raw object. Returns null when
 * they are valid, otherwise a message naming the first offending field,
 * prefixed with the given subject (for example "entry abc" or "template abc").
 * Shared by the plan file and the template file, which both persist the same
 * design parameters.
 */
export function validateBinParams(entry: Record<string, unknown>, subject: string): string | null {
  if (!isPositiveInteger(entry.gridX, 1)) {
    return `${subject}: gridX must be an integer of at least 1`;
  }
  if (!isPositiveInteger(entry.gridY, 1)) {
    return `${subject}: gridY must be an integer of at least 1`;
  }
  if (!isPositiveInteger(entry.heightUnits, 2)) {
    return `${subject}: heightUnits must be an integer of at least 2`;
  }
  if (typeof entry.stackingLip !== 'boolean') {
    return `${subject}: stackingLip must be true or false`;
  }
  if (typeof entry.magnetHoles !== 'boolean') {
    return `${subject}: magnetHoles must be true or false`;
  }
  // dividerCountX/Y and perforatedBase were added after the first version-1
  // plans shipped; older files simply omit them, so undefined is accepted and
  // defaulted (no version bump needed, the envelope stays backward compatible).
  if (entry.dividerCountX !== undefined && !isPositiveInteger(entry.dividerCountX, 0)) {
    return `${subject}: dividerCountX must be an integer of at least 0`;
  }
  if (entry.dividerCountY !== undefined && !isPositiveInteger(entry.dividerCountY, 0)) {
    return `${subject}: dividerCountY must be an integer of at least 0`;
  }
  if (entry.perforatedBase !== undefined && typeof entry.perforatedBase !== 'boolean') {
    return `${subject}: perforatedBase must be true or false`;
  }
  if (typeof entry.labelText !== 'string') {
    return `${subject}: labelText must be a string`;
  }
  if (entry.labelIcon !== null && typeof entry.labelIcon !== 'string') {
    return `${subject}: labelIcon must be a string or null`;
  }
  return null;
}

/** Copies only the LabeledBinParams fields from a validated raw object. */
export function pickBinParams(raw: Record<string, unknown>): LabeledBinParams {
  return {
    gridX: raw.gridX as number,
    gridY: raw.gridY as number,
    heightUnits: raw.heightUnits as number,
    stackingLip: raw.stackingLip as boolean,
    magnetHoles: raw.magnetHoles as boolean,
    dividerCountX: (raw.dividerCountX as number | undefined) ?? 0,
    dividerCountY: (raw.dividerCountY as number | undefined) ?? 0,
    perforatedBase: (raw.perforatedBase as boolean | undefined) ?? false,
    labelText: raw.labelText as string,
    labelIcon: raw.labelIcon as string | null,
  };
}

/**
 * Validates one raw object as a BinEntry. Returns null when it is valid,
 * otherwise a message naming the first offending field.
 */
export function validateEntry(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'an entry is not an object';
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    return 'an entry is missing its id';
  }
  const id = entry.id;
  const paramsProblem = validateBinParams(entry, `entry ${id}`);
  if (paramsProblem !== null) return paramsProblem;
  if (!isPositiveInteger(entry.quantity, 1)) {
    return `entry ${id}: quantity must be an integer of at least 1`;
  }
  if (entry.status !== 'queued' && entry.status !== 'printed') {
    return `entry ${id}: status must be "queued" or "printed"`;
  }
  if (!isIsoTimestamp(entry.createdAt)) {
    return `entry ${id}: createdAt must be an ISO 8601 timestamp`;
  }
  if (entry.printedAt !== undefined && !isIsoTimestamp(entry.printedAt)) {
    return `entry ${id}: printedAt must be an ISO 8601 timestamp`;
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    return `entry ${id}: notes must be a string`;
  }
  return null;
}

/** Copies only the known BinEntry fields from a validated raw object. */
function pickEntry(raw: Record<string, unknown>): BinEntry {
  const entry: BinEntry = {
    id: raw.id as string,
    ...pickBinParams(raw),
    quantity: raw.quantity as number,
    status: raw.status as BinStatus,
    createdAt: raw.createdAt as string,
  };
  if (raw.printedAt !== undefined) entry.printedAt = raw.printedAt as string;
  if (raw.notes !== undefined) entry.notes = raw.notes as string;
  return entry;
}

/**
 * Parses and validates plan JSON text (from a file or localStorage).
 * Rejects malformed input with a user-worded error; never drops entries silently.
 */
export function parsePlanFile(text: string): PlanParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The file is not valid JSON (${detail}).` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'The file does not contain a plan object.' };
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.version !== PLAN_FILE_VERSION) {
    return {
      ok: false,
      error: `The file has plan version ${String(envelope.version)}, but this app reads version ${PLAN_FILE_VERSION}.`,
    };
  }
  if (!Array.isArray(envelope.entries)) {
    return { ok: false, error: 'The plan is missing its entries list.' };
  }
  const entries: BinEntry[] = [];
  const seen = new Set<string>();
  for (const item of envelope.entries) {
    const problem = validateEntry(item);
    if (problem !== null) {
      return { ok: false, error: `The plan is invalid: ${problem}.` };
    }
    const entry = pickEntry(item as Record<string, unknown>);
    if (seen.has(entry.id)) {
      return { ok: false, error: `The plan is invalid: entry id ${entry.id} appears twice.` };
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { ok: true, plan: { version: PLAN_FILE_VERSION, entries } };
}

/** Serializes a plan to pretty-printed JSON for export or persistence. */
export function serializePlanFile(entries: BinEntry[]): string {
  const plan: PlanFile = { version: PLAN_FILE_VERSION, entries };
  return JSON.stringify(plan, null, 2);
}

/**
 * Merges imported entries into existing ones. An imported entry with the same
 * id replaces the existing one; all others are appended in file order.
 */
export function mergeEntries(existing: BinEntry[], imported: BinEntry[]): BinEntry[] {
  const importedById = new Map(imported.map((entry) => [entry.id, entry]));
  const merged = existing.map((entry) => importedById.get(entry.id) ?? entry);
  const existingIds = new Set(existing.map((entry) => entry.id));
  for (const entry of imported) {
    if (!existingIds.has(entry.id)) merged.push(entry);
  }
  return merged;
}

/** Marks the given entries printed, stamping printedAt. Others are untouched. */
export function markEntriesPrinted(
  entries: BinEntry[],
  ids: Iterable<string>,
  printedAt: string = new Date().toISOString(),
): BinEntry[] {
  const idSet = new Set(ids);
  return entries.map((entry) =>
    idSet.has(entry.id) ? { ...entry, status: 'printed', printedAt } : entry,
  );
}

/** Puts the given entries back in the queue, clearing printedAt. */
export function requeueEntries(entries: BinEntry[], ids: Iterable<string>): BinEntry[] {
  const idSet = new Set(ids);
  return entries.map((entry) => {
    if (!idSet.has(entry.id)) return entry;
    const requeued: BinEntry = { ...entry, status: 'queued' };
    delete requeued.printedAt;
    return requeued;
  });
}
