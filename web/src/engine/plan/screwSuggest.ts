import {
  HEAD_ALIASES_REVERSE,
  HEAD_TYPES,
  IMPERIAL_THREADS,
  LENGTHLESS_HEADS,
  METRIC_THREADS,
  parseShorthand,
} from './screwListImport';

/**
 * Autocomplete suggestions for the screw shorthand textbox: given the whole
 * textbox value and the caret position, suggests completions for whichever
 * field of the segment under the caret is still missing. Pure, framework-
 * agnostic and deterministic: it derives every suggestion from parseShorthand
 * rather than re-implementing the grammar.
 */

export interface ScrewSuggestion {
  /** Text to insert in place of the current partial token, e.g. "M3", "x20", "fhcs", "x5". */
  insert: string;
  /** Label shown in the menu, e.g. "M3", "20 mm", "countersunk screw (fhcs)", "5 pieces". */
  label: string;
  kind: 'thread' | 'length' | 'head' | 'count';
}

// ISO 888 preferred nominal fastener lengths, the common values a
// hardware drawer is stocked with.
const COMMON_LENGTHS_MM: readonly number[] = [6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60];

const COMMON_COUNTS: readonly number[] = [2, 5, 10];

/** Finds the comma-separated segment of `input` containing `cursor`, with its offset. */
function segmentAtCursor(input: string, cursor: number): { text: string; start: number } {
  let start = 0;
  for (let i = 0; i < cursor; i++) {
    if (input[i] === ',') start = i + 1;
  }
  let end = input.length;
  const nextComma = input.indexOf(',', cursor);
  if (nextComma !== -1) end = nextComma;
  return { text: input.slice(start, end), start };
}

/** The run of non-space characters immediately left of the caret within a segment. */
function partialToken(segmentText: string, caretInSegment: number): string {
  let i = caretInSegment;
  while (i > 0 && !/\s/.test(segmentText[i - 1])) i -= 1;
  return segmentText.slice(i, caretInSegment);
}

function caseInsensitivePrefix(candidate: string, partial: string): boolean {
  return candidate.toLowerCase().startsWith(partial.toLowerCase());
}

/**
 * Suggest completions for the CURRENT SEGMENT of a shorthand line.
 * `input` is the whole textbox value, `cursor` the caret index.
 * Only the comma-separated segment containing the caret is considered.
 */
export function suggestShorthand(input: string, cursor: number): ScrewSuggestion[] {
  const { text: segmentText, start } = segmentAtCursor(input, cursor);
  const caretInSegment = Math.max(0, Math.min(segmentText.length, cursor - start));
  const partial = partialToken(segmentText, caretInSegment);
  const tokenStart = caretInSegment - partial.length;

  // The token under the caret is still being typed, so it is excised before
  // parsing to decide what is already committed by the OTHER tokens in the
  // segment; the full segment (partial included) is parsed separately to
  // read the value the partial itself has already produced (its head, for
  // lengthless detection, and whether a quantity has become explicit).
  const withoutPartialText = segmentText.slice(0, tokenStart) + segmentText.slice(caretInSegment);
  const committed = parseShorthand(withoutPartialText).batches[0] ?? null;
  const full = parseShorthand(segmentText).batches[0] ?? null;

  const lengthless = full?.head !== null && full?.head !== undefined && LENGTHLESS_HEADS.has(full.head);

  if ((committed?.thread ?? null) === null) {
    return [...METRIC_THREADS, ...IMPERIAL_THREADS]
      .filter((t) => caseInsensitivePrefix(t, partial))
      .map((t) => ({ insert: t, label: t, kind: 'thread' }));
  }

  if (!lengthless && (committed?.lengthMm ?? null) === null) {
    const digits = /^x?(\d+)$/i.exec(partial);
    return COMMON_LENGTHS_MM.filter((len) => {
      if (digits === null) return partial === '';
      return String(len).startsWith(digits[1]);
    }).map((len) => ({ insert: `x${len}`, label: `${len} mm`, kind: 'length' }));
  }

  if ((committed?.head ?? null) === null) {
    return HEAD_TYPES.map((h) => ({ head: h, alias: HEAD_ALIASES_REVERSE[h] }))
      .filter(({ alias }) => caseInsensitivePrefix(alias, partial))
      .map(({ head: h, alias }) => ({
        insert: alias,
        label: `${h} (${alias})`,
        kind: 'head' as const,
      }));
  }

  if (!(full?.quantityExplicit ?? false)) {
    return COMMON_COUNTS.map((n) => ({
      insert: `x${n}`,
      label: `${n} pieces`,
      kind: 'count',
    }));
  }

  return [];
}

/** Apply a suggestion: returns the new input value and the new caret position. */
export function applySuggestion(
  input: string,
  cursor: number,
  s: ScrewSuggestion,
): { value: string; cursor: number } {
  const { text: segmentText, start } = segmentAtCursor(input, cursor);
  const caretInSegment = Math.max(0, Math.min(segmentText.length, cursor - start));
  const partial = partialToken(segmentText, caretInSegment);
  const tokenStart = caretInSegment - partial.length;

  const before = segmentText.slice(0, tokenStart);
  const after = segmentText.slice(caretInSegment);
  const inserted = `${s.insert} `;
  const newSegment = `${before}${inserted}${after}`;
  const newCursor = start + before.length + inserted.length;

  const value = `${input.slice(0, start)}${newSegment}${input.slice(start + segmentText.length)}`;
  return { value, cursor: newCursor };
}
