# Screw Entry Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Screw Entry tab's Breakdown field row with a single free-text shorthand box that offers context-aware autocomplete suggestions while typing, plus a live hint line showing the parsed result.

**Architecture:** A new framework-agnostic engine module (`screwSuggest.ts`) derives "what can come next" suggestions from the same tables and parser that `screwListImport.ts` already owns. `ScrewEntryTab.vue` loses the Thread/Head/Length/Count selects, keeps one `v-text-field` with an attached `v-menu` suggestion list, and shows a live hint line built from the existing parse/compose functions. Height moves into the More Options area.

**Tech Stack:** Vue 3 + TypeScript + Vuetify (v-text-field, v-menu, v-list), Vitest. No new dependencies.

## Global Constraints

- Rule 3: `web/src/engine/` never imports Vue/Pinia or touches the DOM.
- Rule 6: never the em-dash character anywhere (source, UI text, commits).
- Rule 7: UI text is plain technical prose, complete sentences.
- Rule 10: no duplicated derivations; thread lists and shorthand grammar have one home (`screwListImport.ts`).
- Rule 13: exhaustive switches over unions, ending in `assertNever`.
- Rule 2: parse errors keep surfacing as user-worded messages (existing `ParsedShorthand.errors`).
- Base branch: `master` AFTER the `screw-head-length` branch (commit 102524f) is merged. That branch changes both `screwListImport.ts` and `ScrewEntryTab.vue`; do not start before it lands.
- Commit style: single short sentence, optional `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.
- Verification bar per task: `npm run build` and `npm test` green inside `web/`.

## Established code facts (verified 2026-07-21)

- `parseShorthand(line: string): ParsedShorthand` at `web/src/engine/plan/screwListImport.ts:228`; `ParsedShorthand = { batches: ScrewBatch[], errors: string[] }`; fault tolerant ("m3", "m3x", "m3x55 f" all return without throwing; incomplete fields are `null` and errors accumulate).
- `ScrewBatch` (lines 150-163): `thread`, `lengthMm`, `head`, `quantity`, `enteredUnit`, `enteredLengthText`.
- `HEAD_ALIASES` (lines 72-101), `HEAD_TYPES` (line 56, UI display order), `LENGTHLESS_HEADS` (lines ~104-140), `composeShorthand` (line 417), `composeLabelText` (line 461), `computeBinWidthUnits` (line 490).
- After the `screw-head-length` merge, `overallLengthMm` and `headHeightMm` also live in `screwListImport.ts`; bin sizing goes through `overallLengthMm`.
- Thread lists currently live IN THE COMPONENT: `ScrewEntryTab.vue:57-58`, `METRIC_THREADS = ['M2','M2.5','M3','M4','M5','M6','M8']`, `IMPERIAL_THREADS = ['#4','#6','#8','#10','#12','1/4-20','5/16-18','3/8-16']`. Task 1 moves them.
- `ScrewEntryTab.vue` reactive flow: `parsed` computed (line 201) live-parses `shorthand`; watch at line 205 syncs shorthand to breakdown fields; watch at line 216 recomposes shorthand from pickers; `resultText` computed (line 403) yields "Resulting bin: M3 x 55 (2 x 1 x 6)." or the insert/multiple variants.
- No `v-autocomplete`/`v-combobox` anywhere in the repo; dropdowns are `v-select`.
- Tests: `web/tests/plan/screwListImport.spec.ts` covers parsing thoroughly; no component tests exist for ScrewEntryTab.

---

### Task 1: Move the thread lists into the engine

**Files:**
- Modify: `web/src/engine/plan/screwListImport.ts` (near `HEAD_TYPES`)
- Modify: `web/src/components/ScrewEntryTab.vue:57-58`
- Test: `web/tests/plan/screwListImport.spec.ts`

**Interfaces:**
- Produces: `export const METRIC_THREADS: readonly string[]`, `export const IMPERIAL_THREADS: readonly string[]` exported from `screwListImport.ts`. Task 2 consumes them.

- [ ] **Step 1: Write the failing test**

```typescript
import { METRIC_THREADS, IMPERIAL_THREADS } from '../../src/engine/plan/screwListImport';

