import type { LabeledBinParams } from '../gridfinity/types';
import {
  PLAN_FILE_VERSION,
  type BatchItem,
  type BinEntry,
  type BinEntryBase,
  type BinPockets,
  type PlanFile,
  type PrintBatch,
  type ScrewSpec,
  type TracePaper,
} from './types';
import { HEAD_TYPES, type HeadType } from './screwListImport';
import type {
  FingerHole,
  MmPoint,
  PaperCorners,
  PaperKind,
  SamPoint,
  TracedTool,
  ToolPlacement,
} from '../trace/types';

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
    // clicks were added after the first traced entries shipped; older plans
    // simply omit them, so undefined is accepted and defaulted to an empty list.
    if (tool.clicks !== undefined) {
      if (!Array.isArray(tool.clicks)) {
        return `${subject}: pocket tool ${tool.id}: clicks must be a list`;
      }
      for (const rawClick of tool.clicks) {
        const click = rawClick as Record<string, unknown> | null;
        if (
          typeof click !== 'object' ||
          click === null ||
          !isFiniteNumber(click.x) ||
          !isFiniteNumber(click.y) ||
          (click.label !== 0 && click.label !== 1)
        ) {
          return `${subject}: pocket tool ${tool.id}: a click needs x, y and a label of 0 or 1`;
        }
      }
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
      if (
        (hole.x2 !== undefined || hole.y2 !== undefined) &&
        (!isFiniteNumber(hole.x2) || !isFiniteNumber(hole.y2))
      ) {
        return `${subject}: pocket tool ${tool.id}: an elongated finger hole needs both x2 and y2 as numbers`;
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
      clicks: ((tool.clicks as SamPoint[] | undefined) ?? []).map((p) => ({
        x: p.x,
        y: p.y,
        label: p.label,
      })),
      rotationDeg: tool.rotationDeg as number,
      offsetMm: tool.offsetMm as number,
      mirrored: tool.mirrored as boolean,
      fingerHoles: (tool.fingerHoles as FingerHole[]).map((hole) => ({
        x: hole.x,
        y: hole.y,
        ...(hole.x2 !== undefined && hole.y2 !== undefined
          ? { x2: hole.x2, y2: hole.y2 }
          : {}),
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

const CORNER_KEYS = ['tl', 'tr', 'br', 'bl'] as const;

/**
 * Validates the optional trace-source fields (traceSourceId and paper) on a
 * raw traced entry or batch item. Returns null when they are valid or absent,
 * otherwise a message naming the first offending part. Plans from other
 * devices simply omit both; the entry is then layout-only editable.
 */
export function validateTraceSource(raw: Record<string, unknown>, subject: string): string | null {
  if (raw.traceSourceId !== undefined) {
    if (typeof raw.traceSourceId !== 'string' || raw.traceSourceId.length === 0) {
      return `${subject}: traceSourceId must be a non-empty string`;
    }
  }
  if (raw.paper !== undefined) {
    if (typeof raw.paper !== 'object' || raw.paper === null || Array.isArray(raw.paper)) {
      return `${subject}: paper must be an object`;
    }
    const paper = raw.paper as Record<string, unknown>;
    if (paper.kind !== 'a4' && paper.kind !== 'letter') {
      return `${subject}: paper kind must be a4 or letter`;
    }
    const corners = paper.corners as Record<string, unknown> | null | undefined;
    if (typeof corners !== 'object' || corners === null || Array.isArray(corners)) {
      return `${subject}: paper corners must be an object`;
    }
    for (const key of CORNER_KEYS) {
      const corner = corners[key] as Record<string, unknown> | null | undefined;
      if (
        typeof corner !== 'object' ||
        corner === null ||
        !isFiniteNumber(corner.x) ||
        !isFiniteNumber(corner.y)
      ) {
        return `${subject}: paper corner ${key} needs x and y coordinates`;
      }
    }
  }
  return null;
}

/** Copies only the known TracePaper fields from a validated raw object. */
function pickTracePaper(raw: Record<string, unknown>): TracePaper {
  const corners = raw.corners as Record<string, { x: number; y: number }>;
  const picked = {} as Record<string, { x: number; y: number }>;
  for (const key of CORNER_KEYS) {
    picked[key] = { x: corners[key].x, y: corners[key].y };
  }
  return { corners: picked as unknown as PaperCorners, kind: raw.kind as PaperKind };
}

/**
 * Copies the optional trace-source fields onto a validated traced entry or
 * batch item, when present.
 */
function assignTraceSource(
  target: { traceSourceId?: string; paper?: TracePaper },
  raw: Record<string, unknown>,
): void {
  if (raw.traceSourceId !== undefined) target.traceSourceId = raw.traceSourceId as string;
  if (raw.paper !== undefined) target.paper = pickTracePaper(raw.paper as Record<string, unknown>);
}

const HEAD_TYPE_SET: ReadonlySet<string> = new Set<string>(HEAD_TYPES);

/**
 * Validates a raw value as a ScrewSpec. Returns null when it is valid,
 * otherwise a message naming the first offending field.
 */
export function validateScrew(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: screw must be an object`;
  }
  const screw = raw as Record<string, unknown>;
  if (typeof screw.thread !== 'string' || screw.thread.length === 0) {
    return `${subject}: screw thread must be a non-empty string`;
  }
  if (screw.lengthMm !== null && !isPositiveInteger(screw.lengthMm, 1)) {
    return `${subject}: screw lengthMm must be an integer of at least 1 or null`;
  }
  if (screw.head !== null && (typeof screw.head !== 'string' || !HEAD_TYPE_SET.has(screw.head))) {
    return `${subject}: screw head must be a known head type or null`;
  }
  if (
    screw.enteredLengthText !== null &&
    screw.enteredLengthText !== undefined &&
    typeof screw.enteredLengthText !== 'string'
  ) {
    return `${subject}: screw enteredLengthText must be a string or null`;
  }
  return null;
}

/** Copies only the known ScrewSpec fields from a validated raw object. */
function pickScrew(raw: Record<string, unknown>): ScrewSpec {
  return {
    thread: raw.thread as string,
    lengthMm: raw.lengthMm as number | null,
    head: raw.head as HeadType | null,
    enteredLengthText: (raw.enteredLengthText as string | null | undefined) ?? null,
  };
}

/**
 * Resolves an entry's kind. Entries written before the discriminated union
 * carry no kind field; they migrate as traced when they have pockets and as
 * manual otherwise. Old screw-list entries had no marker of their own, so
 * they migrate to manual bins too (acceptable: their screw breakdown is not
 * recoverable from the label text).
 */
function resolveKind(entry: Record<string, unknown>): 'manual' | 'screw' | 'traced' {
  if (entry.kind === 'manual' || entry.kind === 'screw' || entry.kind === 'traced') {
    return entry.kind;
  }
  return entry.pockets !== undefined ? 'traced' : 'manual';
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
  if (
    entry.kind !== undefined &&
    entry.kind !== 'manual' &&
    entry.kind !== 'screw' &&
    entry.kind !== 'traced'
  ) {
    return `entry ${id}: kind must be manual, screw or traced`;
  }
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
  const kind = resolveKind(entry);
  if (kind === 'traced') {
    if (entry.pockets === undefined) {
      return `entry ${id}: a traced entry must have pockets`;
    }
    // Only an explicit traced kind rejects divider fields: pre-union traced
    // entries were written with dividerCountX/Y of 0 alongside their pockets.
    if (
      entry.kind === 'traced' &&
      (entry.dividerCountX !== undefined || entry.dividerCountY !== undefined)
    ) {
      return `entry ${id}: a traced entry cannot have divider walls`;
    }
    const pocketsProblem = validatePockets(entry.pockets, `entry ${id}`);
    if (pocketsProblem !== null) return pocketsProblem;
    return validateTraceSource(entry, `entry ${id}`);
  }
  if (entry.pockets !== undefined) {
    return `entry ${id}: only a traced entry can have pockets`;
  }
  if (kind === 'screw') {
    const screwProblem = validateScrew(entry.screw, `entry ${id}`);
    if (screwProblem !== null) return screwProblem;
  }
  return null;
}

/** Copies only the known BinEntry fields from a validated raw object. */
function pickEntry(raw: Record<string, unknown>): BinEntry {
  const base: BinEntryBase = {
    id: raw.id as string,
    gridX: raw.gridX as number,
    gridY: raw.gridY as number,
    heightUnits: raw.heightUnits as number,
    stackingLip: raw.stackingLip as boolean,
    magnetHoles: raw.magnetHoles as boolean,
    labelText: raw.labelText as string,
    labelText2: (raw.labelText2 as string | undefined) ?? '',
    labelIcon: raw.labelIcon as string | null,
    quantity: raw.quantity as number,
    createdAt: raw.createdAt as string,
  };
  if (raw.notes !== undefined) base.notes = raw.notes as string;
  const kind = resolveKind(raw);
  if (kind === 'traced') {
    const traced: BinEntry = {
      ...base,
      kind,
      pockets: pickPockets(raw.pockets as Record<string, unknown>),
    };
    assignTraceSource(traced, raw);
    return traced;
  }
  const dividerCountX = (raw.dividerCountX as number | undefined) ?? 0;
  const dividerCountY = (raw.dividerCountY as number | undefined) ?? 0;
  if (kind === 'screw') {
    return {
      ...base,
      kind,
      dividerCountX,
      dividerCountY,
      screw: pickScrew(raw.screw as Record<string, unknown>),
    };
  }
  return { ...base, kind, dividerCountX, dividerCountY };
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
    const traceProblem = validateTraceSource(item, `batch ${id}: item ${item.id}`);
    if (traceProblem !== null) return traceProblem;
    if (item.screw !== undefined) {
      const screwProblem = validateScrew(item.screw, `batch ${id}: item ${item.id}`);
      if (screwProblem !== null) return screwProblem;
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
    assignTraceSource(item, rawItem);
    if (rawItem.screw !== undefined) {
      item.screw = pickScrew(rawItem.screw as Record<string, unknown>);
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
