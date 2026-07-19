import {
  PLAN_FILE_VERSION,
  type BatchItem,
  type Bin,
  type BinPockets,
  type BinWithInsertProduct,
  type LabelContent,
  type PlanFile,
  type PrintBatch,
  type Product,
  type QueueEntry,
  type ScrewBin,
  type ScrewSpec,
  type TracePaper,
} from './types';
import {
  composeLabelText,
  HEAD_ICON_NAME,
  HEAD_TYPES,
  type HeadType,
} from './screwListImport';
import type {
  BrushStroke,
  FingerHole,
  MmPoint,
  PaperCorners,
  PaperKind,
  SamPoint,
  TracedTool,
  ToolPlacement,
} from '../trace/types';
import { DEFAULT_MIN_HOLE_WIDTH_MM } from '../trace/layoutModel';

/** Result of parsing a plan file: either the plan or a user-worded error. */
export type PlanParseResult =
  | { ok: true; plan: PlanFile; warnings: string[] }
  | { ok: false; error: string };

function isPositiveInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
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
 * offending part, prefixed with the given subject.
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
    // minHoleWidthMm and filledHoleIndices were added after the first traced
    // entries shipped; older plans omit them, so undefined is accepted and
    // defaulted (the default width, no filled holes) on load.
    if (tool.minHoleWidthMm !== undefined) {
      if (!isFiniteNumber(tool.minHoleWidthMm) || tool.minHoleWidthMm < 0) {
        return `${subject}: pocket tool ${tool.id}: minHoleWidthMm must be a number of at least 0`;
      }
    }
    if (tool.filledHoleIndices !== undefined) {
      const holeCount = (outline.holes as unknown[]).length;
      if (
        !Array.isArray(tool.filledHoleIndices) ||
        !tool.filledHoleIndices.every(
          (i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < holeCount,
        )
      ) {
        return `${subject}: pocket tool ${tool.id}: filledHoleIndices must be whole numbers referring to the tool's holes`;
      }
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
    // brushStrokes were added with the mask-painting tool, after the first
    // traced entries shipped; older plans omit them, so undefined is accepted.
    if (tool.brushStrokes !== undefined) {
      if (!Array.isArray(tool.brushStrokes)) {
        return `${subject}: pocket tool ${tool.id}: brushStrokes must be a list`;
      }
      for (const rawStroke of tool.brushStrokes) {
        const stroke = rawStroke as Record<string, unknown> | null;
        if (
          typeof stroke !== 'object' ||
          stroke === null ||
          (stroke.mode !== 'add' && stroke.mode !== 'erase' && stroke.mode !== 'smooth') ||
          !isFiniteNumber(stroke.radiusMm) ||
          (stroke.radiusMm as number) <= 0 ||
          !Array.isArray(stroke.points)
        ) {
          return `${subject}: pocket tool ${tool.id}: a brush stroke needs mode add, erase or smooth, a radiusMm above 0 and a points list`;
        }
        for (const rawPt of stroke.points as unknown[]) {
          const pt = rawPt as Record<string, unknown> | null;
          if (typeof pt !== 'object' || pt === null || !isFiniteNumber(pt.x) || !isFiniteNumber(pt.y)) {
            return `${subject}: pocket tool ${tool.id}: a brush stroke point needs x and y`;
          }
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
      ...(tool.brushStrokes !== undefined
        ? {
            brushStrokes: (tool.brushStrokes as BrushStroke[]).map((s) => ({
              mode: s.mode,
              radiusMm: s.radiusMm,
              points: s.points.map((p) => ({ x: p.x, y: p.y })),
            })),
          }
        : {}),
      rotationDeg: tool.rotationDeg as number,
      offsetMm: tool.offsetMm as number,
      mirrored: tool.mirrored as boolean,
      minHoleWidthMm: (tool.minHoleWidthMm as number | undefined) ?? DEFAULT_MIN_HOLE_WIDTH_MM,
      filledHoleIndices: ((tool.filledHoleIndices as number[] | undefined) ?? []).slice(),
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
 * raw traced bin. Returns null when they are valid or absent, otherwise a
 * message naming the first offending part. Plans from other devices simply
 * omit both; the bin is then layout-only editable.
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

/** Copies the optional trace-source fields onto a validated traced bin. */
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

// ---------------------------------------------------------------------------
// Version 3 validation: entries and batch items carry a Product.
// ---------------------------------------------------------------------------

/** Validates the LabelContent fields on a raw object. */
function validateContent(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: label content must be an object`;
  }
  const content = raw as Record<string, unknown>;
  if (typeof content.text !== 'string') {
    return `${subject}: label text must be a string`;
  }
  if (typeof content.text2 !== 'string') {
    return `${subject}: label text2 must be a string`;
  }
  if (content.icon !== null && typeof content.icon !== 'string') {
    return `${subject}: label icon must be a string or null`;
  }
  return null;
}

/** Copies only the LabelContent fields from a validated raw object. */
function pickContent(raw: Record<string, unknown>): LabelContent {
  return {
    text: raw.text as string,
    text2: raw.text2 as string,
    icon: raw.icon as string | null,
  };
}

/** Validates the BinEnvelope fields plus the origin-specific bin fields. */
function validateBin(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: bin must be an object`;
  }
  const bin = raw as Record<string, unknown>;
  if (!isPositiveInteger(bin.gridX, 1)) {
    return `${subject}: gridX must be an integer of at least 1`;
  }
  if (!isPositiveInteger(bin.gridY, 1)) {
    return `${subject}: gridY must be an integer of at least 1`;
  }
  if (!isPositiveInteger(bin.heightUnits, 2)) {
    return `${subject}: heightUnits must be an integer of at least 2`;
  }
  if (typeof bin.magnetHoles !== 'boolean') {
    return `${subject}: magnetHoles must be true or false`;
  }
  if (bin.origin === 'manual' || bin.origin === 'screw') {
    if (!isPositiveInteger(bin.dividerCountX, 0)) {
      return `${subject}: dividerCountX must be an integer of at least 0`;
    }
    if (!isPositiveInteger(bin.dividerCountY, 0)) {
      return `${subject}: dividerCountY must be an integer of at least 0`;
    }
    if (bin.origin === 'screw') {
      return validateScrew(bin.screw, subject);
    }
    return null;
  }
  if (bin.origin === 'traced') {
    if (bin.dividerCountX !== undefined || bin.dividerCountY !== undefined) {
      return `${subject}: a traced bin cannot have divider walls`;
    }
    const pocketsProblem = validatePockets(bin.pockets, subject);
    if (pocketsProblem !== null) return pocketsProblem;
    return validateTraceSource(bin, subject);
  }
  return `${subject}: bin origin must be manual, screw or traced`;
}

/** Copies only the known Bin fields from a validated raw object. */
function pickBin(raw: Record<string, unknown>): Bin {
  const envelope = {
    gridX: raw.gridX as number,
    gridY: raw.gridY as number,
    heightUnits: raw.heightUnits as number,
    magnetHoles: raw.magnetHoles as boolean,
  };
  if (raw.origin === 'traced') {
    const bin: Bin = {
      ...envelope,
      origin: 'traced',
      pockets: pickPockets(raw.pockets as Record<string, unknown>),
    };
    assignTraceSource(bin, raw);
    return bin;
  }
  const dividers = {
    dividerCountX: raw.dividerCountX as number,
    dividerCountY: raw.dividerCountY as number,
  };
  if (raw.origin === 'screw') {
    return {
      ...envelope,
      ...dividers,
      origin: 'screw',
      screw: pickScrew(raw.screw as Record<string, unknown>),
    };
  }
  return { ...envelope, ...dividers, origin: 'manual' };
}

/**
 * Repairs a screw-origin bin that was stored without its label insert. A
 * screw bin exists to carry the label naming its fastener, so ordering one
 * bare is no longer representable; the insert is added back with the label
 * the entry's own screw description composes. Earlier versions of the app
 * could store such a row, so plans in localStorage and exported files still
 * hold them and must load rather than be rejected.
 */
function repairScrewBinAlone(
  bin: ScrewBin,
  subject: string,
  warnings: string[],
): BinWithInsertProduct {
  const insert: LabelContent = {
    text: composeLabelText(
      bin.screw.thread,
      bin.screw.lengthMm,
      bin.screw.head,
      bin.screw.enteredLengthText,
    ),
    text2: '',
    icon: bin.screw.head !== null ? HEAD_ICON_NAME[bin.screw.head] : null,
  };
  warnings.push(
    `${subject} was a screw bin ordered without its label insert; the insert was added back with the label "${insert.text}", because a screw bin is printed to carry that label.`,
  );
  return { kind: 'binWithInsert', bin, insert };
}

/**
 * A bin ordered without an insert, with the screw-origin repair applied. The
 * single place that turns a bare bin into a product, so every load path
 * (current and legacy) repairs the same way.
 */
function binAloneProduct(
  bin: Bin,
  labelSlot: boolean,
  subject: string,
  warnings: string[],
): Product {
  if (bin.origin === 'screw') return repairScrewBinAlone(bin, subject, warnings);
  return { kind: 'bin', bin, labelSlot };
}

/** Validates a raw value as a Product. */
export function validateProduct(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: product must be an object`;
  }
  const product = raw as Record<string, unknown>;
  if (product.kind === 'bin') {
    // labelSlot was added after the first version-3 plans shipped; older
    // files simply omit it, so undefined is accepted and means slotted.
    if (product.labelSlot !== undefined && typeof product.labelSlot !== 'boolean') {
      return `${subject}: labelSlot must be true or false`;
    }
    return validateBin(product.bin, subject);
  }
  if (product.kind === 'binWithInsert') {
    const binProblem = validateBin(product.bin, subject);
    if (binProblem !== null) return binProblem;
    // fused was added after the first binWithInsert plans shipped; older files
    // omit it, so undefined is accepted and means the swappable insert.
    if (product.fused !== undefined && typeof product.fused !== 'boolean') {
      return `${subject}: fused must be true or false`;
    }
    return validateContent(product.insert, subject);
  }
  if (product.kind === 'insert') {
    if (product.origin !== 'manual' && product.origin !== 'screw') {
      return `${subject}: an insert product's origin must be manual or screw`;
    }
    if (!isPositiveInteger(product.cells, 1)) {
      return `${subject}: cells must be an integer of at least 1`;
    }
    const contentProblem = validateContent(product.content, subject);
    if (contentProblem !== null) return contentProblem;
    if (product.origin === 'screw') {
      return validateScrew(product.screw, subject);
    }
    return null;
  }
  return `${subject}: product kind must be bin, binWithInsert or insert`;
}

/**
 * Copies only the known Product fields from a validated raw object, applying
 * the screw-origin bare-bin repair and appending its warning.
 */
export function pickProduct(
  raw: Record<string, unknown>,
  subject: string,
  warnings: string[],
): Product {
  if (raw.kind === 'bin') {
    return binAloneProduct(
      pickBin(raw.bin as Record<string, unknown>),
      (raw.labelSlot as boolean | undefined) ?? true,
      subject,
      warnings,
    );
  }
  if (raw.kind === 'binWithInsert') {
    const product: Product = {
      kind: 'binWithInsert',
      bin: pickBin(raw.bin as Record<string, unknown>),
      insert: pickContent(raw.insert as Record<string, unknown>),
    };
    if (raw.fused === true) product.fused = true;
    return product;
  }
  const base = {
    kind: 'insert' as const,
    cells: raw.cells as number,
    content: pickContent(raw.content as Record<string, unknown>),
  };
  if (raw.origin === 'screw') {
    return { ...base, origin: 'screw', screw: pickScrew(raw.screw as Record<string, unknown>) };
  }
  return { ...base, origin: 'manual' };
}

/**
 * Validates one raw object as a version-3 QueueEntry. Returns null when it is
 * valid, otherwise a message naming the first offending field.
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
  if (!isPositiveInteger(entry.quantity, 1)) {
    return `entry ${id}: quantity must be an integer of at least 1`;
  }
  if (!isIsoTimestamp(entry.createdAt)) {
    return `entry ${id}: createdAt must be an ISO 8601 timestamp`;
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    return `entry ${id}: notes must be a string`;
  }
  return validateProduct(entry.product, `entry ${id}`);
}

/** Copies only the known QueueEntry fields from a validated raw object. */
function pickEntry(raw: Record<string, unknown>, warnings: string[]): QueueEntry {
  const entry: QueueEntry = {
    id: raw.id as string,
    quantity: raw.quantity as number,
    createdAt: raw.createdAt as string,
    product: pickProduct(
      raw.product as Record<string, unknown>,
      `entry ${String(raw.id)}`,
      warnings,
    ),
  };
  if (raw.notes !== undefined) entry.notes = raw.notes as string;
  return entry;
}

/**
 * Validates one raw object as a version-3 PrintBatch. Returns null when it is
 * valid, otherwise a message naming the first offending field.
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
    const productProblem = validateProduct(item.product, `batch ${id}: item ${item.id}`);
    if (productProblem !== null) return productProblem;
    if (!isPositiveInteger(item.count, 1)) {
      return `batch ${id}: item ${item.id}: count must be an integer of at least 1`;
    }
    if (item.sourceEntryId !== undefined && typeof item.sourceEntryId !== 'string') {
      return `batch ${id}: item ${item.id}: sourceEntryId must be a string`;
    }
  }
  return null;
}

/** Copies only the known PrintBatch fields from a validated raw object. */
function pickBatch(raw: Record<string, unknown>, warnings: string[]): PrintBatch {
  const items = (raw.items as Record<string, unknown>[]).map((rawItem) => {
    const item: BatchItem = {
      id: rawItem.id as string,
      product: pickProduct(
        rawItem.product as Record<string, unknown>,
        `batch ${String(raw.id)}: item ${String(rawItem.id)}`,
        warnings,
      ),
      count: rawItem.count as number,
    };
    if (rawItem.sourceEntryId !== undefined) {
      item.sourceEntryId = rawItem.sourceEntryId as string;
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

// ---------------------------------------------------------------------------
// Versions 1 and 2: flat entries with labelText/labelIcon/labelMode fields.
// Read-only support so existing plans convert on load; never written.
// ---------------------------------------------------------------------------

/** Validates the flat design-parameter fields of a version-1/2 entry. */
function validateLegacyParams(entry: Record<string, unknown>, subject: string): string | null {
  if (!isPositiveInteger(entry.gridX, 1)) {
    return `${subject}: gridX must be an integer of at least 1`;
  }
  if (!isPositiveInteger(entry.gridY, 1)) {
    return `${subject}: gridY must be an integer of at least 1`;
  }
  if (!isPositiveInteger(entry.heightUnits, 2)) {
    return `${subject}: heightUnits must be an integer of at least 2`;
  }
  if (typeof entry.magnetHoles !== 'boolean') {
    return `${subject}: magnetHoles must be true or false`;
  }
  if (entry.dividerCountX !== undefined && !isPositiveInteger(entry.dividerCountX, 0)) {
    return `${subject}: dividerCountX must be an integer of at least 0`;
  }
  if (entry.dividerCountY !== undefined && !isPositiveInteger(entry.dividerCountY, 0)) {
    return `${subject}: dividerCountY must be an integer of at least 0`;
  }
  if (typeof entry.labelText !== 'string') {
    return `${subject}: labelText must be a string`;
  }
  if (entry.labelText2 !== undefined && typeof entry.labelText2 !== 'string') {
    return `${subject}: labelText2 must be a string`;
  }
  if (entry.labelIcon !== null && typeof entry.labelIcon !== 'string') {
    return `${subject}: labelIcon must be a string or null`;
  }
  if (
    entry.labelMode !== undefined &&
    entry.labelMode !== 'embossed' &&
    entry.labelMode !== 'slot' &&
    entry.labelMode !== 'slot-insert' &&
    entry.labelMode !== 'insert'
  ) {
    return `${subject}: labelMode must be embossed, slot, slot-insert or insert`;
  }
  return null;
}

/**
 * Resolves a legacy entry's kind. Entries written before the discriminated
 * union carry no kind field; they resolve as traced when they have pockets
 * and as manual otherwise.
 */
function resolveLegacyKind(entry: Record<string, unknown>): 'manual' | 'screw' | 'traced' {
  if (entry.kind === 'manual' || entry.kind === 'screw' || entry.kind === 'traced') {
    return entry.kind;
  }
  return entry.pockets !== undefined ? 'traced' : 'manual';
}

/** Validates one raw object as a version-1/2 flat entry. */
function validateLegacyEntry(raw: unknown): string | null {
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
  const paramsProblem = validateLegacyParams(entry, `entry ${id}`);
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
  const kind = resolveLegacyKind(entry);
  if (kind === 'traced') {
    if (entry.pockets === undefined) {
      return `entry ${id}: a traced entry must have pockets`;
    }
    const pocketsProblem = validatePockets(entry.pockets, `entry ${id}`);
    if (pocketsProblem !== null) return pocketsProblem;
    return validateTraceSource(entry, `entry ${id}`);
  }
  if (entry.pockets !== undefined) {
    return `entry ${id}: only a traced entry can have pockets`;
  }
  if (kind === 'screw') {
    return validateScrew(entry.screw, `entry ${id}`);
  }
  return null;
}

/**
 * Converts the flat fields of a validated legacy entry or batch item into a
 * Product. The four legacy label modes map as: embossed and slot-insert both
 * become a bin with its insert (embossed labels no longer exist, so an
 * embossed label's content moves onto the swappable insert), slot becomes a
 * bin alone, and insert becomes a standalone insert as wide as the bin was.
 * A warning is appended when the conversion drops data.
 */
function legacyProductOf(
  raw: Record<string, unknown>,
  kind: 'manual' | 'screw' | 'traced',
  subject: string,
  warnings: string[],
): Product {
  const content: LabelContent = {
    text: raw.labelText as string,
    text2: (raw.labelText2 as string | undefined) ?? '',
    icon: raw.labelIcon as string | null,
  };
  const hasContent = content.text.trim() !== '' || content.text2.trim() !== '' || content.icon !== null;
  const mode = (raw.labelMode as string | undefined) ?? 'embossed';
  if (mode === 'insert') {
    if (kind === 'traced') {
      warnings.push(
        `${subject} was an insert-only entry that still carried tool pockets; the pockets were dropped, because an insert has no interior to hold them.`,
      );
    }
    const base = { kind: 'insert' as const, cells: raw.gridX as number, content };
    if (kind === 'screw') {
      return { ...base, origin: 'screw', screw: pickScrew(raw.screw as Record<string, unknown>) };
    }
    return { ...base, origin: 'manual' };
  }
  const envelope = {
    gridX: raw.gridX as number,
    gridY: raw.gridY as number,
    heightUnits: raw.heightUnits as number,
    magnetHoles: raw.magnetHoles as boolean,
  };
  let bin: Bin;
  if (kind === 'traced') {
    bin = {
      ...envelope,
      origin: 'traced',
      pockets: pickPockets(raw.pockets as Record<string, unknown>),
    };
    assignTraceSource(bin, raw);
  } else {
    const dividers = {
      dividerCountX: (raw.dividerCountX as number | undefined) ?? 0,
      dividerCountY: (raw.dividerCountY as number | undefined) ?? 0,
    };
    bin =
      kind === 'screw'
        ? {
            ...envelope,
            ...dividers,
            origin: 'screw',
            screw: pickScrew(raw.screw as Record<string, unknown>),
          }
        : { ...envelope, ...dividers, origin: 'manual' };
  }
  // slot stays a slotted bin alone; embossed and slot-insert keep their
  // label as the paired insert; an embossed entry that never had a label was
  // physically a plain bin with no label feature, so it converts slot-less.
  if (mode === 'slot') {
    const product = binAloneProduct(bin, true, subject, warnings);
    // A repaired screw bin keeps a label, so only a bin that really ends up
    // without one loses its stored text.
    if (hasContent && product.kind === 'bin') {
      warnings.push(
        `${subject} was a slotted bin that still carried unused label text; the text was dropped, because a bin without its insert has no label.`,
      );
    }
    return product;
  }
  if (mode === 'embossed' && !hasContent) {
    return binAloneProduct(bin, false, subject, warnings);
  }
  return { kind: 'binWithInsert', bin, insert: content };
}

/** Converts one validated legacy entry into a version-3 QueueEntry. */
function pickLegacyEntry(raw: Record<string, unknown>, warnings: string[]): QueueEntry {
  const kind = resolveLegacyKind(raw);
  const entry: QueueEntry = {
    id: raw.id as string,
    quantity: raw.quantity as number,
    createdAt: raw.createdAt as string,
    product: legacyProductOf(raw, kind, `entry ${String(raw.id)}`, warnings),
  };
  if (raw.notes !== undefined) entry.notes = raw.notes as string;
  return entry;
}

/** Validates one raw object as a version-2 PrintBatch with flat item params. */
function validateLegacyBatch(raw: unknown): string | null {
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
    const paramsProblem = validateLegacyParams(
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

/** Converts one validated legacy batch into a version-3 PrintBatch. */
function pickLegacyBatch(raw: Record<string, unknown>, warnings: string[]): PrintBatch {
  const items = (raw.items as Record<string, unknown>[]).map((rawItem) => {
    // A legacy batch item marks its origin through its optional snapshot
    // fields: pockets means traced, a screw means screw, plain means manual.
    const kind =
      rawItem.pockets !== undefined ? 'traced' : rawItem.screw !== undefined ? 'screw' : 'manual';
    const flat: Record<string, unknown> = {
      ...(rawItem.params as Record<string, unknown>),
      pockets: rawItem.pockets,
      screw: rawItem.screw,
      traceSourceId: rawItem.traceSourceId,
      paper: rawItem.paper,
    };
    const item: BatchItem = {
      id: rawItem.id as string,
      product: legacyProductOf(
        flat,
        kind,
        `batch ${String(raw.id)}: item ${String(rawItem.id)}`,
        warnings,
      ),
      count: rawItem.count as number,
    };
    if (rawItem.sourceEntryId !== undefined) {
      item.sourceEntryId = rawItem.sourceEntryId as string;
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

// ---------------------------------------------------------------------------
// Parse, serialize, merge.
// ---------------------------------------------------------------------------

/**
 * Parses and validates plan JSON text (from a file or localStorage).
 * Rejects malformed input with a user-worded error; never drops entries
 * silently.
 *
 * Older versions are read and converted: version-1 files (per-entry status,
 * no batches) drop their entries with status "printed" (the plan keeps no
 * history of finished prints), and version-1/2 flat entries convert to
 * products (see legacyProductOf). Conversions that lose data append a
 * user-worded warning to the result.
 *
 * Current-version plans are repaired rather than rejected where a row is no
 * longer representable: a screw bin stored without its label insert gets the
 * insert back (see repairScrewBinAlone), also with a warning.
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
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > PLAN_FILE_VERSION
  ) {
    return {
      ok: false,
      error: `The file has plan version ${String(envelope.version)}, but this app reads versions 1 to ${PLAN_FILE_VERSION}.`,
    };
  }
  if (!Array.isArray(envelope.entries)) {
    return { ok: false, error: 'The plan is missing its entries list.' };
  }
  // Versions 1 and 2 carry flat design fields per entry and convert through
  // the legacy path. Version 3 already has the current product/bin shape and
  // differs from version 4 only by the removed stacking-lip flag, which the
  // validators and pickers now ignore, so it reads through the current path.
  const legacy = version === 1 || version === 2;
  const warnings: string[] = [];
  const entries: QueueEntry[] = [];
  const seen = new Set<string>();
  for (const item of envelope.entries) {
    const problem = legacy ? validateLegacyEntry(item) : validateEntry(item);
    if (problem !== null) {
      return { ok: false, error: `The plan is invalid: ${problem}.` };
    }
    const rawEntry = item as Record<string, unknown>;
    if (version === 1 && rawEntry.status === 'printed') continue;
    const entry = legacy ? pickLegacyEntry(rawEntry, warnings) : pickEntry(rawEntry, warnings);
    if (seen.has(entry.id)) {
      return { ok: false, error: `The plan is invalid: entry id ${entry.id} appears twice.` };
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  const batches: PrintBatch[] = [];
  if (version !== 1) {
    if (!Array.isArray(envelope.batches)) {
      return { ok: false, error: 'The plan is missing its batches list.' };
    }
    const seenBatchIds = new Set<string>();
    for (const item of envelope.batches) {
      const problem = legacy ? validateLegacyBatch(item) : validateBatch(item);
      if (problem !== null) {
        return { ok: false, error: `The plan is invalid: ${problem}.` };
      }
      const batch = legacy
        ? pickLegacyBatch(item as Record<string, unknown>, warnings)
        : pickBatch(item as Record<string, unknown>, warnings);
      if (seenBatchIds.has(batch.id)) {
        return { ok: false, error: `The plan is invalid: batch id ${batch.id} appears twice.` };
      }
      seenBatchIds.add(batch.id);
      batches.push(batch);
    }
  }
  return { ok: true, plan: { version: PLAN_FILE_VERSION, entries, batches }, warnings };
}

/** Serializes a plan to pretty-printed JSON for export or persistence. */
export function serializePlanFile(entries: QueueEntry[], batches: PrintBatch[]): string {
  const plan: PlanFile = { version: PLAN_FILE_VERSION, entries, batches };
  return JSON.stringify(plan, null, 2);
}

/**
 * Merges imported entries into existing ones. An imported entry with the same
 * id replaces the existing one; all others are appended in file order.
 */
export function mergeEntries(existing: QueueEntry[], imported: QueueEntry[]): QueueEntry[] {
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
