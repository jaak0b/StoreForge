import {
  PLAN_FILE_VERSION,
  type BaseplateProduct,
  type BatchItem,
  type Bin,
  type BinPockets,
  type BinWithInsertProduct,
  type CutoutModel,
  type LabelContent,
  type ModelPlacement,
  type PlanFile,
  type PrintBatch,
  type Product,
  type QueueEntry,
  type ScrewBin,
  type ScrewSpec,
  type TracePaper,
  type DividerWall,
} from './types';
import { evenDividerWalls } from '../gridfinity/dividerModel';
import { PITCH } from '../gridfinity/constants';
import {
  BASEPLATE_UNITS_MAX,
  CLIP_TOLERANCE_MAX,
  CLIP_TOLERANCE_MIN,
  CUSTOM_SPAN_MIN,
  MAGNET_DIAMETER_MAX,
  MAGNET_DIAMETER_MIN,
  MAGNET_HEIGHT_MAX,
  MAGNET_HEIGHT_MIN,
  type BaseplateMagnets,
} from '../baseplate/constants';
import {
  DEFAULT_CUTOUT_CLEARANCE_MM,
  DEFAULT_DRAFT_ANGLE_DEG,
  isDraftAngleDegValid,
  maxClearanceMm,
} from '../cutout/cutoutBin';
import { MAX_TRIANGLES } from '../cutout/stlReader';
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

/*
 * Validation message convention. Every validator returns null when the value
 * is valid, otherwise a message made of an optional lowercase subject prefix
 * naming the offending row (`entry a1: `, `batch b1: item i1: `, and nested
 * `pocket tool t1: ` / `cutout model m1: `) followed by exactly one complete
 * sentence: it starts with a capital letter, names the field in the words the
 * app shows the user rather than the JSON identifier, states what is expected,
 * and ends with a full stop. Callers that wrap the message therefore add no
 * punctuation of their own.
 */

/** Result of parsing a plan file: either the plan or a user-worded error. */
export type PlanParseResult =
  | { ok: true; plan: PlanFile; warnings: string[] }
  | { ok: false; error: string };

function isPositiveInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
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
    return `${subject}: The tool pockets must be an object.`;
  }
  const pockets = raw as Record<string, unknown>;
  if (!Array.isArray(pockets.tools)) {
    return `${subject}: The tool pockets are missing their list of tools.`;
  }
  const toolIds = new Set<string>();
  for (const rawTool of pockets.tools) {
    if (typeof rawTool !== 'object' || rawTool === null || Array.isArray(rawTool)) {
      return `${subject}: A pocket tool is not an object.`;
    }
    const tool = rawTool as Record<string, unknown>;
    if (typeof tool.id !== 'string' || tool.id.length === 0) {
      return `${subject}: A pocket tool is missing its id.`;
    }
    if (toolIds.has(tool.id)) {
      return `${subject}: The pocket tool id ${tool.id} appears twice.`;
    }
    toolIds.add(tool.id);
    if (typeof tool.name !== 'string') {
      return `${subject}: pocket tool ${tool.id}: The tool name must be text.`;
    }
    const outline = tool.outline as Record<string, unknown> | null | undefined;
    if (typeof outline !== 'object' || outline === null || Array.isArray(outline)) {
      return `${subject}: pocket tool ${tool.id}: The outline must be an object.`;
    }
    if (!isMmPointList(outline.outer) || (outline.outer as MmPoint[]).length < 3) {
      return `${subject}: pocket tool ${tool.id}: The outline needs at least 3 outer points.`;
    }
    if (
      !Array.isArray(outline.holes) ||
      !outline.holes.every((loop) => isMmPointList(loop) && loop.length >= 3)
    ) {
      return `${subject}: pocket tool ${tool.id}: Each outline hole must be a list of points.`;
    }
    if (!isFiniteNumber(tool.rotationDeg)) {
      return `${subject}: pocket tool ${tool.id}: The rotation angle must be a number.`;
    }
    if (!isFiniteNumber(tool.offsetMm) || tool.offsetMm < 0) {
      return `${subject}: pocket tool ${tool.id}: The outline offset must be a number of at least 0 mm.`;
    }
    if (typeof tool.mirrored !== 'boolean') {
      return `${subject}: pocket tool ${tool.id}: The mirrored setting must be true or false.`;
    }
    // minHoleWidthMm and filledHoleIndices were added after the first traced
    // entries shipped; older plans omit them, so undefined is accepted and
    // defaulted (the default width, no filled holes) on load.
    if (tool.minHoleWidthMm !== undefined) {
      if (!isFiniteNumber(tool.minHoleWidthMm) || tool.minHoleWidthMm < 0) {
        return `${subject}: pocket tool ${tool.id}: The minimum hole width must be a number of at least 0 mm.`;
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
        return `${subject}: pocket tool ${tool.id}: The filled hole list must contain whole numbers referring to the tool's own holes.`;
      }
    }
    // clicks were added after the first traced entries shipped; older plans
    // simply omit them, so undefined is accepted and defaulted to an empty list.
    if (tool.clicks !== undefined) {
      if (!Array.isArray(tool.clicks)) {
        return `${subject}: pocket tool ${tool.id}: The clicks must be a list.`;
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
          return `${subject}: pocket tool ${tool.id}: A click needs an x, a y and a label of 0 or 1.`;
        }
      }
    }
    // brushStrokes were added with the mask-painting tool, after the first
    // traced entries shipped; older plans omit them, so undefined is accepted.
    if (tool.brushStrokes !== undefined) {
      if (!Array.isArray(tool.brushStrokes)) {
        return `${subject}: pocket tool ${tool.id}: The brush strokes must be a list.`;
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
          return `${subject}: pocket tool ${tool.id}: A brush stroke needs a mode of add, erase or smooth, a radius above 0 mm and a list of points.`;
        }
        for (const rawPt of stroke.points as unknown[]) {
          const pt = rawPt as Record<string, unknown> | null;
          if (typeof pt !== 'object' || pt === null || !isFiniteNumber(pt.x) || !isFiniteNumber(pt.y)) {
            return `${subject}: pocket tool ${tool.id}: A brush stroke point needs an x and a y.`;
          }
        }
      }
    }
    if (!Array.isArray(tool.fingerHoles)) {
      return `${subject}: pocket tool ${tool.id}: The finger holes must be a list.`;
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
        return `${subject}: pocket tool ${tool.id}: A finger hole needs an x, a y and a diameter above 0 mm.`;
      }
      if (
        (hole.x2 !== undefined || hole.y2 !== undefined) &&
        (!isFiniteNumber(hole.x2) || !isFiniteNumber(hole.y2))
      ) {
        return `${subject}: pocket tool ${tool.id}: An elongated finger hole needs its second point, so x2 and y2 must both be numbers.`;
      }
    }
  }
  if (!Array.isArray(pockets.placements)) {
    return `${subject}: The tool pockets are missing their list of placements.`;
  }
  for (const rawPlacement of pockets.placements) {
    const placement = rawPlacement as Record<string, unknown> | null;
    if (typeof placement !== 'object' || placement === null) {
      return `${subject}: A pocket placement is not an object.`;
    }
    if (typeof placement.toolId !== 'string' || !toolIds.has(placement.toolId)) {
      return `${subject}: A pocket placement refers to a tool that is not in the pockets.`;
    }
    if (
      !isFiniteNumber(placement.xMm) ||
      !isFiniteNumber(placement.yMm) ||
      !isFiniteNumber(placement.pocketDepthMm) ||
      placement.pocketDepthMm <= 0
    ) {
      return `${subject}: A pocket placement needs an x, a y and a pocket depth above 0 mm.`;
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

/** The six placement fields, in the order the validator reports them. */
const PLACEMENT_KEYS = ['xMm', 'yMm', 'zMm', 'rotXDeg', 'rotYDeg', 'rotZDeg'] as const;

/**
 * Validates a raw value as a cutout bin's list of carved models. Returns null
 * when it is valid, otherwise a message naming the first offending field.
 *
 * The bin's own gridX and gridY are taken because the clearance ceiling
 * depends on them: a clearance dilates the model in every direction, so the
 * largest one a bin can hold is half its narrowest interior dimension. The
 * message then names the limit this bin actually allows rather than saying the
 * value is merely wrong, as the pocket depth message does.
 *
 * The model's triangles are deliberately not part of the plan: only the
 * metadata is, so a reader holding the JSON without the bytes can still list,
 * describe and validate the bin.
 */
export function validateCutoutModels(
  raw: unknown,
  subject: string,
  gridX: number,
  gridY: number,
): string | null {
  if (!Array.isArray(raw)) {
    return `${subject}: The models must be a list.`;
  }
  const modelIds = new Set<string>();
  for (const rawModel of raw) {
    if (typeof rawModel !== 'object' || rawModel === null || Array.isArray(rawModel)) {
      return `${subject}: A cutout model is not an object.`;
    }
    const model = rawModel as Record<string, unknown>;
    if (typeof model.id !== 'string' || model.id.length === 0) {
      return `${subject}: A cutout model is missing its id.`;
    }
    const id = model.id;
    if (modelIds.has(id)) {
      return `${subject}: The cutout model id ${id} appears twice.`;
    }
    modelIds.add(id);
    if (typeof model.name !== 'string') {
      return `${subject}: cutout model ${id}: The model name must be text.`;
    }
    if (typeof model.modelSourceId !== 'string' || model.modelSourceId.length === 0) {
      return `${subject}: cutout model ${id}: The model source id must be text that is not empty.`;
    }
    if (!isPositiveInteger(model.triangleCount, 1)) {
      return `${subject}: cutout model ${id}: The triangle count must be a whole number of at least 1.`;
    }
    if (model.triangleCount > MAX_TRIANGLES) {
      return `${subject}: cutout model ${id}: The triangle count must not exceed ${MAX_TRIANGLES}.`;
    }
    // unitScale, sizeMm, clearanceMm, sweepEnabled and draftAngleDeg are
    // accepted as absent and defaulted on pick, so a plan written before each
    // of them existed still loads.
    if (model.unitScale !== undefined) {
      if (!isFiniteNumber(model.unitScale) || model.unitScale <= 0) {
        return `${subject}: cutout model ${id}: The unit scale must be a number greater than 0.`;
      }
    }
    if (model.sizeMm !== undefined) {
      const size = model.sizeMm as Record<string, unknown> | null;
      if (
        typeof size !== 'object' ||
        size === null ||
        !isFiniteNumber(size.x) ||
        !isFiniteNumber(size.y) ||
        !isFiniteNumber(size.z)
      ) {
        return `${subject}: cutout model ${id}: The model size needs a finite x, y and z in mm.`;
      }
    }
    const placement = model.placement as Record<string, unknown> | null | undefined;
    if (typeof placement !== 'object' || placement === null || Array.isArray(placement)) {
      return `${subject}: cutout model ${id}: The placement must be an object.`;
    }
    for (const key of PLACEMENT_KEYS) {
      if (!isFiniteNumber(placement[key])) {
        return `${subject}: cutout model ${id}: The placement value ${key} must be a number.`;
      }
    }
    if (model.clearanceMm !== undefined) {
      if (!isFiniteNumber(model.clearanceMm) || model.clearanceMm < 0) {
        return `${subject}: cutout model ${id}: The clearance must be a number of at least 0 mm.`;
      }
      const limit = maxClearanceMm(gridX, gridY);
      if (model.clearanceMm > limit) {
        return (
          `${subject}: cutout model ${id}: The clearance is ${model.clearanceMm} mm, but a bin of ` +
          `${gridX} by ${gridY} grid units allows at most ${limit} mm.`
        );
      }
    }
    if (model.sweepEnabled !== undefined && typeof model.sweepEnabled !== 'boolean') {
      return `${subject}: cutout model ${id}: The sweep option must be true or false.`;
    }
    if (
      model.draftAngleDeg !== undefined &&
      (typeof model.draftAngleDeg !== 'number' ||
        !isDraftAngleDegValid(model.draftAngleDeg))
    ) {
      return (
        `${subject}: cutout model ${id}: The draft angle must be a number from 0 ` +
        'up to but not including 90 degrees.'
      );
    }
  }
  return null;
}

/**
 * Copies only the known CutoutModel fields from a validated raw bin. The
 * fields that were added after the first cutout bins could be written default
 * here: the clearance to the shared default, the unit scale to 1 (which is
 * exactly what a plan written before the field existed meant, since it
 * described a model already treated as millimetres), the size to zeroes,
 * which the next generation recomputes from the model itself, and the sweep
 * to off with a 0 degree draft, which reproduces the exact pockets an older
 * plan described.
 */
export function pickCutoutModels(raw: Record<string, unknown>): CutoutModel[] {
  return (raw.models as Record<string, unknown>[]).map((model): CutoutModel => {
    const placement = model.placement as Record<string, number>;
    const size = model.sizeMm as { x: number; y: number; z: number } | undefined;
    const picked: ModelPlacement = {
      xMm: placement.xMm,
      yMm: placement.yMm,
      zMm: placement.zMm,
      rotXDeg: placement.rotXDeg,
      rotYDeg: placement.rotYDeg,
      rotZDeg: placement.rotZDeg,
    };
    return {
      id: model.id as string,
      name: model.name as string,
      modelSourceId: model.modelSourceId as string,
      triangleCount: model.triangleCount as number,
      unitScale: (model.unitScale as number | undefined) ?? 1,
      sizeMm:
        size !== undefined ? { x: size.x, y: size.y, z: size.z } : { x: 0, y: 0, z: 0 },
      placement: picked,
      clearanceMm: (model.clearanceMm as number | undefined) ?? DEFAULT_CUTOUT_CLEARANCE_MM,
      // Absent means the plan predates the sweep, and its bins were designed
      // with exact pockets: off reproduces exactly the bins it described. A
      // freshly imported model defaults to on instead, but that decision
      // belongs to the import flow, not to the loader.
      sweepEnabled: (model.sweepEnabled as boolean | undefined) ?? false,
      draftAngleDeg: (model.draftAngleDeg as number | undefined) ?? DEFAULT_DRAFT_ANGLE_DEG,
    };
  });
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
      return `${subject}: The trace source id must be text that is not empty.`;
    }
  }
  if (raw.paper !== undefined) {
    if (typeof raw.paper !== 'object' || raw.paper === null || Array.isArray(raw.paper)) {
      return `${subject}: The paper must be an object.`;
    }
    const paper = raw.paper as Record<string, unknown>;
    if (paper.kind !== 'a4' && paper.kind !== 'letter') {
      return `${subject}: The paper kind must be a4 or letter.`;
    }
    const corners = paper.corners as Record<string, unknown> | null | undefined;
    if (typeof corners !== 'object' || corners === null || Array.isArray(corners)) {
      return `${subject}: The paper corners must be an object.`;
    }
    for (const key of CORNER_KEYS) {
      const corner = corners[key] as Record<string, unknown> | null | undefined;
      if (
        typeof corner !== 'object' ||
        corner === null ||
        !isFiniteNumber(corner.x) ||
        !isFiniteNumber(corner.y)
      ) {
        return `${subject}: The paper corner ${key} needs an x and a y coordinate.`;
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
    return `${subject}: The screw must be an object.`;
  }
  const screw = raw as Record<string, unknown>;
  if (typeof screw.thread !== 'string' || screw.thread.length === 0) {
    return `${subject}: The screw thread must be text that is not empty.`;
  }
  if (screw.lengthMm !== null && !isPositiveInteger(screw.lengthMm, 1)) {
    return `${subject}: The screw length must be a whole number of at least 1 mm, or null.`;
  }
  if (screw.head !== null && (typeof screw.head !== 'string' || !HEAD_TYPE_SET.has(screw.head))) {
    return `${subject}: The screw head must be a known head type, or null.`;
  }
  if (
    screw.enteredLengthText !== null &&
    screw.enteredLengthText !== undefined &&
    typeof screw.enteredLengthText !== 'string'
  ) {
    return `${subject}: The screw length as it was typed must be text, or null.`;
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
    return `${subject}: The label content must be an object.`;
  }
  const content = raw as Record<string, unknown>;
  if (typeof content.text !== 'string') {
    return `${subject}: The first label line must be text.`;
  }
  if (typeof content.text2 !== 'string') {
    return `${subject}: The second label line must be text.`;
  }
  if (content.icon !== null && typeof content.icon !== 'string') {
    return `${subject}: The label icon must be text, or null.`;
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

/**
 * Validates a raw value as a list of divider walls (each a segment of finite
 * x1, y1, x2, y2). Returns null when valid, otherwise a message. Geometric
 * validity (containment, minimum length, compartment gaps) is enforced at
 * generation time by the divider model, not on load, so a plan that no longer
 * fits its bin still reads back rather than being rejected.
 */
function validateWallList(raw: unknown, subject: string): string | null {
  if (!Array.isArray(raw)) {
    return `${subject}: The divider walls must be a list.`;
  }
  for (const rawWall of raw) {
    const wall = rawWall as Record<string, unknown> | null;
    if (
      typeof wall !== 'object' ||
      wall === null ||
      !isFiniteNumber(wall.x1) ||
      !isFiniteNumber(wall.y1) ||
      !isFiniteNumber(wall.x2) ||
      !isFiniteNumber(wall.y2)
    ) {
      return `${subject}: A divider wall needs finite x1, y1, x2 and y2 coordinates.`;
    }
  }
  return null;
}

/**
 * The divider walls of a validated raw bin. A version-5 bin carries walls
 * verbatim; a version 1 to 4 bin carries dividerCountX/Y, converted to walls
 * through evenDividerWalls (the single counts-to-walls source). The one place
 * every load path resolves a bin's walls, so old and new plans agree.
 */
function pickWalls(raw: Record<string, unknown>): DividerWall[] {
  if (Array.isArray(raw.walls)) {
    return (raw.walls as Record<string, number>[]).map((wall) => ({
      x1: wall.x1,
      y1: wall.y1,
      x2: wall.x2,
      y2: wall.y2,
    }));
  }
  const countX = (raw.dividerCountX as number | undefined) ?? 0;
  const countY = (raw.dividerCountY as number | undefined) ?? 0;
  return evenDividerWalls(raw.gridX as number, raw.gridY as number, countX, countY);
}

/** Validates the BinEnvelope fields plus the origin-specific bin fields. */
function validateBin(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: The bin must be an object.`;
  }
  const bin = raw as Record<string, unknown>;
  if (!isPositiveInteger(bin.gridX, 1)) {
    return `${subject}: The bin width must be a whole number of at least 1 grid unit.`;
  }
  if (!isPositiveInteger(bin.gridY, 1)) {
    return `${subject}: The bin depth must be a whole number of at least 1 grid unit.`;
  }
  if (!isPositiveInteger(bin.heightUnits, 2)) {
    return `${subject}: The bin height must be a whole number of at least 2 height units.`;
  }
  if (typeof bin.magnetHoles !== 'boolean') {
    return `${subject}: The magnet holes setting must be true or false.`;
  }
  if (bin.origin === 'manual' || bin.origin === 'screw') {
    // Version 5 carries walls; versions 1 to 4 carry dividerCountX/Y. Accept
    // whichever the bin has (converted to walls on pick); neither means none.
    if (bin.walls !== undefined) {
      const wallProblem = validateWallList(bin.walls, subject);
      if (wallProblem !== null) return wallProblem;
    } else {
      if (bin.dividerCountX !== undefined && !isPositiveInteger(bin.dividerCountX, 0)) {
        return `${subject}: The number of dividers across the bin width must be a whole number of at least 0.`;
      }
      if (bin.dividerCountY !== undefined && !isPositiveInteger(bin.dividerCountY, 0)) {
        return `${subject}: The number of dividers across the bin depth must be a whole number of at least 0.`;
      }
    }
    if (bin.origin === 'screw') {
      return validateScrew(bin.screw, subject);
    }
    return null;
  }
  if (bin.origin === 'traced') {
    if (
      bin.walls !== undefined ||
      bin.dividerCountX !== undefined ||
      bin.dividerCountY !== undefined
    ) {
      return `${subject}: A traced bin cannot have divider walls.`;
    }
    const pocketsProblem = validatePockets(bin.pockets, subject);
    if (pocketsProblem !== null) return pocketsProblem;
    return validateTraceSource(bin, subject);
  }
  if (bin.origin === 'cutout') {
    if (
      bin.walls !== undefined ||
      bin.dividerCountX !== undefined ||
      bin.dividerCountY !== undefined
    ) {
      return `${subject}: A cutout bin cannot have divider walls.`;
    }
    return validateCutoutModels(bin.models, subject, bin.gridX, bin.gridY);
  }
  return `${subject}: The bin origin must be manual, screw, traced or cutout.`;
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
  if (raw.origin === 'cutout') {
    return { ...envelope, origin: 'cutout', models: pickCutoutModels(raw) };
  }
  const walls = pickWalls(raw);
  if (raw.origin === 'screw') {
    return {
      ...envelope,
      walls,
      origin: 'screw',
      screw: pickScrew(raw.screw as Record<string, unknown>),
    };
  }
  return { ...envelope, walls, origin: 'manual' };
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

/**
 * Validates a raw value as a baseplate's magnets field: null (no magnets) or
 * an object whose two dimensions sit inside the bounds the baseplate module
 * exports. The bounds are interpolated into the messages, so the validator,
 * the generator and the form sliders provably agree on the same numbers.
 */
function validateMagnets(raw: unknown, subject: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return `${subject}: magnets must be an object or null`;
  }
  const magnets = raw as Record<string, unknown>;
  if (!isNumberInRange(magnets.diameterMm, MAGNET_DIAMETER_MIN, MAGNET_DIAMETER_MAX)) {
    return `${subject}: magnet diameterMm must be a number from ${MAGNET_DIAMETER_MIN} to ${MAGNET_DIAMETER_MAX}`;
  }
  if (!isNumberInRange(magnets.heightMm, MAGNET_HEIGHT_MIN, MAGNET_HEIGHT_MAX)) {
    return `${subject}: magnet heightMm must be a number from ${MAGNET_HEIGHT_MIN} to ${MAGNET_HEIGHT_MAX}`;
  }
  return null;
}

/** Copies only the known BaseplateMagnets fields from a validated raw value. */
function pickMagnets(raw: Record<string, unknown> | null): BaseplateMagnets | null {
  if (raw === null) return null;
  return { diameterMm: raw.diameterMm as number, heightMm: raw.heightMm as number };
}

/**
 * Validates the fields of a raw baseplate product, in the fixed order unitsX,
 * unitsY, customXMm, customYMm, magnets, screwHoles, connectable. The custom
 * spans and the magnets must be present (as a value or an explicit null): no
 * older file contains a baseplate at all, so requiring them costs nothing and
 * catches a truncated write.
 */
function validateBaseplate(raw: Record<string, unknown>, subject: string): string | null {
  if (!isPositiveInteger(raw.unitsX, 1) || raw.unitsX > BASEPLATE_UNITS_MAX) {
    return `${subject}: unitsX must be an integer from 1 to ${BASEPLATE_UNITS_MAX}`;
  }
  if (!isPositiveInteger(raw.unitsY, 1) || raw.unitsY > BASEPLATE_UNITS_MAX) {
    return `${subject}: unitsY must be an integer from 1 to ${BASEPLATE_UNITS_MAX}`;
  }
  if (raw.customXMm !== null && !isNumberInRange(raw.customXMm, CUSTOM_SPAN_MIN, PITCH)) {
    return `${subject}: customXMm must be a number from ${CUSTOM_SPAN_MIN} to ${PITCH}, or null for a full grid cell`;
  }
  if (raw.customYMm !== null && !isNumberInRange(raw.customYMm, CUSTOM_SPAN_MIN, PITCH)) {
    return `${subject}: customYMm must be a number from ${CUSTOM_SPAN_MIN} to ${PITCH}, or null for a full grid cell`;
  }
  const magnetsProblem = validateMagnets(raw.magnets, subject);
  if (magnetsProblem !== null) return magnetsProblem;
  if (typeof raw.screwHoles !== 'boolean') {
    return `${subject}: screwHoles must be true or false`;
  }
  if (typeof raw.connectable !== 'boolean') {
    return `${subject}: connectable must be true or false`;
  }
  return null;
}

/** Validates the fields of a raw connection clip product. */
function validateClip(raw: Record<string, unknown>, subject: string): string | null {
  if (!isNumberInRange(raw.toleranceMm, CLIP_TOLERANCE_MIN, CLIP_TOLERANCE_MAX)) {
    return `${subject}: toleranceMm must be a number from ${CLIP_TOLERANCE_MIN} to ${CLIP_TOLERANCE_MAX}`;
  }
  return null;
}

/**
 * Copies only the known BaseplateProduct fields from a validated raw object,
 * field by field: an unknown extra key in an imported file is dropped, not
 * carried into localStorage.
 */
function pickBaseplate(raw: Record<string, unknown>): BaseplateProduct {
  return {
    kind: 'baseplate',
    unitsX: raw.unitsX as number,
    unitsY: raw.unitsY as number,
    customXMm: raw.customXMm as number | null,
    customYMm: raw.customYMm as number | null,
    magnets: pickMagnets(raw.magnets as Record<string, unknown> | null),
    screwHoles: raw.screwHoles as boolean,
    connectable: raw.connectable as boolean,
  };
}

/** Copies only the known ConnectionClipProduct fields from a validated raw object. */
function pickClip(raw: Record<string, unknown>): Product {
  return { kind: 'clip', toleranceMm: raw.toleranceMm as number };
}

/** Validates a raw value as a Product. */
export function validateProduct(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: The product must be an object.`;
  }
  const product = raw as Record<string, unknown>;
  if (product.kind === 'bin') {
    // labelSlot was added after the first version-3 plans shipped; older
    // files simply omit it, so undefined is accepted and means slotted.
    if (product.labelSlot !== undefined && typeof product.labelSlot !== 'boolean') {
      return `${subject}: The label slot setting must be true or false.`;
    }
    return validateBin(product.bin, subject);
  }
  if (product.kind === 'binWithInsert') {
    const binProblem = validateBin(product.bin, subject);
    if (binProblem !== null) return binProblem;
    // fused was added after the first binWithInsert plans shipped; older files
    // omit it, so undefined is accepted and means the swappable insert.
    if (product.fused !== undefined && typeof product.fused !== 'boolean') {
      return `${subject}: The fused setting must be true or false.`;
    }
    return validateContent(product.insert, subject);
  }
  if (product.kind === 'insert') {
    if (product.origin !== 'manual' && product.origin !== 'screw') {
      return `${subject}: An insert product's origin must be manual or screw.`;
    }
    if (!isPositiveInteger(product.cells, 1)) {
      return `${subject}: The insert width must be a whole number of at least 1 grid unit.`;
    }
    const contentProblem = validateContent(product.content, subject);
    if (contentProblem !== null) return contentProblem;
    if (product.origin === 'screw') {
      return validateScrew(product.screw, subject);
    }
    return null;
  }
  if (product.kind === 'baseplate') {
    return validateBaseplate(product, subject);
  }
  if (product.kind === 'clip') {
    return validateClip(product, subject);
  }
  return `${subject}: product kind must be bin, binWithInsert, insert, baseplate or clip`;
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
  if (raw.kind === 'baseplate') {
    return pickBaseplate(raw);
  }
  if (raw.kind === 'clip') {
    return pickClip(raw);
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
    return 'An entry is not an object.';
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    return 'An entry is missing its id.';
  }
  const id = entry.id;
  if (!isPositiveInteger(entry.quantity, 1)) {
    return `entry ${id}: The quantity must be a whole number of at least 1.`;
  }
  if (!isIsoTimestamp(entry.createdAt)) {
    return `entry ${id}: The creation time must be an ISO 8601 timestamp.`;
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    return `entry ${id}: The notes must be text.`;
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
    return 'A batch is not an object.';
  }
  const batch = raw as Record<string, unknown>;
  if (typeof batch.id !== 'string' || batch.id.length === 0) {
    return 'A batch is missing its id.';
  }
  const id = batch.id;
  if (typeof batch.name !== 'string') {
    return `batch ${id}: The batch name must be text.`;
  }
  if (!isIsoTimestamp(batch.createdAt)) {
    return `batch ${id}: The creation time must be an ISO 8601 timestamp.`;
  }
  if (!Array.isArray(batch.items)) {
    return `batch ${id}: The items must be a list.`;
  }
  for (const rawItem of batch.items) {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
      return `batch ${id}: An item is not an object.`;
    }
    const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return `batch ${id}: An item is missing its id.`;
    }
    const productProblem = validateProduct(item.product, `batch ${id}: item ${item.id}`);
    if (productProblem !== null) return productProblem;
    if (!isPositiveInteger(item.count, 1)) {
      return `batch ${id}: item ${item.id}: The count must be a whole number of at least 1.`;
    }
    if (item.sourceEntryId !== undefined && typeof item.sourceEntryId !== 'string') {
      return `batch ${id}: item ${item.id}: The source entry id must be text.`;
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
    return `${subject}: The bin width must be a whole number of at least 1 grid unit.`;
  }
  if (!isPositiveInteger(entry.gridY, 1)) {
    return `${subject}: The bin depth must be a whole number of at least 1 grid unit.`;
  }
  if (!isPositiveInteger(entry.heightUnits, 2)) {
    return `${subject}: The bin height must be a whole number of at least 2 height units.`;
  }
  if (typeof entry.magnetHoles !== 'boolean') {
    return `${subject}: The magnet holes setting must be true or false.`;
  }
  if (entry.dividerCountX !== undefined && !isPositiveInteger(entry.dividerCountX, 0)) {
    return `${subject}: The number of dividers across the bin width must be a whole number of at least 0.`;
  }
  if (entry.dividerCountY !== undefined && !isPositiveInteger(entry.dividerCountY, 0)) {
    return `${subject}: The number of dividers across the bin depth must be a whole number of at least 0.`;
  }
  if (typeof entry.labelText !== 'string') {
    return `${subject}: The first label line must be text.`;
  }
  if (entry.labelText2 !== undefined && typeof entry.labelText2 !== 'string') {
    return `${subject}: The second label line must be text.`;
  }
  if (entry.labelIcon !== null && typeof entry.labelIcon !== 'string') {
    return `${subject}: The label icon must be text, or null.`;
  }
  if (
    entry.labelMode !== undefined &&
    entry.labelMode !== 'embossed' &&
    entry.labelMode !== 'slot' &&
    entry.labelMode !== 'slot-insert' &&
    entry.labelMode !== 'insert'
  ) {
    return `${subject}: The label mode must be embossed, slot, slot-insert or insert.`;
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
    return 'An entry is not an object.';
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    return 'An entry is missing its id.';
  }
  const id = entry.id;
  if (
    entry.kind !== undefined &&
    entry.kind !== 'manual' &&
    entry.kind !== 'screw' &&
    entry.kind !== 'traced'
  ) {
    return `entry ${id}: The entry kind must be manual, screw or traced.`;
  }
  const paramsProblem = validateLegacyParams(entry, `entry ${id}`);
  if (paramsProblem !== null) return paramsProblem;
  if (!isPositiveInteger(entry.quantity, 1)) {
    return `entry ${id}: The quantity must be a whole number of at least 1.`;
  }
  if (!isIsoTimestamp(entry.createdAt)) {
    return `entry ${id}: The creation time must be an ISO 8601 timestamp.`;
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    return `entry ${id}: The notes must be text.`;
  }
  const kind = resolveLegacyKind(entry);
  if (kind === 'traced') {
    if (entry.pockets === undefined) {
      return `entry ${id}: A traced entry must have tool pockets.`;
    }
    const pocketsProblem = validatePockets(entry.pockets, `entry ${id}`);
    if (pocketsProblem !== null) return pocketsProblem;
    return validateTraceSource(entry, `entry ${id}`);
  }
  if (entry.pockets !== undefined) {
    return `entry ${id}: Only a traced entry can have tool pockets.`;
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
    const walls = pickWalls(raw);
    bin =
      kind === 'screw'
        ? {
            ...envelope,
            walls,
            origin: 'screw',
            screw: pickScrew(raw.screw as Record<string, unknown>),
          }
        : { ...envelope, walls, origin: 'manual' };
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
    return 'A batch is not an object.';
  }
  const batch = raw as Record<string, unknown>;
  if (typeof batch.id !== 'string' || batch.id.length === 0) {
    return 'A batch is missing its id.';
  }
  const id = batch.id;
  if (typeof batch.name !== 'string') {
    return `batch ${id}: The batch name must be text.`;
  }
  if (!isIsoTimestamp(batch.createdAt)) {
    return `batch ${id}: The creation time must be an ISO 8601 timestamp.`;
  }
  if (!Array.isArray(batch.items)) {
    return `batch ${id}: The items must be a list.`;
  }
  for (const rawItem of batch.items) {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
      return `batch ${id}: An item is not an object.`;
    }
    const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return `batch ${id}: An item is missing its id.`;
    }
    if (typeof item.params !== 'object' || item.params === null || Array.isArray(item.params)) {
      return `batch ${id}: item ${item.id}: The bin parameters must be an object.`;
    }
    const paramsProblem = validateLegacyParams(
      item.params as Record<string, unknown>,
      `batch ${id}: item ${item.id}`,
    );
    if (paramsProblem !== null) return paramsProblem;
    if (!isPositiveInteger(item.count, 1)) {
      return `batch ${id}: item ${item.id}: The count must be a whole number of at least 1.`;
    }
    if (item.sourceEntryId !== undefined && typeof item.sourceEntryId !== 'string') {
      return `batch ${id}: item ${item.id}: The source entry id must be text.`;
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
  // the legacy path. Versions 3 to 8 already have the current product/bin
  // shape and read through the current path; versions 3 and 4 carry divider
  // counts (converted to walls on pick) where versions 5 and up carry walls,
  // and the validators and pickers accept either. Version 6 adds cutout-origin
  // bins, which no earlier version can contain, version 7 adds the per-model
  // sweep fields, absent in earlier versions and defaulted to off on pick, and
  // version 8 adds the baseplate and connection clip product kinds, which no
  // earlier version can contain, so nothing else changes.
  const legacy = version === 1 || version === 2;
  const warnings: string[] = [];
  const entries: QueueEntry[] = [];
  const seen = new Set<string>();
  for (const item of envelope.entries) {
    const problem = legacy ? validateLegacyEntry(item) : validateEntry(item);
    if (problem !== null) {
      return { ok: false, error: `The plan is invalid: ${problem}` };
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
        return { ok: false, error: `The plan is invalid: ${problem}` };
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
