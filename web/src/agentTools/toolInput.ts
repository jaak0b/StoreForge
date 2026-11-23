import { toolResult, type ToolResult } from './modelContext';

/**
 * Reading agent tool input. The schemas are loose on purpose: these readers
 * only check the JSON type of a field (a number where a number goes) so the
 * value can be handed to the shared code, which owns every domain check
 * (bounds, sizes, label rules) and its user-worded refusal. Unknown fields are
 * ignored.
 */

/** A field of the wrong JSON type. Its message is user-worded and names the field. */
export class InputProblem extends Error {}

/** The input as a field record; anything that is not an object reads as no fields. */
export function inputFields(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** A number field, or undefined when absent. */
export function optionalNumber(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new InputProblem(`${key} must be a number.`);
  return value;
}

/** A number field that must be present. */
export function requiredNumber(fields: Record<string, unknown>, key: string): number {
  const value = optionalNumber(fields, key);
  if (value === undefined) throw new InputProblem(`${key} is required.`);
  return value;
}

/** A boolean field, or undefined when absent. */
export function optionalBoolean(fields: Record<string, unknown>, key: string): boolean | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new InputProblem(`${key} must be true or false.`);
  return value;
}

/** A text field, or undefined when absent. */
export function optionalString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InputProblem(`${key} must be text.`);
  return value;
}

/** A text field that must be present. */
export function requiredString(fields: Record<string, unknown>, key: string): string {
  const value = optionalString(fields, key);
  if (value === undefined) throw new InputProblem(`${key} is required.`);
  return value;
}

/** A text field where null means none, or undefined when absent. */
export function optionalNullableString(
  fields: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (fields[key] === null) return null;
  return optionalString(fields, key);
}

/** An object field, or undefined when absent. */
export function optionalObject(
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputProblem(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** A list of objects that must be present and hold at least one item. */
export function requiredObjectList(
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = fields[key];
  if (value === undefined) throw new InputProblem(`${key} is required.`);
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))
  ) {
    throw new InputProblem(`${key} must be a list of objects.`);
  }
  if (value.length === 0) throw new InputProblem(`${key} must hold at least one item.`);
  return value as Record<string, unknown>[];
}

/** One of a fixed set of text values, or undefined when absent. */
export function optionalChoice<T extends string>(
  fields: Record<string, unknown>,
  key: string,
  choices: readonly T[],
): T | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
    throw new InputProblem(`${key} must be one of: ${choices.join(', ')}.`);
  }
  return value as T;
}

/**
 * Runs a tool body, turning an input of the wrong type into an error result
 * the agent can correct. Every other error is a defect and propagates.
 */
export async function runTool(body: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof InputProblem) return toolResult({ problem: error.message }, true);
    throw error;
  }
}