describe('thread lists', () => {
  it('exposes the metric and imperial thread choices', () => {
    expect(METRIC_THREADS).toContain('M3');
    expect(IMPERIAL_THREADS).toContain('1/4-20');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/plan/screwListImport.spec.ts` (inside `web/`)
Expected: FAIL, "METRIC_THREADS" has no exported member.

- [ ] **Step 3: Implement**

Cut the two arrays from `ScrewEntryTab.vue:57-58` and export them from `screwListImport.ts` (as `readonly string[]`, next to `HEAD_TYPES`, with a comment that these are the UI's offered thread choices; the parser itself accepts more). Update `ScrewEntryTab.vue` to import them.

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run tests/plan/screwListImport.spec.ts` then `npm run build`
Expected: PASS, build green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Move the thread choice lists into the screw import engine."
```

### Task 2: Engine suggestion module

**Files:**
- Create: `web/src/engine/plan/screwSuggest.ts`
- Test: `web/tests/plan/screwSuggest.spec.ts`

**Interfaces:**
- Consumes: `parseShorthand`, `METRIC_THREADS`, `IMPERIAL_THREADS`, `HEAD_TYPES`, `HEAD_ALIASES`, `LENGTHLESS_HEADS` from `screwListImport.ts`.
- Produces:

```typescript
export interface ScrewSuggestion {
  /** Text to insert in place of the current partial token, e.g. "M3", "x20", "fhcs", "x5". */
  insert: string;
  /** Label shown in the menu, e.g. "M3", "20 mm", "countersunk screw (fhcs)", "5 pieces". */
  label: string;
  kind: 'thread' | 'length' | 'head' | 'count';
}

/**
 * Suggest completions for the CURRENT SEGMENT of a shorthand line.
 * `input` is the whole textbox value, `cursor` the caret index.
 * Only the comma-separated segment containing the caret is considered.
 */
export function suggestShorthand(input: string, cursor: number): ScrewSuggestion[];

/** Apply a suggestion: returns the new input value and the new caret position. */
export function applySuggestion(
  input: string,
  cursor: number,
  s: ScrewSuggestion,
): { value: string; cursor: number };
```

**Suggestion logic (deterministic, derived from the parse, no heuristics):**

1. Slice `input` to the comma-separated segment containing `cursor`; parse only that segment with `parseShorthand`.
2. Identify the partial token: the run of non-space characters immediately left of the caret (may be empty).
3. Determine which batch fields are still missing on the segment's single batch (thread, lengthMm, head, quantity; a lengthless head skips length). Suggest for the FIRST missing field, filtered by case-insensitive prefix match against the partial token:
   - thread missing: suggest each entry of `METRIC_THREADS` then `IMPERIAL_THREADS` (kind `'thread'`, insert = the thread token as typed shorthand, e.g. `M3`, `#8`, `1/4-20`).
   - thread present, length missing, head not lengthless: suggest `x<len>` for the common metric lengths `[6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60]` (kind `'length'`, label `"<len> mm"`). These are the ISO 262 style preferred coarse lengths; cite in a comment. If the partial token already starts with a digit or `x` followed by digits, filter to lengths whose text starts with the typed digits.
   - length present (or head lengthless), head missing: suggest one entry per `HEAD_TYPES` member, using the SHORTEST alias from `HEAD_ALIASES` that maps to it as `insert` and `"<canonical name> (<alias>)"` as label (kind `'head'`).
   - all of thread/length/head present, quantity still 1 and not explicitly entered: suggest `x2`, `x5`, `x10` (kind `'count'`, labels `"2 pieces"` etc.). Determine "explicitly entered" from the segment text containing a quantity token (`x<N>`/`*<N>`/`qty<N>` after the head or length); if the parser does not expose this, add a boolean `quantityExplicit` to `ScrewBatch` in `screwListImport.ts` rather than re-parsing in the suggest module.
4. Empty input suggests threads. A segment whose batch is complete with explicit quantity returns `[]`.
5. `applySuggestion` replaces the partial token with `s.insert` plus a trailing space when more fields remain, and returns the caret placed after the inserted text.

- [ ] **Step 1: Write failing tests** in `web/tests/plan/screwSuggest.spec.ts` (follow the describe/it style of `screwListImport.spec.ts`):

```typescript
import { suggestShorthand, applySuggestion } from '../../src/engine/plan/screwSuggest';

describe('suggestShorthand', () => {
  it('suggests threads on empty input', () => {
    const s = suggestShorthand('', 0);
    expect(s.map((x) => x.insert)).toContain('M3');
    expect(s[0].kind).toBe('thread');
  });
  it('filters threads by typed prefix', () => {
    const s = suggestShorthand('m2', 2);
    expect(s.map((x) => x.insert)).toEqual(expect.arrayContaining(['M2', 'M2.5']));
    expect(s.map((x) => x.insert)).not.toContain('M3');
  });
  it('suggests lengths after a thread', () => {
    const s = suggestShorthand('M3 ', 3);
    expect(s[0].kind).toBe('length');
    expect(s.map((x) => x.insert)).toContain('x20');
  });
  it('filters lengths by typed digits', () => {
    const s = suggestShorthand('M3 x2', 5);
    expect(s.map((x) => x.insert)).toEqual(expect.arrayContaining(['x20', 'x25']));
    expect(s.map((x) => x.insert)).not.toContain('x30');
  });
  it('suggests heads after a length', () => {
    const s = suggestShorthand('M3x20 ', 6);
    expect(s[0].kind).toBe('head');
    expect(s.map((x) => x.insert)).toContain('fhcs');
  });
  it('filters heads by prefix', () => {
    const s = suggestShorthand('M3x20 f', 7);
    expect(s.map((x) => x.insert)).toContain('fhcs');
    expect(s.map((x) => x.insert)).not.toContain('shcs');
  });
  it('skips length suggestions for lengthless heads', () => {
    const s = suggestShorthand('M3 nut', 6);
    expect(s.every((x) => x.kind !== 'length')).toBe(true);
  });
  it('suggests counts once thread, length and head are set', () => {
    const s = suggestShorthand('M3x20 fhcs ', 11);
    expect(s[0].kind).toBe('count');
    expect(s.map((x) => x.insert)).toContain('x5');
  });
  it('returns nothing for a complete segment with explicit count', () => {
    expect(suggestShorthand('M3x20 fhcs x5', 13)).toEqual([]);
  });
  it('only considers the segment under the caret in a comma list', () => {
    const input = 'M3x20 fhcs x5, m4';
    const s = suggestShorthand(input, input.length);
    expect(s.map((x) => x.insert)).toContain('M4');
  });
});

describe('applySuggestion', () => {
  it('replaces the partial token and appends a space', () => {
    const r = applySuggestion('m2', 2, { insert: 'M2.5', label: 'M2.5', kind: 'thread' });
    expect(r.value).toBe('M2.5 ');
    expect(r.cursor).toBe(5);
  });
  it('inserts mid-list without touching other segments', () => {
    const input = 'M3x20 fhcs x5, m4';
    const r = applySuggestion(input, input.length, { insert: 'M4', label: 'M4', kind: 'thread' });
    expect(r.value).toBe('M3x20 fhcs x5, M4 ');
  });
});
```

- [ ] **Step 2: Run to verify failure** (`npx vitest run tests/plan/screwSuggest.spec.ts`; expected: module not found).
- [ ] **Step 3: Implement `screwSuggest.ts`** per the logic block above. No Vue imports. If `quantityExplicit` is needed, add it to `ScrewBatch` in `screwListImport.ts` where quantity tokens are parsed, and set it in every code path that reads a quantity.
- [ ] **Step 4: Run the full engine test file set** (`npx vitest run tests/plan/`) and `npm run build`. Expected: all green.
- [ ] **Step 5: Commit** (`git commit -m "Add shorthand autocomplete suggestions to the screw import engine."`).

### Task 3: Component refactor

**Files:**
- Modify: `web/src/components/ScrewEntryTab.vue`

**Interfaces:**
- Consumes: `suggestShorthand`, `applySuggestion` from Task 2; existing `parseShorthand`, `composeLabelText`, `composeShorthand`, `overallLengthMm`, `computeBinWidthUnits`.

Changes, all in `ScrewEntryTab.vue`:

1. **Delete the Breakdown row** (Thread/Head/Length/Count selects and number fields, template lines ~495-559 and their local sync watchers at lines 205-224). Keep the local refs only if `pending`/edit flow still needs them; otherwise derive everything from `parsed`/`firstBatch`. The edit flow currently populates fields via `composeShorthand`; keep that path but write into `shorthand` only.
2. **Height field** moves inside the existing More Options area (`MoreOptions` usage at lines ~605-609), keeping its current binding (`heightUnits`), validation and `!insertOnly` visibility.
3. **Suggestion menu:** attach a `v-menu` (with `v-list`) under the shorthand `v-text-field`. State: `suggestions = computed(() => suggestShorthand(shorthand.value, cursorPos.value))` where `cursorPos` tracks `selectionStart` on input/click/keyup. Menu visible while the field is focused and `suggestions.length > 0`. Keyboard: ArrowDown/ArrowUp move a highlight index, Enter or Tab applies the highlighted suggestion via `applySuggestion` (then restore focus and set the caret from the returned cursor), Escape closes the menu. Enter with the menu closed keeps its current meaning (add to queue). Mouse click on an item applies it. Head-type items reuse the existing SVG icon item template (current head select item template lines ~517-532) so the menu shows the fastener silhouettes.
4. **Live hint line** replaces the deleted fields: one caption line under the textbox that always reflects the parse. Single complete batch: keep the existing `resultText` ("Resulting bin: M3 x 55 (2 x 1 x 6)."). Multiple batches: keep "Adds N entries." plus a compact list, one item per batch, `composeLabelText` output with quantity. Parse errors: keep the existing `v-alert` loop showing `parsed.errors`. Incomplete single batch: show what is recognized so far and what is missing, e.g. "M3, countersunk screw. Add a length." built from the batch's non-null fields (plain prose, one sentence of state, one sentence naming the single next missing field).
5. The "?" head-height tooltip from the `screw-head-length` branch loses its host (the Length field is deleted); move the same icon and text next to the hint line.
6. Keep `@keydown.enter="addToQueue"` semantics as described in point 3.

- [ ] **Step 1: Implement the template and script changes** above.
- [ ] **Step 2: Typecheck and test** (`npm run build`, `npm test`). Expected: green; no engine test changes needed.
- [ ] **Step 3: Manual smoke list for the owner** (do not claim these yourself; list them in the report): typing "m" shows thread suggestions; Tab completes; comma starts a fresh segment with thread suggestions; hint line updates per keystroke; Height sits under More Options; editing an existing screw entry repopulates the textbox.
- [ ] **Step 4: Commit** (`git commit -m "Replace the breakdown fields with shorthand autocomplete and a live hint line."`).

### Task 4: Guidance text pass

**Files:**
- Modify: `web/src/components/ScrewEntryTab.vue` (text only)

Apply the repo's writing-ui-guidance rules to every string the refactor touched:

- The field hint under the textbox stays one sentence: "Separate screws with commas; imperial works too (#8 x 1-1/2" wood)." Verify it still renders; do not duplicate its content in the new hint line.
- Hint line sentences: instruction or fact first, max 2 sentences, no em-dash character, community terms ("countersunk screw", not "flat head").
- The moved "?" tooltip keeps its 3-sentence cap.

- [ ] **Step 1: Review all touched strings against the checklist** (one rule, one place; mandatory info at the point of action; skimming the first sentence of each block suffices).
- [ ] **Step 2: Build and test** (`npm run build`, `npm test`). Expected: green.
- [ ] **Step 3: Commit** (`git commit -m "Tighten the screw entry guidance text."`).

## Out of scope

- No changes to the Screw List Import page.
- No new suggestion sources beyond the engine tables (no usage history, no fuzzy matching).
- No component-level automated tests (repo has none for ScrewEntryTab; the engine module carries the coverage).
