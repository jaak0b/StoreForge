import {
  HEAD_ALIASES,
  HEAD_ALIASES_REVERSE,
  HEAD_TYPES,
  IMPERIAL_THREADS,
  isLengthlessHead,
  METRIC_THREADS,
  parseShorthand,
  type HeadType,
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
 * The longest prefix of a compact partial that parseShorthand reads as a bare
 * thread (thread committed, no length, head or quantity yet). Derived by asking
 * parseShorthand about each prefix rather than re-implementing the thread
 * grammar, so 'm34x2' peels 'm34' and '#8x1' peels '#8'. Returns '' when no
 * prefix is a bare thread.
 */
function longestThreadOnlyPrefix(partial: string): string {
  let best = '';
  for (let n = 1; n <= partial.length; n++) {
    const p = partial.slice(0, n);
    const b = parseShorthand(p).batches[0];
    if (
      b !== undefined &&
      b.thread !== null &&
      b.lengthMm === null &&
      b.head === null &&
      !b.quantityExplicit
    ) {
      best = p;
    }
  }
  return best;
}

/**
 * The single alias to offer for a head type given what the user has typed, or
 * null when none of its aliases match. Filtered against EVERY accepted alias in
 * HEAD_ALIASES (not just the canonical one), so parser-accepted words like
 * 'flat', 'socket' or 'nut' complete. With nothing typed the canonical alias is
 * used; otherwise the canonical alias wins when it still matches, else the
 * shortest matching alias, so the offer best continues what was typed.
 */
function bestAliasFor(head: HeadType, partial: string): string | null {
  const matches = Object.entries(HEAD_ALIASES)
    .filter(([, h]) => h === head)
    .map(([alias]) => alias)
    .filter((alias) => caseInsensitivePrefix(alias, partial));
  if (matches.length === 0) return null;
  const canonical = HEAD_ALIASES_REVERSE[head];
  if (partial === '' || matches.includes(canonical)) return canonical;
  return matches.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/**
 * Suggest completions for the CURRENT SEGMENT of a shorthand line.
 * `input` is the whole textbox value, `cursor` the caret index.
 * Only the comma-separated segment containing the caret is considered.
 */
export function suggestShorthand(input: string, cursor: number): ScrewSuggestion[] {
  const { text: segmentText, start } = segmentAtCursor(input, cursor);
  const caretInSegment = Math.max(0, Math.min(segmentText.length, cursor - start));
  const rawPartial = partialToken(segmentText, caretInSegment);
  const tokenStart = caretInSegment - rawPartial.length;

  // The token under the caret is still being typed, so it is excised before
  // parsing to decide what the OTHER tokens in the segment already commit; the
  // full segment (partial included) is parsed separately to read whether a
  // quantity has become explicit.
  const withoutPartialText = segmentText.slice(0, tokenStart) + segmentText.slice(caretInSegment);
  const other = parseShorthand(withoutPartialText).batches[0] ?? null;
  const full = parseShorthand(segmentText).batches[0] ?? null;

  // A compact partial ("m3x2") carries committed fields inside one token. Its
  // bare-thread prefix is peeled off and folded into the committed state, and
  // the remainder becomes the filter for the next field. Deriving the split
  // from parseShorthand keeps a second grammar out of this file. The peel only
  // applies when it leaves a remainder: a lone "m3" is still a thread the user
  // is typing, so it stays in the thread branch.
  let committedPrefix = '';
  let residual = rawPartial;
  const threadPrefix = longestThreadOnlyPrefix(rawPartial);
  if (threadPrefix !== '' && threadPrefix.length < rawPartial.length) {
    committedPrefix = threadPrefix;
    residual = rawPartial.slice(threadPrefix.length);
  }

  let cThread = other?.thread ?? null;
  let cLength = other?.lengthMm ?? null;
  const cHead = other?.head ?? null;
  if (committedPrefix !== '') {
    const peeled = parseShorthand(committedPrefix).batches[0] ?? null;
    if (peeled?.thread != null) cThread = peeled.thread;
  }

  const lengthless = isLengthlessHead(cHead);

  // Thread still missing: suggest thread names filtered by the partial.
  if (cThread === null) {
    return [...METRIC_THREADS, ...IMPERIAL_THREADS]
      .filter((t) => caseInsensitivePrefix(t, residual))
      .map((t) => ({ insert: `${committedPrefix}${t}`, label: t, kind: 'thread' }));
  }

  // Length missing (and not ruled out by a lengthless head).
  if (!lengthless && cLength === null) {
    const numeric = /^x?(\d*)$/i.exec(residual);
    if (numeric !== null) {
      const digits = numeric[1];
      const exact = digits !== '' && COMMON_LENGTHS_MM.includes(Number(digits));
      if (!exact) {
        // A bare "x" or empty remainder shows the full length list; typed
        // digits narrow it to the stocked lengths that begin with them.
        return COMMON_LENGTHS_MM.filter(
          (len) => digits === '' || String(len).startsWith(digits),
        ).map((len) => ({ insert: `${committedPrefix}x${len}`, label: `${len} mm`, kind: 'length' }));
      }
      // An exact stocked length: fold it into the committed prefix and fall
      // through to head suggestions.
      committedPrefix = `${committedPrefix}${residual}`;
      residual = '';
      cLength = Number(digits);
    }
    // A non-numeric remainder (like "nu") is not a length; fall through to the
    // head branch so it can filter head aliases.
  }

  // Head missing: at most one alias per head type, the best continuation of
  // what was typed, filtered against every accepted alias.
  if (cHead === null) {
    const sep = committedPrefix === '' ? '' : ' ';
    const out: ScrewSuggestion[] = [];
    for (const head of HEAD_TYPES) {
      const alias = bestAliasFor(head, residual);
      if (alias === null) continue;
      out.push({ insert: `${committedPrefix}${sep}${alias}`, label: `${head} (${alias})`, kind: 'head' });
    }
    return out;
  }

  if (!(full?.quantityExplicit ?? false)) {
    const sep = committedPrefix === '' ? '' : ' ';
    return COMMON_COUNTS.map((n) => ({
      insert: `${committedPrefix}${sep}x${n}`,
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
