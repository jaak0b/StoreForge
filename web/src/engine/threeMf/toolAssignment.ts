/**
 * Which slicer filament slot (extruder number, 1-based as Orca Slicer counts
 * them) each part of a 3MF object prints with. The body is the bin itself
 * (any fused label shelf or insert plate included); the label is the raised
 * text and icon. A part list without a label uses the body slot only.
 */
export interface ToolAssignment {
  /** Slot of the body part, and of the object as a whole. */
  body: number;
  /** Slot of the raised label part. */
  label: number;
}

/** Lowest valid slot number. */
export const MIN_TOOL = 1;
/** Highest valid slot number. */
export const MAX_TOOL = 100;

/** The assignment a fresh session starts with: body on slot 1, label on slot 2. */
export const DEFAULT_TOOL_ASSIGNMENT: Readonly<ToolAssignment> = Object.freeze({
  body: 1,
  label: 2,
});

/** Parsing result for one typed slot number. */
export type ToolNumberParse = { ok: true; value: number } | { ok: false; error: string };

/**
 * Parse a typed slot number. Returns the value, or a user-worded reason the
 * text is not a whole number from 1 to 100.
 */
export function parseToolNumber(text: string): ToolNumberParse {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Enter a filament slot number.' };
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    return {
      ok: false,
      error: `Enter a whole number from ${MIN_TOOL} to ${MAX_TOOL}.`,
    };
  }
  const value = Number(trimmed);
  const problem = toolNumberProblem(value);
  return problem === null ? { ok: true, value } : { ok: false, error: problem };
}

/** A user-worded reason a slot number is invalid, or null when it is valid. */
export function toolNumberProblem(value: number): string | null {
  if (!Number.isInteger(value) || value < MIN_TOOL || value > MAX_TOOL) {
    return `The filament slot must be a whole number from ${MIN_TOOL} to ${MAX_TOOL}.`;
  }
  return null;
}

/** Throws a user-worded error when either slot of the assignment is invalid. */
export function assertValidToolAssignment(tools: ToolAssignment): void {
  const bodyProblem = toolNumberProblem(tools.body);
  if (bodyProblem !== null) {
    throw new Error(`Base tool ${tools.body} is invalid. ${bodyProblem}`);
  }
  const labelProblem = toolNumberProblem(tools.label);
  if (labelProblem !== null) {
    throw new Error(`Label tool ${tools.label} is invalid. ${labelProblem}`);
  }
}
