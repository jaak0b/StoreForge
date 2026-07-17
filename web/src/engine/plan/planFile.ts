import type { LabeledBinParams } from '../gridfinity/types';
import {
  PLAN_FILE_VERSION,
  type BatchItem,
  type BinEntry,
  type BinPockets,
  type PlanFile,
  type PrintBatch,
} from './types';
import type { FingerHole, MmPoint, TracedTool, ToolPlacement } from '../trace/types';

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
  // dividerCountX/Y were added after the first version-1 plans shipped; older
  // files simply omit them, so undefined is accepted and defaulted (the
  // migration path stays backward compatible).
  if (entry.dividerCountX !== undefined && !isPositiveInteger(entry.dividerCountX, 0)) {
    return `${subject}: dividerCountX must be an integer of at least 0`;
  }
  if (entry.dividerCountY !== undefined && !isPositiveInteger(entry.dividerCountY, 0)) {
    return `${subject}: dividerCountY must be an integer of at least 0`;
  }
  if (typeof entry.labelText !== 'string') {
    return `${subject}: labelText must be a string`;
  }
  // labelText2 was added after the first version-1 plans shipped; older files
  // simply omit it, so undefined is accepted and defaulted to an empty string.
  if (entry.labelText2 !== undefined && typeof entry.labelText2 !== 'string') {
    return `${subject}: labelText2 must be a string`;
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
    labelText: raw.labelText as string,
    labelText2: (raw.labelText2 as string | undefined) ?? '',
    labelIcon: raw.labelIcon as string | null,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isMmPointList(value: unknown): value is MmPoint[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        isFiniteNumber((p as Record<string, unknown>).x) &&
        isFiniteNumber((p as Record<string, unknown>).y),
    )
  );
}

/**
 * Validates a raw value as a BinPockets object (tools plus placements).
 * Returns null when it is valid, otherwise a message naming the first
 * offending part, prefixed with the given subject. Older plan files simply
 * omit the pockets field; this only runs when it is present.
 */
export function validatePockets(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: pockets must be an object`;
  }
  const pockets = raw as Record<string, unknown>;
  if (!Array.isArray(pockets.tools)) {
    return `${subject}: pockets is missing its tools list`;
  }
  const toolIds = new Set<string>();
  for (const rawTool of pockets.tools) {
    if (typeof rawTool !== 'object' || rawTool === null || Array.isArray(rawTool)) {
      return `${subject}: a pocket tool is not an object`;
    }
    const tool = rawTool as Record<string, unknown>;
    if (typeof tool.id !== 'string' || tool.id.length === 0) {
      return `${subject}: a pocket tool is missing its id`;
    }
    if (toolIds.has(tool.id)) {
      return `${subject}: pocket tool id ${tool.id} appears twice`;
    }
    toolIds.add(tool.id);
    if (typeof tool.name !== 'string') {
      return `${subject}: pocket tool ${tool.id}: name must be a string`;
    }
    const outline = tool.outline as Record<string, unknown> | null | undefined;
    if (typeof outline !== 'object' || outline === null || Array.isArray(outline)) {
      return `${subject}: pocket tool ${tool.id}: outline must be an object`;
    }
    if (!isMmPointList(outline.outer) || (outline.outer as MmPoint[]).length < 3) {
      return `${subject}: pocket tool ${tool.id}: outline needs at least 3 outer points`;
    }
    if (
      !Array.isArray(outline.holes) ||
      !outline.holes.every((loop) => isMmPointList(loop) && loop.length >= 3)
    ) {
      return `${subject}: pocket tool ${tool.id}: outline holes must be lists of points`;
    }
    if (!isFiniteNumber(tool.rotationDeg)) {
      return `${subject}: pocket tool ${tool.id}: rotationDeg must be a number`;
    }
    if (!isFiniteNumber(tool.offsetMm) || tool.offsetMm < 0) {
      return `${subject}: pocket tool ${tool.id}: offsetMm must be a number of at least 0`;
    }
    if (typeof tool.mirrored !== 'boolean') {
      return `${subject}: pocket tool ${tool.id}: mirrored must be true or false`;
    }
    if (!Array.isArray(tool.fingerHoles)) {
      return `${subject}: pocket tool ${tool.id}: fingerHoles must be a list`;
    }
    for (const rawHole of tool.fingerHoles) {
      const hole = rawHole as Record<string, unknown> | null;
      if (
        typeof hole !== 'object' ||
        hole === null ||
        !isFiniteNumber(hole.x) ||
        !isFiniteNumber(hole.y) ||
        !isFiniteNumber(hole.diameterMm) ||
        hole.diameterMm <= 0
      ) {
        return `${subject}: pocket tool ${tool.id}: a finger hole needs x, y and a diameterMm above 0`;
      }
    }
  }
  if (!Array.isArray(pockets.placements)) {
    return `${subject}: pockets is missing its placements list`;
  }
  for (const rawPlacement of pockets.placements) {
    const placement = rawPlacement as Record<string, unknown> | null;
    if (typeof placement !== 'object' || placement === null) {
      return `${subject}: a pocket placement is not an object`;
    }
    if (typeof placement.toolId !== 'string' || !toolIds.has(placement.toolId)) {
      return `${subject}: a pocket placement refers to a tool that is not in the pockets`;
    }
    if (
      !isFiniteNumber(placement.xMm) ||
      !isFiniteNumber(placement.yMm) ||
      !isFiniteNumber(placement.pocketDepthMm) ||
      placement.pocketDepthMm <= 0
    ) {
      return `${subject}: a pocket placement needs xMm, yMm and a pocketDepthMm above 0`;
    }
  }
  return null;
}

/** Copies only the known BinPockets fields from a validated raw object. */
export function pickPockets(raw: Record<string, unknown>): BinPockets {
  const tools = (raw.tools as Record<string, unknown>[]).map((tool): TracedTool => {
    const outline = tool.outline as Record<string, unknown>;
    return {
      id: tool.id as string,
      name: tool.name as string,
      outline: {
        outer: (outline.outer as MmPoint[]).map((p) => ({ x: p.x, y: p.y })),
        holes: (outline.holes as MmPoint[][]).map((loop) => loop.map((p) => ({ x: p.x, y: p.y }))),
      },
      rotationDeg: tool.rotationDeg as number,
      offsetMm: tool.offsetMm as number,
      mirrored: tool.mirrored as boolean,
      fingerHoles: (tool.fingerHoles as FingerHole[]).map((hole) => ({
        x: hole.x,
        y: hole.y,
        diameterMm: hole.diameterMm,
      })),
    };
  });
  const placements = (raw.placements as Record<string, unknown>[]).map(
    (placement): ToolPlacement => ({
      toolId: placement.toolId as string,
      xMm: placement.xMm as number,
      yMm: placement.yMm as number,
      pocketDepthMm: placement.pocketDepthMm as number,
    }),
  );
  return { tools, placements };
}

/**
 * Validates one raw object as a BinEntry. Returns null when it is valid,
 * otherwise a message naming the first offending field. Version-1 lifecycle
 * fields (status, printedAt) are tolerated and ignored; the queue has no
 * printed state anymore.
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
  if (!isIsoTimestamp(entry.createdAt)) {
    return `entry ${id}: createdAt must be an ISO 8601 timestamp`;
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    return `entry ${id}: notes must be a string`;
  }
  if (entry.pockets !== undefined) {
    const pocketsProblem = validatePockets(entry.pockets, `entry ${id}`);
    if (pocketsProblem !== null) return pocketsProblem;
  }
  return null;
}

/** Copies only the known BinEntry fields from a validated raw object. */
function pickEntry(raw: Record<string, unknown>): BinEntry {
  const entry: BinEntry = {
    id: raw.id as string,
    ...pickBinParams(raw),
    quantity: raw.quantity as number,
    createdAt: raw.createdAt as string,
  };
  if (raw.notes !== undefined) entry.notes = raw.notes as string;
  if (raw.pockets !== undefined) {
    entry.pockets = pickPockets(raw.pockets as Record<string, unknown>);
  }
  return entry;
}

/**
 * Validates one raw object as a PrintBatch. Returns null when it is valid,
 * otherwise a message naming the first offending field.
 */
export function validateBatch(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'a batch is not an object';
  }
  const batch = raw as Record<string, unknown>;
  if (typeof batch.id !== 'string' || batch.id.length === 0) {
    return 'a batch is missing its id';
  }
  const id = batch.id;
  if (typeof batch.name !== 'string') {
    return `batch ${id}: name must be a string`;
  }
  if (!isIsoTimestamp(batch.createdAt)) {
    return `batch ${id}: createdAt must be an ISO 8601 timestamp`;
  }
  if (!Array.isArray(batch.items)) {
    return `batch ${id}: items must be a list`;
  }
  for (const rawItem of batch.items) {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
      return `batch ${id}: an item is not an object`;
    }
    const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return `batch ${id}: an item is missing its id`;
    }
    if (typeof item.params !== 'object' || item.params === null || Array.isArray(item.params)) {
      return `batch ${id}: item ${item.id}: params must be an object`;
    }
    const paramsProblem = validateBinParams(
      item.params as Record<string, unknown>,
      `batch ${id}: item ${item.id}`,
    );
    if (paramsProblem !== null) return paramsProblem;
    if (!isPositiveInteger(item.count, 1)) {
      return `batch ${id}: item ${item.id}: count must be an integer of at least 1`;
    }
    if (item.sourceEntryId !== undefined && typeof item.sourceEntryId !== 'string') {
      return `batch ${id}: item ${item.id}: sourceEntryId must be a string`;
    }
    if (item.pockets !== undefined) {
      const pocketsProblem = validatePockets(item.pockets, `batch ${id}: item ${item.id}`);
      if (pocketsProblem !== null) return pocketsProblem;
    }
  }
  return null;
}

/** Copies only the known PrintBatch fields from a validated raw object. */
function pickBatch(raw: Record<string, unknown>): PrintBatch {
  const items = (raw.items as Record<string, unknown>[]).map((rawItem) => {
    const item: BatchItem = {
      id: rawItem.id as string,
      params: pickBinParams(rawItem.params as Record<string, unknown>),
      count: rawItem.count as number,
    };
    if (rawItem.sourceEntryId !== undefined) {
      item.sourceEntryId = rawItem.sourceEntryId as string;
    }
    if (rawItem.pockets !== undefined) {
      item.pockets = pickPockets(rawItem.pockets as Record<string, unknown>);
    }
    return item;
  });
  return {
    id: raw.id as string,
    name: raw.name as string,
    items,
    createdAt: raw.createdAt as string,
  };
}

/**
 * Parses and validates plan JSON text (from a file or localStorage).
 * Rejects malformed input with a user-worded error; never drops entries
 * silently.
 *
 * Migration: version-1 files (which had per-entry status and no batches) are
 * read too. Their queued entries are imported as queue entries; entries with
 * status "printed" are dropped, because the new model keeps no history of
 * finished prints (a confirmed print simply leaves the plan). Batches start
 * empty for a migrated file.
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
  const version = envelope.version;
  if (version !== 1 && version !== PLAN_FILE_VERSION) {
    return {
      ok: false,
      error: `The file has plan version ${String(envelope.version)}, but this app reads versions 1 and ${PLAN_FILE_VERSION}.`,
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
    const rawEntry = item as Record<string, unknown>;
    if (version === 1 && rawEntry.status === 'printed') continue;
    const entry = pickEntry(rawEntry);
    if (seen.has(entry.id)) {
      return { ok: false, error: `The plan is invalid: entry id ${entry.id} appears twice.` };
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  const batches: PrintBatch[] = [];
  if (version === PLAN_FILE_VERSION) {
    if (!Array.isArray(envelope.batches)) {
      return { ok: false, error: 'The plan is missing its batches list.' };
    }
    const seenBatchIds = new Set<string>();
    for (const item of envelope.batches) {
      const problem = validateBatch(item);
      if (problem !== null) {
        return { ok: false, error: `The plan is invalid: ${problem}.` };
      }
      const batch = pickBatch(item as Record<string, unknown>);
      if (seenBatchIds.has(batch.id)) {
        return { ok: false, error: `The plan is invalid: batch id ${batch.id} appears twice.` };
      }
      seenBatchIds.add(batch.id);
      batches.push(batch);
    }
  }
  return { ok: true, plan: { version: PLAN_FILE_VERSION, entries, batches } };
}

/** Serializes a plan to pretty-printed JSON for export or persistence. */
export function serializePlanFile(entries: BinEntry[], batches: PrintBatch[]): string {
  const plan: PlanFile = { version: PLAN_FILE_VERSION, entries, batches };
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

/**
 * Merges imported batches into existing ones, by the same rule as entries:
 * an imported batch with the same id replaces the existing one, all others
 * are appended in file order.
 */
export function mergeBatches(existing: PrintBatch[], imported: PrintBatch[]): PrintBatch[] {
  const importedById = new Map(imported.map((batch) => [batch.id, batch]));
  const merged = existing.map((batch) => importedById.get(batch.id) ?? batch);
  const existingIds = new Set(existing.map((batch) => batch.id));
  for (const batch of imported) {
    if (!existingIds.has(batch.id)) merged.push(batch);
  }
  return merged;
}
