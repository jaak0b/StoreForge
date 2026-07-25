# Multi-Source Tool Bin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the tool-bin data model around trace sessions so one bin can combine tools from several photographed sheets plus sketched and primitive tools, with each `ToolSource` variant owning its re-edit data, and rebuild the tab's input stage as a source list.

**Architecture:** `TracedBin` gains `traceSessions: TraceSession[]`; `ToolSource` becomes a three-variant union (`photo` with `sessionId`/`clicks`/`brushStrokes`, `sketch` with its `Sketch`, `primitive` with nothing) and `clicks`/`brushStrokes` leave `TracedTool`. Plan file version 11 is reshaped in place (it is unshipped; per the owner's standing rule, unshipped-schema local test data is discarded, never migrated). Version 10 plans migrate on load: the bin-level `traceSourceId`/`paper` pair becomes one session, tools with clicks become photo tools referencing it, tools with empty clicks become primitive, sketch tools stay sketch. The `toolTrace` store's single-photo state becomes active-session state with one atomic `activateSession` action and `embedReady` keyed by session id. Sessions are reference-counted on save: only sessions some tool references are stored with the bin, and the photo-store sweep keeps only referenced session photos.

**Tech Stack:** Vue 3 + TypeScript + Pinia + Vitest. Engine code stays framework-agnostic (`web/src/engine/` imports no Vue, no Pinia, no DOM).

## Global Constraints

- Never use the em-dash character, and never a hyphen as a substitute for it (CLAUDE.md convention 6). This applies to code comments, UI text, test names and commit messages.
- Every branch on `ToolSource` (and every other discriminated union) handles every member explicitly and ends in `assertNever` (convention 13). The new `primitive` member must appear in every switch.
- planFile.ts validation message convention (documented at the top of that file): return `null` when valid, otherwise an optional lowercase subject prefix followed by exactly one complete sentence, capital letter, user-facing field names, full stop.
- No silently swallowed errors (convention 2): a `catch` surfaces, rethrows, or returns a value the caller acts on.
- UI text is plain technical prose in complete sentences, 3D-printing-community terminology (convention 7).
- Interim fixes are forbidden: this is the final structure, no compatibility shims for the unshipped v11 shape.
- All commands run inside `web/`. Verification bar: `npm run build` and `npm test` green.
- Commits: single short sentence, optionally ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Working branch: `sketch-workspace`. Commit at will on the branch; do not push.

---

### Task 1: ToolSource three-variant union and TraceSession type

Move `clicks` and `brushStrokes` off `TracedTool` into the photo variant, add the `primitive` variant, add the `TraceSession` type, and swap `TracedBin`'s `traceSourceId`/`paper` for `traceSessions`. Then follow the compiler through every consumer. planFile.ts is only patched enough to compile here (it is rebuilt properly in Task 2).

**Files:**
- Modify: `web/src/engine/trace/types.ts:87` (ToolSource), `:139-177` (TracedTool)
- Modify: `web/src/engine/plan/types.ts:129-138` (TracedBin)
- Modify: `web/src/engine/trace/layoutModel.ts:369-461` (addTool, replaceToolOutline)
- Modify: `web/src/stores/toolTrace.ts:161-191` (addTool, replaceToolOutline wrappers)
- Modify: `web/src/components/trace/toolEditAction.ts`
- Modify: `web/src/components/trace/TraceCanvas.vue:154-163, 829-840`
- Modify: `web/src/components/trace/LayoutWorkspace.vue:135` (primitive add), `:302-358` (save path, minimally, rebuilt in Task 4)
- Modify: `web/src/components/trace/LayoutToolbar.vue:192`, `web/src/components/trace/AdvancedDrawer.vue:202`
- Modify: `web/src/components/trace/TraceTab.vue:98-130` (sketch finish, edit-sketch switch)
- Modify: `web/src/engine/plan/planFile.ts` (compile-only stubs; full rebuild in Task 2)
- Modify: `web/src/engine/plan/storedAssets.ts:75-87`
- Test: `web/tests/stores/toolTrace.spec.ts`

**Interfaces:**
- Produces (later tasks rely on these exact shapes):

```ts
// web/src/engine/trace/types.ts
export interface TraceSession {
  /** Stable id tools reference through their photo source's sessionId. */
  id: string;
  /** Key of the session's photo in this device's photo store. */
  traceSourceId: string;
  /** The reference-sheet setup the photo was rectified with. */
  paper: { corners: PaperCorners; kind: PaperKind };
}

export type ToolSource =
  | { kind: 'photo'; sessionId: string; clicks: SamPoint[]; brushStrokes?: BrushStroke[] }
  | { kind: 'sketch'; sketch: Sketch }
  | { kind: 'primitive' };
```

- Produces: `layoutModel.addTool(state, outline, name, pocketDepthMm, source: ToolSource, placeAtSheetPosition = false): TracedTool` and `layoutModel.replaceToolOutline(state, toolId, outline, source: ToolSource): void`
- Produces: store wrappers `trace.addTool(outline, name: string | undefined, source: ToolSource, placeAtSheetPosition = false)` and `trace.replaceToolOutline(toolId, outline, source: ToolSource)`
- Produces: `editActionOf(tool): 'retrace' | 'editSketch' | 'none'`

- [ ] **Step 1: Update the store test to the new shapes (failing test first)**

In `web/tests/stores/toolTrace.spec.ts`, change the sketched-tool test's `addTool` call and add a primitive and a photo case:

```ts
  it('adds a sketched tool carrying its editable sketch', () => {
    const trace = useToolTrace();
    const sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point' as const, id: 'pc', x: 0, y: 0, construction: false },
        { kind: 'circle' as const, id: 'c1', centerId: 'pc', radiusMm: 12, construction: false },
      ],
      constraints: [],
    };
    const outline = {
      outer: [
        { x: -12, y: -12 },
        { x: 12, y: -12 },
        { x: 12, y: 12 },
        { x: -12, y: 12 },
      ],
      holes: [],
    };
    const tool = trace.addTool(outline, 'Sketched shape', { kind: 'sketch', sketch });
    expect(tool.source.kind).toBe('sketch');
    if (tool.source.kind === 'sketch') {
      expect(tool.source.sketch).toEqual(sketch);
    }
    expect(trace.placements.some((p) => p.toolId === tool.id)).toBe(true);
  });

  it('adds a primitive tool with no re-edit data', () => {
    const trace = useToolTrace();
    const outline = {
      outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      holes: [],
    };
    const tool = trace.addTool(outline, 'Circle', { kind: 'primitive' });
    expect(tool.source).toEqual({ kind: 'primitive' });
    expect('clicks' in tool).toBe(false);
  });

  it('stores a photo tool\'s clicks and strokes inside its source', () => {
    const trace = useToolTrace();
    const outline = {
      outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      holes: [],
    };
    const clicks = [{ x: 5, y: 5, label: 1 as const }];
    const tool = trace.addTool(outline, undefined, {
      kind: 'photo',
      sessionId: 's1',
      clicks,
      brushStrokes: [],
    });
    expect(tool.source.kind).toBe('photo');
    if (tool.source.kind === 'photo') {
      expect(tool.source.sessionId).toBe('s1');
      expect(tool.source.clicks).toEqual(clicks);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/stores/toolTrace.spec.ts`
Expected: FAIL (type errors / wrong argument shapes against the current signatures).

- [ ] **Step 3: Rewrite the types**

In `web/src/engine/trace/types.ts`:

Replace the `ToolSource` declaration (line 82-87) with:

```ts
/**
 * Where a tool's outline came from, each variant owning its own re-edit
 * data. A photo-traced tool names the trace session it was traced in and
 * carries the clicks and brush strokes (rectified-image pixels of that
 * session's sheet) that reproduce its segmentation. A sketched tool embeds
 * its editable Sketch. A primitive tool (basic circle or rectangle) has no
 * re-edit data at all. Discriminated on kind and always branched
 * exhaustively (assertNever), mirroring Bin.origin.
 */
export type ToolSource =
  | { kind: 'photo'; sessionId: string; clicks: SamPoint[]; brushStrokes?: BrushStroke[] }
  | { kind: 'sketch'; sketch: Sketch }
  | { kind: 'primitive' };

/**
 * One photographed reference sheet a tool bin's photo tools were traced on.
 * The photo blob itself lives in this device's photo store under
 * traceSourceId; the session carries what re-tracing needs to reproduce the
 * exact rectified image the tools' clicks refer to. A session is saved with
 * the bin iff at least one tool references its id.
 */
export interface TraceSession {
  id: string;
  traceSourceId: string;
  paper: { corners: PaperCorners; kind: PaperKind };
}
```

In the `TracedTool` interface, delete the `clicks` field (lines 143-149), the `brushStrokes` field (lines 150-155), and update the `source` doc comment to `/** Where the outline came from, owning that origin's re-edit data. */`. Update the `BrushStroke` doc comment's frame reference (line 14) from `TracedTool.clicks` to `the photo source's clicks`.

In `web/src/engine/plan/types.ts`, replace `TracedBin`'s `traceSourceId?` and `paper?` fields (lines 130-137) with:

```ts
  /**
   * The photographed sheets this bin's photo tools were traced on. Empty for
   * bins with only sketched or primitive tools, and for plans imported from
   * devices that no longer hold the photos (the photo store lookup then
   * comes back empty and the bin is layout-only editable).
   */
  traceSessions: TraceSession[];
```

Import `TraceSession` from `../trace/types` in plan/types.ts. Keep the `TracePaper` interface (line 28-33) where it is: it is still the shape of `TraceSession.paper` as stored in the plan, and the v10 migration validator still reads the legacy bin-level field. Note that `TraceSession.paper` is structurally identical to `TracePaper`; do not declare a second corners-plus-kind type anywhere.

- [ ] **Step 4: Follow the compiler**

Run: `npx vue-tsc --noEmit` and fix every error site as follows.

`web/src/engine/trace/layoutModel.ts`: change `addTool` (line 369) to

```ts
export function addTool(
  state: LayoutState,
  outline: TracedOutline,
  name: string,
  pocketDepthMm: number,
  source: ToolSource,
  placeAtSheetPosition = false,
): TracedTool {
  const tool: TracedTool = {
    id: crypto.randomUUID(),
    name,
    outline: recentred(outline),
    rotationDeg: 0,
    offsetMm: DEFAULT_CLEARANCE_MM,
    mirrored: false,
    minHoleWidthMm: DEFAULT_MIN_HOLE_WIDTH_MM,
    filledHoleIndices: [],
    fingerHoles: [],
    source: cloneSource(source),
  };
  // ... rest unchanged
```

and `replaceToolOutline` (line 441) to

```ts
export function replaceToolOutline(
  state: LayoutState,
  toolId: string,
  outline: TracedOutline,
  source: ToolSource,
): void {
  const tool = state.tools.find((t) => t.id === toolId);
  if (tool === undefined) return;
  tool.outline = recentred(outline);
  tool.source = cloneSource(source);
  tool.filledHoleIndices = [];
  // ... placement update and refit unchanged
```

Add next to `cloneStrokes` (and delete `cloneStrokes` if nothing else uses it):

```ts
/** Deep-copies a tool source so the stored tool never aliases caller state. */
function cloneSource(source: ToolSource): ToolSource {
  return JSON.parse(JSON.stringify(source)) as ToolSource;
}
```

`web/src/stores/toolTrace.ts`: change the wrappers (lines 161-191) to

```ts
  function addTool(
    outline: TracedOutline,
    name: string | undefined,
    source: ToolSource,
    placeAtSheetPosition = false,
  ): TracedTool {
    toolCounter += 1;
    const tool = layout.addTool(
      layoutState,
      outline,
      name ?? `Tool ${toolCounter}`,
      defaultDepthMm.value,
      source,
      placeAtSheetPosition,
    );
    selectedToolId.value = tool.id;
    return tool;
  }

  function replaceToolOutline(toolId: string, outline: TracedOutline, source: ToolSource): void {
    layout.replaceToolOutline(layoutState, toolId, outline, source);
  }
```

Drop the now-unused `BrushStroke` and `SamPoint` imports if the compiler flags them.

`web/src/components/trace/toolEditAction.ts`: extend to the third variant.

```ts
import { assertNever } from '../../engine/plan/types';
import type { TracedTool } from '../../engine/trace/types';

/**
 * The edit affordance a tool row shows, by outline source: a photo-traced
 * tool re-traces from its stored clicks, a sketched tool reopens its stored
 * sketch for editing, and a primitive shape has nothing to reopen. Shared by
 * every place a tool row renders its edit button (the advanced drawer's tool
 * list, the selection toolbar's menu), so they never drift out of step.
 */
export function editActionOf(tool: TracedTool): 'retrace' | 'editSketch' | 'none' {
  switch (tool.source.kind) {
    case 'photo':
      return 'retrace';
    case 'sketch':
      return 'editSketch';
    case 'primitive':
      return 'none';
    default:
      return assertNever(tool.source);
  }
}
```

`web/src/components/trace/LayoutToolbar.vue:192` and `web/src/components/trace/AdvancedDrawer.vue:202`: replace the condition `editActionOf(tool) === 'retrace' && tool.clicks.length > 0` with `editActionOf(tool) === 'retrace'` (a photo source always carries its clicks now).

`web/src/components/trace/TraceCanvas.vue`: in the retrace watcher (lines 154-163), read from the source:

```ts
    const tool = store.tools.find((t) => t.id === toolId);
    store.retraceRequestId = null;
    if (tool === undefined || tool.source.kind !== 'photo') return;
    points.value = JSON.parse(JSON.stringify(tool.source.clicks)) as SamPoint[];
    strokes.value = tool.source.brushStrokes
      ? (JSON.parse(JSON.stringify(tool.source.brushStrokes)) as BrushStroke[])
      : [];
```

In the accept handler (lines 826-840), build the source. The active session id comes from the store (added in Task 5; until then use `store.sourceId ?? ''`, and Task 5's step replaces it, which is acceptable only because Task 5 hard-replaces this line; flag it with a comment `// Session id wiring lands with the active-session store state.`):

```ts
  const clicks = JSON.parse(JSON.stringify(points.value)) as SamPoint[];
  const brushStrokes = JSON.parse(JSON.stringify(strokes.value)) as BrushStroke[];
  const source: ToolSource = {
    kind: 'photo',
    // Session id wiring lands with the active-session store state.
    sessionId: store.sourceId ?? '',
    clicks,
    brushStrokes,
  };
  if (retracingToolId !== null) {
    store.replaceToolOutline(retracingToolId, outline.value, source);
  } else {
    const tool = store.addTool(outline.value, undefined, source, true);
  }
```

(Adapt the surrounding variable names to what the file actually uses at those lines; the shape of the call is what matters.) Import `ToolSource` in the file's type imports.

`web/src/components/trace/LayoutWorkspace.vue:135`: the primitive-shape dialog's add call becomes `trace.addTool(outline, name, { kind: 'primitive' })` (keeping whatever outline and name expressions are already there; primitives were previously mislabeled as photo).

`web/src/components/trace/TraceTab.vue`: in `finishSketch` (lines 103-107), the two calls become

```ts
      trace.replaceToolOutline(tool.id, profile.outline, source);
```

and

```ts
    trace.addTool(profile.outline, 'Sketched shape', source);
```

(delete the now-redundant `tool.source = source;` line 104). In `editSketchedTool` (lines 115-130), add the `primitive` case to the switch:

```ts
    case 'primitive':
      return; // a primitive shape has nothing to reopen
```

`web/src/engine/plan/storedAssets.ts:75-78`: the traced branch of `referencedAssetIds` becomes

```ts
      case 'traced':
        for (const session of bin.traceSessions) tracePhotos.add(session.traceSourceId);
        return;
```

`web/src/engine/plan/planFile.ts`: patch only what the compiler forces (the `TracedBin` construction in `pickBin` and the `pickPockets` tool mapping). Give `pickBin`'s traced branch `traceSessions: []` and delete `assignTraceSource`'s call, and in `pickPockets` map `source: { kind: 'primitive' }` for every tool temporarily. This is throwaway scaffolding that Task 2 replaces wholesale; do not invest in it. If other spec files under `web/tests/` reference `tool.clicks`, `bin.traceSourceId` or `bin.paper` and fail to compile, update those fixtures to the new shapes minimally so the suite compiles (Task 2 rewrites the planFile fixtures properly).

- [ ] **Step 5: Typecheck and run the store test**

Run: `npx vue-tsc --noEmit`
Expected: clean.
Run: `npx vitest run tests/stores/toolTrace.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Make ToolSource a three-variant union owning its re-edit data."
```

---

### Task 2: Plan file v11 reshape and v10 migration

Rebuild planFile.ts for the new shape: `traceSessions` validation, three-variant source validation with cross-checked session ids, migration of v10 bins (bin-level `traceSourceId`/`paper` to one session, tool classification), and the version-history comment. Version number stays 11 (unshipped, reshaped in place, never bumped to 12).

**Files:**
- Modify: `web/src/engine/plan/planFile.ts:129-315` (validatePockets), `:317-387` (pickPockets, pickToolSource), `:633-691` (trace-source validation and pick), `:848-908` (validateBin traced branch, pickBin), `:1914-1928` (version-history comment)
- Test: `web/tests/plan/planFile.spec.ts`

**Interfaces:**
- Consumes: `TraceSession`, three-variant `ToolSource` from Task 1.
- Produces: `validateTraceSessions(raw: unknown, subject: string): string | null`; `validatePockets(raw: unknown, subject: string, sessionIds: ReadonlySet<string> | null): string | null` where `null` sessionIds means legacy (pre-session) mode; `pickTraceSessions(raw: Record<string, unknown>): TraceSession[]`; `pickPockets(raw: Record<string, unknown>, migratedSessionId: string | null): BinPockets`.

- [ ] **Step 1: Write the failing tests**

Add to `web/tests/plan/planFile.spec.ts` (follow the file's existing helper style for building a minimal valid plan envelope; the fixtures below spell out the traced-bin payloads in full). A minimal valid traced-bin entry for these tests:

```ts
const squareOutline = {
  outer: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ],
  holes: [],
};

const paper = {
  kind: 'a4',
  corners: {
    tl: { x: 0, y: 0 },
    tr: { x: 100, y: 0 },
    br: { x: 100, y: 140 },
    bl: { x: 0, y: 140 },
  },
};

function tracedEntry(bin: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'e1',
    createdAt: '2026-07-25T00:00:00.000Z',
    quantity: 1,
    product: {
      kind: 'bin',
      labelSlot: false,
      bin: {
        origin: 'traced',
        gridX: 1,
        gridY: 1,
        heightUnits: 6,
        magnetHoles: false,
        ...bin,
      },
    },
  };
}

function toolBase(id: string): Record<string, unknown> {
  return {
    id,
    name: 'Tool',
    outline: squareOutline,
    rotationDeg: 0,
    offsetMm: 1.5,
    mirrored: false,
    minHoleWidthMm: 0,
    filledHoleIndices: [],
    fingerHoles: [],
  };
}
```

Tests:

```ts
describe('plan v11 trace sessions', () => {
  it('round-trips a multi-session bin with photo, sketch and primitive tools', () => {
    const plan = {
      version: 11,
      entries: [
        tracedEntry({
          traceSessions: [
            { id: 's1', traceSourceId: 'p1', paper },
            { id: 's2', traceSourceId: 'p2', paper },
          ],
          pockets: {
            tools: [
              {
                ...toolBase('t1'),
                source: { kind: 'photo', sessionId: 's1', clicks: [{ x: 1, y: 2, label: 1 }] },
              },
              {
                ...toolBase('t2'),
                source: { kind: 'photo', sessionId: 's2', clicks: [{ x: 3, y: 4, label: 1 }] },
              },
              { ...toolBase('t3'), source: { kind: 'primitive' } },
            ],
            placements: [
              { toolId: 't1', xMm: 10, yMm: 10, pocketDepthMm: 20, draftAngleDeg: 0 },
              { toolId: 't2', xMm: 25, yMm: 10, pocketDepthMm: 20, draftAngleDeg: 0 },
              { toolId: 't3', xMm: 10, yMm: 25, pocketDepthMm: 20, draftAngleDeg: 0 },
            ],
          },
        }),
      ],
      batches: [],
    };
    const result = parsePlanFile(JSON.stringify(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bin = binOf(result.plan.entries[0].product);
    if (bin === null || bin.origin !== 'traced') throw new Error('expected a traced bin');
    expect(bin.traceSessions.map((s) => s.id)).toEqual(['s1', 's2']);
    const reparsed = parsePlanFile(
      serializePlanFile(result.plan.entries, result.plan.batches, result.plan.groups),
    );
    expect(reparsed).toEqual(result);
  });

  it('rejects a photo tool whose sessionId is not one of the bin sessions', () => {
    const plan = {
      version: 11,
      entries: [
        tracedEntry({
          traceSessions: [{ id: 's1', traceSourceId: 'p1', paper }],
          pockets: {
            tools: [
              {
                ...toolBase('t1'),
                source: { kind: 'photo', sessionId: 'missing', clicks: [] },
              },
            ],
            placements: [
              { toolId: 't1', xMm: 10, yMm: 10, pocketDepthMm: 20, draftAngleDeg: 0 },
            ],
          },
        }),
      ],
      batches: [],
    };
    const result = parsePlanFile(JSON.stringify(plan));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('names a photo sheet the bin does not have');
  });

  it('rejects a duplicate session id', () => {
    const plan = {
      version: 11,
      entries: [
        tracedEntry({
          traceSessions: [
            { id: 's1', traceSourceId: 'p1', paper },
            { id: 's1', traceSourceId: 'p2', paper },
          ],
          pockets: { tools: [], placements: [] },
        }),
      ],
      batches: [],
    };
    const result = parsePlanFile(JSON.stringify(plan));
    expect(result.ok).toBe(false);
  });

  it('migrates a v10 bin into one session and classifies its tools', () => {
    const plan = {
      version: 10,
      entries: [
        tracedEntry({
          traceSourceId: 'photo-key',
          paper,
          pockets: {
            tools: [
              { ...toolBase('t1'), clicks: [{ x: 1, y: 2, label: 1 }] },
              { ...toolBase('t2'), clicks: [] },
              {
                ...toolBase('t3'),
                clicks: [],
                source: {
                  kind: 'sketch',
                  sketch: {
                    schemaVersion: SKETCH_SCHEMA_VERSION,
                    entities: [
                      { kind: 'point', id: 'pc', x: 0, y: 0, construction: false },
                      { kind: 'circle', id: 'c1', centerId: 'pc', radiusMm: 12, construction: false },
                    ],
                    constraints: [],
                  },
                },
              },
            ],
            placements: [
              { toolId: 't1', xMm: 10, yMm: 10, pocketDepthMm: 20, draftAngleDeg: 0 },
              { toolId: 't2', xMm: 25, yMm: 10, pocketDepthMm: 20, draftAngleDeg: 0 },
              { toolId: 't3', xMm: 10, yMm: 25, pocketDepthMm: 20, draftAngleDeg: 0 },
            ],
          },
        }),
      ],
      batches: [],
    };
    const result = parsePlanFile(JSON.stringify(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bin = binOf(result.plan.entries[0].product);
    if (bin === null || bin.origin !== 'traced') throw new Error('expected a traced bin');
    expect(bin.traceSessions).toHaveLength(1);
    const session = bin.traceSessions[0];
    expect(session.traceSourceId).toBe('photo-key');
    expect(session.paper.kind).toBe('a4');
    const [t1, t2, t3] = bin.pockets.tools;
    expect(t1.source.kind).toBe('photo');
    if (t1.source.kind === 'photo') {
      expect(t1.source.sessionId).toBe(session.id);
      expect(t1.source.clicks).toEqual([{ x: 1, y: 2, label: 1 }]);
    }
    expect(t2.source).toEqual({ kind: 'primitive' });
    expect(t3.source.kind).toBe('sketch');
  });

  it('migrates a v10 bin without a stored photo to sessionless primitives', () => {
    const plan = {
      version: 10,
      entries: [
        tracedEntry({
          pockets: {
            tools: [{ ...toolBase('t1'), clicks: [{ x: 1, y: 2, label: 1 }] }],
            placements: [
              { toolId: 't1', xMm: 10, yMm: 10, pocketDepthMm: 20, draftAngleDeg: 0 },
            ],
          },
        }),
      ],
      batches: [],
    };
    const result = parsePlanFile(JSON.stringify(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bin = binOf(result.plan.entries[0].product);
    if (bin === null || bin.origin !== 'traced') throw new Error('expected a traced bin');
    expect(bin.traceSessions).toEqual([]);
    // Without a photo the clicks reference nothing re-traceable; the tool
    // degrades to a primitive rather than a photo tool with a dangling session.
    expect(bin.pockets.tools[0].source).toEqual({ kind: 'primitive' });
  });
});
```

Add the imports the file does not already have: `binOf` from `../../src/engine/plan/types`, `SKETCH_SCHEMA_VERSION` from `../../src/engine/sketch/model`, `serializePlanFile` and `parsePlanFile` from `../../src/engine/plan/planFile`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/plan/planFile.spec.ts`
Expected: FAIL (session validation and migration do not exist yet).

- [ ] **Step 3: Implement the reshape in planFile.ts**

3a. Add `validateTraceSessions` and `pickTraceSessions` next to the existing `validateTraceSource` (keep `validateTraceSource` and `pickTracePaper`; they now serve the v10 legacy fields). Extract the corner-checking loop shared with `validateTraceSource` into a helper so the paper shape is validated in one place:

```ts
/** Validates a paper object (kind plus four corners); shared by the session and the legacy bin-level field. */
function validatePaper(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: The paper must be an object.`;
  }
  const paper = raw as Record<string, unknown>;
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
  return null;
}

/**
 * Validates a traced bin's list of trace sessions (the photographed sheets
 * its photo tools reference). Returns null when valid, otherwise a message
 * naming the first offending session.
 */
export function validateTraceSessions(raw: unknown, subject: string): string | null {
  if (!Array.isArray(raw)) {
    return `${subject}: The photo sheets must be a list.`;
  }
  const ids = new Set<string>();
  for (const rawSession of raw) {
    if (typeof rawSession !== 'object' || rawSession === null || Array.isArray(rawSession)) {
      return `${subject}: A photo sheet is not an object.`;
    }
    const session = rawSession as Record<string, unknown>;
    if (typeof session.id !== 'string' || session.id.length === 0) {
      return `${subject}: A photo sheet is missing its id.`;
    }
    if (ids.has(session.id)) {
      return `${subject}: The photo sheet id ${session.id} appears twice.`;
    }
    ids.add(session.id);
    if (typeof session.traceSourceId !== 'string' || session.traceSourceId.length === 0) {
      return `${subject}: photo sheet ${session.id}: The stored photo id must be text that is not empty.`;
    }
    const paperProblem = validatePaper(session.paper, `${subject}: photo sheet ${session.id}`);
    if (paperProblem !== null) return paperProblem;
  }
  return null;
}

/** Copies only the known TraceSession fields from a validated raw list. */
export function pickTraceSessions(raw: Record<string, unknown>): TraceSession[] {
  if (!Array.isArray(raw.traceSessions)) return [];
  return (raw.traceSessions as Record<string, unknown>[]).map((session) => ({
    id: session.id as string,
    traceSourceId: session.traceSourceId as string,
    paper: pickTracePaper(session.paper as Record<string, unknown>),
  }));
}
```

Rewrite `validateTraceSource`'s paper branch to delegate: `if (raw.paper !== undefined) { return validatePaper(raw.paper, subject); }`. Import `TraceSession` from `../trace/types`.

3b. Rework `validatePockets` to take the session ids and validate the source variants. Signature: `validatePockets(raw: unknown, subject: string, sessionIds: ReadonlySet<string> | null)`, where `null` means a legacy (v10 or earlier) bin: tool-level `clicks`/`brushStrokes` are accepted for migration and `source` may be absent or `{ kind: 'photo' }` without a sessionId. Move the existing click-list and stroke-list checks (lines 196-238) into two helpers so both modes share them:

```ts
function validateClickList(raw: unknown, subject: string): string | null {
  if (!Array.isArray(raw)) {
    return `${subject}: The clicks must be a list.`;
  }
  for (const rawClick of raw) {
    const click = rawClick as Record<string, unknown> | null;
    if (
      typeof click !== 'object' ||
      click === null ||
      !isFiniteNumber(click.x) ||
      !isFiniteNumber(click.y) ||
      (click.label !== 0 && click.label !== 1)
    ) {
      return `${subject}: A click needs an x, a y and a label of 0 or 1.`;
    }
  }
  return null;
}

function validateStrokeList(raw: unknown, subject: string): string | null {
  if (!Array.isArray(raw)) {
    return `${subject}: The brush strokes must be a list.`;
  }
  for (const rawStroke of raw) {
    const stroke = rawStroke as Record<string, unknown> | null;
    if (
      typeof stroke !== 'object' ||
      stroke === null ||
      (stroke.mode !== 'add' && stroke.mode !== 'erase' && stroke.mode !== 'smooth') ||
      !isFiniteNumber(stroke.radiusMm) ||
      (stroke.radiusMm as number) <= 0 ||
      !Array.isArray(stroke.points)
    ) {
      return `${subject}: A brush stroke needs a mode of add, erase or smooth, a radius above 0 mm and a list of points.`;
    }
    for (const rawPt of stroke.points as unknown[]) {
      const pt = rawPt as Record<string, unknown> | null;
      if (typeof pt !== 'object' || pt === null || !isFiniteNumber(pt.x) || !isFiniteNumber(pt.y)) {
        return `${subject}: A brush stroke point needs an x and a y.`;
      }
    }
  }
  return null;
}
```

Inside the per-tool loop, replace the old tool-level clicks/strokes blocks and the old source block with:

```ts
    if (sessionIds === null) {
      // Legacy mode (plan version 10 or earlier): clicks and brush strokes
      // sit on the tool itself and the source, when present at all, is a
      // sketch or a bare photo marker. The pick step migrates them.
      if (tool.clicks !== undefined) {
        const clicksProblem = validateClickList(tool.clicks, `${subject}: pocket tool ${tool.id}`);
        if (clicksProblem !== null) return clicksProblem;
      }
      if (tool.brushStrokes !== undefined) {
        const strokesProblem = validateStrokeList(
          tool.brushStrokes,
          `${subject}: pocket tool ${tool.id}`,
        );
        if (strokesProblem !== null) return strokesProblem;
      }
      if (tool.source !== undefined) {
        const source = tool.source as Record<string, unknown> | null;
        if (typeof source !== 'object' || source === null || Array.isArray(source)) {
          return `${subject}: pocket tool ${tool.id}: The outline source must be an object.`;
        }
        if (source.kind === 'sketch') {
          const sketchProblem = validateSketch(source.sketch, `${subject}: pocket tool ${tool.id}`);
          if (sketchProblem !== null) return sketchProblem;
        } else if (source.kind !== 'photo') {
          return `${subject}: pocket tool ${tool.id}: The outline source must be a photo trace or a sketch.`;
        }
      }
    } else {
      const source = tool.source as Record<string, unknown> | null | undefined;
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        return `${subject}: pocket tool ${tool.id}: The outline source must be an object.`;
      }
      if (source.kind === 'photo') {
        if (typeof source.sessionId !== 'string' || !sessionIds.has(source.sessionId)) {
          return `${subject}: pocket tool ${tool.id}: The outline source names a photo sheet the bin does not have.`;
        }
        const clicksProblem = validateClickList(source.clicks, `${subject}: pocket tool ${tool.id}`);
        if (clicksProblem !== null) return clicksProblem;
        if (source.brushStrokes !== undefined) {
          const strokesProblem = validateStrokeList(
            source.brushStrokes,
            `${subject}: pocket tool ${tool.id}`,
          );
          if (strokesProblem !== null) return strokesProblem;
        }
      } else if (source.kind === 'sketch') {
        const sketchProblem = validateSketch(source.sketch, `${subject}: pocket tool ${tool.id}`);
        if (sketchProblem !== null) return sketchProblem;
      } else if (source.kind === 'primitive') {
        // A primitive source carries no further fields.
      } else {
        return `${subject}: pocket tool ${tool.id}: The outline source must be a photo trace, a sketch or a basic shape.`;
      }
    }
```

3c. Rework `pickPockets` and `pickToolSource`. New signatures:

```ts
export function pickPockets(
  raw: Record<string, unknown>,
  migratedSessionId: string | null,
): BinPockets
```

The tool mapping drops the `clicks`/`brushStrokes` fields and calls `source: pickToolSource(tool, migratedSessionId)`. Replace `pickToolSource` with:

```ts
/**
 * Copies a validated tool source. A tool from a version 10 or earlier plan
 * has no self-contained source: a sketch source is kept, a tool with stored
 * clicks becomes a photo tool referencing the bin's one migrated session,
 * and everything else (empty clicks, or clicks with no stored photo to
 * re-trace against) is a primitive.
 */
function pickToolSource(
  tool: Record<string, unknown>,
  migratedSessionId: string | null,
): ToolSource {
  const raw = tool.source as Record<string, unknown> | undefined;
  if (raw !== undefined && raw.kind === 'sketch') {
    const parsed = deserializeSketch(raw.sketch);
    if (!parsed.ok) {
      // validatePockets already proved the sketch valid; reaching here is a
      // programming error, not a user problem.
      throw new Error(`A validated sketch failed to deserialize: ${parsed.error}`);
    }
    return { kind: 'sketch', sketch: parsed.sketch };
  }
  if (raw !== undefined && raw.kind === 'primitive') {
    return { kind: 'primitive' };
  }
  if (raw !== undefined && raw.kind === 'photo' && typeof raw.sessionId === 'string') {
    return {
      kind: 'photo',
      sessionId: raw.sessionId,
      clicks: (raw.clicks as SamPoint[]).map((p) => ({ x: p.x, y: p.y, label: p.label })),
      ...(raw.brushStrokes !== undefined
        ? {
            brushStrokes: (raw.brushStrokes as BrushStroke[]).map((s) => ({
              mode: s.mode,
              radiusMm: s.radiusMm,
              points: s.points.map((p) => ({ x: p.x, y: p.y })),
            })),
          }
        : {}),
    };
  }
  // Legacy tool: clicks live on the tool itself.
  const clicks = (tool.clicks as SamPoint[] | undefined) ?? [];
  if (clicks.length > 0 && migratedSessionId !== null) {
    return {
      kind: 'photo',
      sessionId: migratedSessionId,
      clicks: clicks.map((p) => ({ x: p.x, y: p.y, label: p.label })),
      ...(tool.brushStrokes !== undefined
        ? {
            brushStrokes: (tool.brushStrokes as BrushStroke[]).map((s) => ({
              mode: s.mode,
              radiusMm: s.radiusMm,
              points: s.points.map((p) => ({ x: p.x, y: p.y })),
            })),
          }
        : {}),
    };
  }
  return { kind: 'primitive' };
}
```

3d. Rework `validateBin`'s traced branch and `pickBin`'s traced branch:

```ts
  if (bin.origin === 'traced') {
    if (
      bin.walls !== undefined ||
      bin.dividerCountX !== undefined ||
      bin.dividerCountY !== undefined
    ) {
      return `${subject}: A traced bin cannot have divider walls.`;
    }
    let sessionIds: ReadonlySet<string> | null = null;
    if (bin.traceSessions !== undefined) {
      const sessionsProblem = validateTraceSessions(bin.traceSessions, subject);
      if (sessionsProblem !== null) return sessionsProblem;
      sessionIds = new Set(
        (bin.traceSessions as Record<string, unknown>[]).map((s) => s.id as string),
      );
    } else {
      // A bin without a session list is a version 10 (or earlier) bin still
      // carrying the single-photo fields; validate those for the migration.
      const legacyProblem = validateTraceSource(bin, subject);
      if (legacyProblem !== null) return legacyProblem;
    }
    const pocketsProblem = validatePockets(bin.pockets, subject, sessionIds);
    if (pocketsProblem !== null) return pocketsProblem;
    return validateCavityEdits(bin.edits, subject);
  }
```

In `pickBin`:

```ts
  if (raw.origin === 'traced') {
    let traceSessions: TraceSession[];
    let migratedSessionId: string | null = null;
    if (raw.traceSessions !== undefined) {
      traceSessions = pickTraceSessions(raw);
    } else if (typeof raw.traceSourceId === 'string' && raw.paper !== undefined) {
      // Version 10 migration: the bin-level photo becomes one session that
      // every tool with stored clicks references.
      const session: TraceSession = {
        id: crypto.randomUUID(),
        traceSourceId: raw.traceSourceId,
        paper: pickTracePaper(raw.paper as Record<string, unknown>),
      };
      traceSessions = [session];
      migratedSessionId = session.id;
    } else {
      traceSessions = [];
    }
    return {
      ...envelope,
      origin: 'traced',
      pockets: pickPockets(raw.pockets as Record<string, unknown>, migratedSessionId),
      edits: pickCavityEdits(raw),
      traceSessions,
    };
  }
```

Delete `assignTraceSource` (nothing calls it now). Keep `pickTracePaper` (both `pickTraceSessions` and the migration use it). A migrated bin whose session no tool ends up referencing (all tools had empty clicks) keeps the session on load; the reference-count rule applies on save (Task 4), not on read, so a photo the owner might still re-trace against is not dropped by merely opening the plan.

3e. Update the version-history comment (planFile.ts lines 1926-1928). Replace the last sentence ("Version 11 adds the outline source ...") with:

```
  // Version 11 reshapes traced bins around trace sessions: the bin carries a
  // traceSessions list (each session one photographed sheet with its stored
  // photo id and paper corners), and every pocket tool carries a
  // self-contained source (a photo source naming its session and owning its
  // clicks and brush strokes, an embedded sketch, or a primitive shape).
  // Version 10 bins carry a single bin-level traceSourceId and paper and
  // tool-level clicks; on load these become one session, tools with clicks
  // become photo tools referencing it, and the rest become primitives.
```

3f. If `web/src/stores/binQueue.ts` or components call `pickPockets` or `validatePockets` directly (check with grep), pass the new arguments (`null` sessionIds / `null` migratedSessionId only where the value is genuinely legacy; a compile error here means the call site must decide, do not default silently).

- [ ] **Step 4: Run the plan tests**

Run: `npx vitest run tests/plan/planFile.spec.ts`
Expected: PASS, including all pre-existing tests (update any older fixture in that file still using tool-level `clicks` under `version: 11` to the new source shape, or to `version: 10` if it is deliberately exercising migration).

- [ ] **Step 5: Typecheck**

Run: `npx vue-tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Reshape plan v11 around trace sessions and migrate v10 bins."
```

---

### Task 3: Photo sweep follows sessions

`referencedAssetIds` already collects `session.traceSourceId` after Task 1; this task pins it with tests so orphaned session photos are provably swept and referenced ones kept.

**Files:**
- Modify: `web/src/engine/plan/storedAssets.ts` (only if the test finds a gap)
- Test: `web/tests/plan/storedAssets.spec.ts` (extend the existing spec; if the file does not exist, create it following the fake-store pattern described in storedAssets.ts's header comment)

**Interfaces:**
- Consumes: `TracedBin.traceSessions` from Task 1.

- [ ] **Step 1: Write the failing test**

In the storedAssets spec, add (reusing the file's existing fake-store helpers and entry builders where present; the traced bin fixture is spelled out here):

```ts
it('keeps every session photo a traced bin references and sweeps the rest', async () => {
  const bin = {
    origin: 'traced' as const,
    gridX: 1,
    gridY: 1,
    heightUnits: 6,
    magnetHoles: false,
    pockets: { tools: [], placements: [] },
    edits: [],
    traceSessions: [
      {
        id: 's1',
        traceSourceId: 'photo-a',
        paper: {
          kind: 'a4' as const,
          corners: {
            tl: { x: 0, y: 0 },
            tr: { x: 100, y: 0 },
            br: { x: 100, y: 140 },
            bl: { x: 0, y: 140 },
          },
        },
      },
      {
        id: 's2',
        traceSourceId: 'photo-b',
        paper: {
          kind: 'a4' as const,
          corners: {
            tl: { x: 0, y: 0 },
            tr: { x: 100, y: 0 },
            br: { x: 100, y: 140 },
            bl: { x: 0, y: 140 },
          },
        },
      },
    ],
  };
  const entry = {
    id: 'e1',
    createdAt: '2026-07-25T00:00:00.000Z',
    quantity: 1,
    product: { kind: 'bin' as const, bin, labelSlot: false },
  };
  const referenced = referencedAssetIds([entry], []);
  expect(referenced.tracePhotos).toEqual(new Set(['photo-a', 'photo-b']));
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/plan/storedAssets.spec.ts`
Expected: PASS already if Task 1's storedAssets edit landed; if it fails, fix the traced branch of `referencedAssetIds` to loop `bin.traceSessions` exactly as shown in Task 1 Step 4.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Pin the photo sweep to trace session references."
```

---

### Task 4: Session reference-counting on save

The save path stores only sessions at least one tool references, writes each referenced session's photo blob to the photo store, and lets the existing sweep drop everything else. A sketch-only bin therefore saves with `traceSessions: []` and zero photo data by construction.

**Files:**
- Modify: `web/src/components/trace/LayoutWorkspace.vue:292-382` (storeTraceSource replaced, addToQueue)
- Modify: `web/src/engine/trace/layoutModel.ts` (new pure helper `referencedSessionIds`)
- Test: `web/tests/trace/layoutModel.spec.ts` (extend the existing layoutModel spec; create it in that location if absent)

**Interfaces:**
- Consumes: store session state from Task 5 is NOT needed here in full; this task uses `trace.sessions` and `trace.sessionBlobs` which Task 5 introduces. **Execute Task 5 before Task 4 if working strictly in order matters to you; the tasks are written in spec order but Task 4's Vue steps compile only after Task 5.** The pure helper and its test (Steps 1-3) have no such dependency.
- Produces: `referencedSessionIds(tools: readonly TracedTool[]): Set<string>` in layoutModel.ts.

- [ ] **Step 1: Write the failing test for the pure helper**

```ts
import { referencedSessionIds } from '../../src/engine/trace/layoutModel';

it('collects exactly the session ids photo tools reference', () => {
  const base = {
    id: '',
    name: 'Tool',
    outline: { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] },
    rotationDeg: 0,
    offsetMm: 0,
    mirrored: false,
    minHoleWidthMm: 0,
    filledHoleIndices: [],
    fingerHoles: [],
  };
  const tools = [
    { ...base, id: 't1', source: { kind: 'photo' as const, sessionId: 's1', clicks: [] } },
    { ...base, id: 't2', source: { kind: 'photo' as const, sessionId: 's1', clicks: [] } },
    { ...base, id: 't3', source: { kind: 'primitive' as const } },
    {
      ...base,
      id: 't4',
      source: {
        kind: 'sketch' as const,
        sketch: { schemaVersion: SKETCH_SCHEMA_VERSION, entities: [], constraints: [] },
      },
    },
  ];
  expect(referencedSessionIds(tools)).toEqual(new Set(['s1']));
});
```

(Import `SKETCH_SCHEMA_VERSION` from `../../src/engine/sketch/model`; if an empty-entity sketch fails a type check, reuse the point-plus-circle sketch fixture from Task 1 Step 1.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/trace/layoutModel.spec.ts`
Expected: FAIL with `referencedSessionIds` not exported.

- [ ] **Step 3: Implement the helper in layoutModel.ts**

```ts
/**
 * The trace-session ids the given tools still reference. A session absent
 * from this set is an orphan: it is not saved with the bin and its stored
 * photo is swept. Exhaustive over the source kinds so a future source that
 * references a session must be named here.
 */
export function referencedSessionIds(tools: readonly TracedTool[]): Set<string> {
  const ids = new Set<string>();
  for (const tool of tools) {
    switch (tool.source.kind) {
      case 'photo':
        ids.add(tool.source.sessionId);
        break;
      case 'sketch':
      case 'primitive':
        break;
      default:
        assertNever(tool.source);
    }
  }
  return ids;
}
```

(Import `assertNever` from `../plan/types` if layoutModel.ts does not already.)

Run: `npx vitest run tests/trace/layoutModel.spec.ts`
Expected: PASS.

- [ ] **Step 4: Rewire the save path in LayoutWorkspace.vue** (requires Task 5's store state)

Replace `storeTraceSource` (lines 296-319) with:

```ts
/**
 * The sessions to save with the entry: exactly those some photo tool still
 * references, with each one's photo bytes written to the photo store first.
 * Orphaned sessions are simply not included; persisting the plan then sweeps
 * their stored photos. A failed photo write keeps the session out of the
 * saved list (its tools become layout-only editable later) and says so.
 */
async function storeReferencedSessions(): Promise<TraceSession[]> {
  const referenced = referencedSessionIds(trace.tools);
  const saved: TraceSession[] = [];
  for (const session of trace.sessions) {
    if (!referenced.has(session.id)) continue;
    const blob = trace.sessionBlobs.get(session.id);
    if (blob !== undefined) {
      try {
        await putPhoto(session.traceSourceId, blob);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        photoNote.value = `Storing a trace photo failed (${detail}). The bin was saved, but tools traced on that sheet cannot be re-traced later without the photo.`;
        continue;
      }
    }
    saved.push(JSON.parse(JSON.stringify(session)) as TraceSession);
  }
  return saved;
}
```

In `addToQueue`, replace the `storeTraceSource` call and the `traceSourceId`/`paper` assignment block (lines 336, 355-358) with:

```ts
  const traceSessions = await storeReferencedSessions();
```

and build the bin as:

```ts
  const bin: TracedBin = {
    origin: 'traced',
    gridX: params.gridX,
    gridY: params.gridY,
    heightUnits: params.heightUnits,
    magnetHoles: params.magnetHoles,
    pockets,
    edits: trace.edits.map(cloneEdit),
    traceSessions,
  };
```

Delete the `editingBin` fallback merge of `traceSourceId`/`paper` (the sessions list is rehydrated into the store when an edit opens, Task 6, so the store is the single source at save time). Update imports: `TraceSession` and `referencedSessionIds`; drop `TracePaper` and `PaperCorners` if now unused.

- [ ] **Step 5: Typecheck**

Run: `npx vue-tsc --noEmit`
Expected: clean (after Task 5 is in).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Reference-count trace sessions on save and drop orphaned photos."
```

---

### Task 5: toolTrace store active-session state and atomic activation

The store's single-photo fields become the state of the one active session. Activation is a single atomic action: clear everything, load the session's photo into the vision worker, apply its saved corners, rectify, embed. `embedReady` is derived from a session-id key so a re-trace can never run against a stale sheet's calibration.

**Files:**
- Modify: `web/src/stores/toolTrace.ts`
- Modify: `web/src/components/trace/PhotoStage.vue:143` area (new-photo path registers a session)
- Modify: `web/src/components/trace/TraceCanvas.vue` (accept handler uses `trace.activeSessionId`, removing Task 1's placeholder)
- Test: `web/tests/stores/toolTrace.spec.ts`

**Interfaces:**
- Consumes: `TraceSession` (Task 1), `loadPhoto`, `rectifyPaper`, `embedImage` from `web/src/visionClient.ts` (existing exports, used today by TraceTab.vue).
- Produces on the store:
  - `sessions: Ref<TraceSession[]>` (the bin's sheets, saved or pending)
  - `sessionBlobs: Map<string, Blob>` (photo bytes by session id, non-reactive)
  - `activeSessionId: Ref<string | null>`
  - `embedReadySessionId: Ref<string | null>` and computed `embedReady: boolean` (true iff `activeSessionId !== null && embedReadySessionId === activeSessionId`)
  - `startPhotoSession(blob: Blob, url: string, size: {width: number; height: number}): string` (returns the new session id)
  - `commitSessionPaper(): void` (upserts the active session's paper from the current calibration)
  - `activateSession(sessionId: string, blob: Blob): Promise<void>` (atomic; throws on worker failure, caller shows the message)
  - `reset()` additionally clears sessions, blobs and the new refs.

- [ ] **Step 1: Write the failing tests**

Add to `web/tests/stores/toolTrace.spec.ts`. Mock the vision client at the top of the file (before imports of the store):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rectifyCalls: unknown[] = [];
vi.mock('../../src/visionClient', () => ({
  loadPhoto: vi.fn(async () => ({ width: 400, height: 300 })),
  rectifyPaper: vi.fn(async (corners: unknown, kind: unknown) => {
    rectifyCalls.push([corners, kind]);
    return {
      calibration: {
        corners,
        kind,
        mmPerPixel: 0.5,
        rectifiedWidthPx: 420,
        rectifiedHeightPx: 594,
      },
      preview: null,
    };
  }),
  embedImage: vi.fn(async () => ({ encodeMs: 1 })),
}));
```

(If `rectifyPaper`'s real return type makes `preview: null` fail the typecheck, cast the mock module with `as unknown as typeof import('../../src/visionClient')`; ImageData does not exist in node.)

```ts
const paper = {
  kind: 'a4' as const,
  corners: {
    tl: { x: 0, y: 0 },
    tr: { x: 100, y: 0 },
    br: { x: 100, y: 140 },
    bl: { x: 0, y: 140 },
  },
};

describe('toolTrace active session', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('keys embedReady by session so a stale embed never reads as ready', async () => {
    const trace = useToolTrace();
    trace.sessions = [
      { id: 's1', traceSourceId: 'p1', paper },
      { id: 's2', traceSourceId: 'p2', paper },
    ];
    await trace.activateSession('s1', new Blob(['a']));
    expect(trace.activeSessionId).toBe('s1');
    expect(trace.embedReady).toBe(true);
    // Activating the next session invalidates the old embed the instant the
    // switch starts; wrong millimeters otherwise.
    const activation = trace.activateSession('s2', new Blob(['b']));
    expect(trace.embedReady).toBe(false);
    await activation;
    expect(trace.embedReady).toBe(true);
    expect(trace.activeSessionId).toBe('s2');
  });

  it('applies the activated session saved corners without re-detection', async () => {
    const trace = useToolTrace();
    trace.sessions = [{ id: 's1', traceSourceId: 'p1', paper }];
    rectifyCalls.length = 0;
    await trace.activateSession('s1', new Blob(['a']));
    expect(rectifyCalls).toHaveLength(1);
    expect(rectifyCalls[0]).toEqual([paper.corners, 'a4']);
    expect(trace.calibration?.kind).toBe('a4');
  });

  it('clears the prior session calibration before loading the next', async () => {
    const trace = useToolTrace();
    trace.sessions = [
      { id: 's1', traceSourceId: 'p1', paper },
      { id: 's2', traceSourceId: 'p2', paper },
    ];
    await trace.activateSession('s1', new Blob(['a']));
    const first = trace.calibration;
    await trace.activateSession('s2', new Blob(['b']));
    expect(trace.calibration).not.toBe(first);
    expect(trace.corners).toEqual(paper.corners);
  });

  it('rejects activating a session the store does not hold', async () => {
    const trace = useToolTrace();
    await expect(trace.activateSession('nope', new Blob(['a']))).rejects.toThrow();
  });

  it('registers a fresh photo upload as a new pending session', () => {
    const trace = useToolTrace();
    const id = trace.startPhotoSession(new Blob(['a']), 'blob:x', { width: 4, height: 3 });
    expect(trace.activeSessionId).toBe(id);
    expect(trace.sessionBlobs.get(id)).toBeInstanceOf(Blob);
    expect(trace.embedReady).toBe(false);
  });

  it('clears sessions and the active key on reset', async () => {
    const trace = useToolTrace();
    trace.sessions = [{ id: 's1', traceSourceId: 'p1', paper }];
    await trace.activateSession('s1', new Blob(['a']));
    trace.reset();
    expect(trace.sessions).toEqual([]);
    expect(trace.activeSessionId).toBeNull();
    expect(trace.embedReady).toBe(false);
    expect(trace.sessionBlobs.size).toBe(0);
  });
});
```

Note on jsdom: `URL.createObjectURL`/`revokeObjectURL` may be absent in the node test environment; guard the store's revoke calls with `typeof URL.revokeObjectURL === 'function'`, or stub them in the spec's `beforeEach` (`URL.createObjectURL ??= () => 'blob:test'; URL.revokeObjectURL ??= () => {};`). Prefer the spec-side stub; the store code stays clean.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/stores/toolTrace.spec.ts`
Expected: FAIL (`activateSession` is not a function).

- [ ] **Step 3: Implement the store state**

In `web/src/stores/toolTrace.ts`:

Add imports: `import { embedImage, loadPhoto, rectifyPaper } from '../visionClient';` and `TraceSession` to the type imports.

Replace the `sourceId` ref and the plain `embedReady` ref (keep `photoUrl`, `photoBlob`, `photoSize`, `corners`, `paperKind`, `calibration`, `rectifiedPreview`, `encodeMs`: they are now the active session's working state) with:

```ts
  /** The bin's trace sessions: every photographed sheet, saved or pending. */
  const sessions = ref<TraceSession[]>([]);
  /**
   * Photo bytes by session id, for sessions whose photo is loaded on this
   * page (a fresh upload, or a stored photo fetched for re-tracing).
   * Deliberately a plain Map outside reactivity: blobs are multi-megabyte.
   */
  const sessionBlobs = new Map<string, Blob>();
  /** The session the single-photo working state below belongs to. */
  const activeSessionId = ref<string | null>(null);
  /**
   * The session id the current MobileSAM embedding was computed for. Kept
   * separately from activeSessionId so a half-finished activation reads as
   * not ready: embedReady is true only when the two agree, which makes it
   * impossible for a re-trace to run against a stale sheet's calibration.
   */
  const embedReadySessionId = ref<string | null>(null);
  /** True once the embedding of the ACTIVE session's rectified sheet is ready. */
  const embedReady = computed(
    () => activeSessionId.value !== null && embedReadySessionId.value === activeSessionId.value,
  );
```

Add a private helper and the three actions:

```ts
  /** Clears the single-photo working state; every activation path starts here. */
  function clearActivePhotoState(): void {
    if (photoUrl.value !== null && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(photoUrl.value);
    }
    photoUrl.value = null;
    photoBlob.value = null;
    photoSize.value = null;
    corners.value = null;
    calibration.value = null;
    rectifiedPreview.value = null;
    embedReadySessionId.value = null;
    encodeMs.value = null;
    activeSessionId.value = null;
  }

  /**
   * Registers a freshly uploaded photo as a new pending session and makes it
   * active. The session enters the sessions list once its sheet corners are
   * confirmed (commitSessionPaper); until then it exists only as the active
   * working state plus its blob.
   */
  function startPhotoSession(
    blob: Blob,
    url: string,
    size: { width: number; height: number },
  ): string {
    clearActivePhotoState();
    const id = crypto.randomUUID();
    sessionBlobs.set(id, blob);
    activeSessionId.value = id;
    photoBlob.value = blob;
    photoUrl.value = url;
    photoSize.value = size;
    return id;
  }

  /**
   * Records the active session's confirmed paper setup from the current
   * calibration, inserting the session into the list or updating it in place
   * (corners re-confirmed after an adjustment).
   */
  function commitSessionPaper(): void {
    const id = activeSessionId.value;
    const cal = calibration.value;
    if (id === null || cal === null) return;
    const paper = {
      corners: JSON.parse(JSON.stringify(cal.corners)) as PaperCorners,
      kind: cal.kind,
    };
    const existing = sessions.value.find((s) => s.id === id);
    if (existing !== undefined) {
      existing.paper = paper;
    } else {
      sessions.value.push({ id, traceSourceId: crypto.randomUUID(), paper });
    }
  }

  /**
   * Atomically makes a session the active one: clears every piece of the
   * prior sheet's state first (so nothing stale can be read mid-switch),
   * then loads the session's photo into the vision worker, applies its saved
   * corners without re-detection, rectifies and embeds. embedReady turns
   * true only at the very end and only for this session. Worker failures
   * propagate to the caller, which shows the message; the state is left
   * cleared, never half-activated.
   */
  async function activateSession(sessionId: string, blob: Blob): Promise<void> {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (session === undefined) {
      throw new Error('The photo sheet to activate is not part of this bin.');
    }
    clearActivePhotoState();
    activeSessionId.value = sessionId;
    sessionBlobs.set(sessionId, blob);
    const info = await loadPhoto(await blob.arrayBuffer());
    photoBlob.value = blob;
    photoUrl.value =
      typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
    photoSize.value = info;
    corners.value = JSON.parse(JSON.stringify(session.paper.corners)) as PaperCorners;
    paperKind.value = session.paper.kind;
    const rectified = await rectifyPaper(session.paper.corners, session.paper.kind);
    calibration.value = rectified.calibration;
    rectifiedPreview.value = rectified.preview;
    const embed = await embedImage();
    encodeMs.value = embed.encodeMs;
    embedReadySessionId.value = sessionId;
  }
```

Extend `reset()`: replace the old photo-field lines with a `clearActivePhotoState()` call plus `sessions.value = []; sessionBlobs.clear();`. Extend the returned object with `sessions, sessionBlobs, activeSessionId, embedReadySessionId, embedReady, startPhotoSession, commitSessionPaper, activateSession` and remove `sourceId`. Note `embedReady` is now a computed: any code that assigned `trace.embedReady = ...` must be rewritten (the compiler finds them: TraceTab.vue's `resumeTrace`, PhotoStage.vue's embed step). PhotoStage's embed completion becomes `trace.embedReadySessionId = trace.activeSessionId;` and its new-photo handler calls `trace.startPhotoSession(file, url, info)` instead of assigning `photoBlob`/`photoUrl`/`photoSize` piecemeal (adapt to the file's actual local variable names at line 143's surroundings; the sheet-confirm handler additionally calls `trace.commitSessionPaper()` after a successful rectify at line 363's surroundings). TraceTab.vue's `resumeTrace` is deleted outright in Task 6; to keep this task compiling, replace its body with a call to `trace.activateSession(...)` for the bin's single stored session or leave the file to Task 6 and run the two tasks in one worktree session if the intermediate typecheck bothers you. The plan's task boundary assumption: Task 5 and Task 6 land as consecutive commits and only the Task 6 commit needs the full app to typecheck; run the store spec here, the full `vue-tsc` gate after Task 6.

In `web/src/components/trace/TraceCanvas.vue`, replace Task 1's placeholder line with:

```ts
    sessionId: store.activeSessionId ?? '',
```

and guard the accept handler's entry: if `store.activeSessionId === null`, return early (tracing is impossible without an active session; the canvas only renders when `embedReady`, which now implies an active session, so this is a type guard, not a reachable branch).

- [ ] **Step 4: Run the store tests**

Run: `npx vitest run tests/stores/toolTrace.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Turn the toolTrace store photo state into atomic active-session state."
```

---

### Task 6: Source list stage and workspace entry/exit rewiring

The input stage becomes a source list (one card per session, one per sketched tool, plus "Add a photo sheet" and "Draw a shape"); the `traceInput` toggle and `sketchCancelStage` mechanism go away; the trace and sketch workspaces are modal work entered from a card with "Back to sources"; re-trace atomically activates the tool's session; the breadcrumb's first chip becomes "Sources".

**Files:**
- Create: `web/src/components/trace/SourceListStage.vue`
- Modify: `web/src/components/trace/TraceTab.vue` (full rework of stage state, script and template)
- Modify: `web/src/components/trace/PhotoStage.vue` (emit unchanged; confirm handler already commits the session via Task 5)
- Modify: `web/src/components/trace/SketchWorkspace.vue` (only if its cancel button label needs the "Back to sources" wording; its `cancel`/`finish` emits stay)

**Interfaces:**
- Consumes: store state and actions from Task 5, `editActionOf` from Task 1, `getPhoto` from `web/src/photoStore.ts`.
- Produces: `SourceListStage.vue` with props `{ sessions: TraceSession[]; sketchTools: TracedTool[]; busy: boolean }` and emits `{ openSheet: [sessionId: string]; openSketch: [toolId: string]; addPhoto: []; drawShape: [] }`.

- [ ] **Step 1: Create SourceListStage.vue**

```vue
<script setup lang="ts">
import type { TracedTool, TraceSession } from '../../engine/trace/types';

/**
 * The Sources stage of the Tool trace tab: one card per photographed sheet
 * and per sketched tool, plus the two actions that add a new source. With no
 * sources yet, only the two large actions show, so the common single-sheet
 * or single-sketch flow stays as short as the old two-button screen.
 */

const props = defineProps<{
  sessions: TraceSession[];
  sketchTools: TracedTool[];
  busy: boolean;
}>();

const emit = defineEmits<{
  openSheet: [sessionId: string];
  openSketch: [toolId: string];
  addPhoto: [];
  drawShape: [];
}>();
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div v-if="props.sessions.length > 0 || props.sketchTools.length > 0" class="source-grid">
      <v-card
        v-for="(session, index) in props.sessions"
        :key="session.id"
        :disabled="props.busy"
        variant="outlined"
        class="source-card"
        @click="emit('openSheet', session.id)"
      >
        <v-card-item>
          <v-card-title class="text-body-1">Photo sheet {{ index + 1 }}</v-card-title>
          <v-card-subtitle>
            {{ session.paper.kind === 'a4' ? 'A4 sheet' : 'Letter sheet' }}. Open to trace
            more tools or re-trace existing ones.
          </v-card-subtitle>
        </v-card-item>
      </v-card>
      <v-card
        v-for="tool in props.sketchTools"
        :key="tool.id"
        :disabled="props.busy"
        variant="outlined"
        class="source-card"
        @click="emit('openSketch', tool.id)"
      >
        <v-card-item>
          <v-card-title class="text-body-1">{{ tool.name }}</v-card-title>
          <v-card-subtitle>Sketched shape. Open to edit the sketch.</v-card-subtitle>
        </v-card-item>
      </v-card>
    </div>
    <div class="d-flex flex-wrap ga-3">
      <v-btn
        :disabled="props.busy"
        size="large"
        prepend-icon="mdi-camera-plus"
        @click="emit('addPhoto')"
      >
        Add a photo sheet
      </v-btn>
      <v-btn
        :disabled="props.busy"
        size="large"
        prepend-icon="mdi-draw"
        @click="emit('drawShape')"
      >
        Draw a shape
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.source-card {
  cursor: pointer;
}
@media (max-width: 599px) {
  /* Source cards stack full width in one column on phones (375 px). */
  .source-grid {
    grid-template-columns: 1fr;
  }
}
</style>
```

- [ ] **Step 2: Rework TraceTab.vue**

Replace the stage model and the sketch/photo entry logic. Full new script for the changed regions (unchanged parts, such as `editingEntry`, `editingBin`, `finishSketch`'s validation body, `workspaceReady`, are kept as they are unless named):

Stage state:

```ts
/** Which screen the tab shows. Workspaces are modal work on one source. */
const stage = ref<'sources' | 'photo' | 'sketch' | 'workspace'>('sources');
```

Delete `traceInput` (line 43) and `sketchCancelStage` (line 51), `startSketch`, `cancelSketch` as written. New source-stage handlers:

```ts
/** Sketched tools, one source card each. */
const sketchTools = computed(() => trace.tools.filter((t) => t.source.kind === 'sketch'));

/** Starts a fresh sketch from the Sources stage. */
function drawShape(): void {
  sketchEditor.startNewSketch();
  stage.value = 'sketch';
}

/** Opens the photo stage to add a new sheet. */
function addPhotoSheet(): void {
  stage.value = 'photo';
}

/** Every workspace's way back; also the breadcrumb's first chip. */
function backToSources(): void {
  stage.value = 'sources';
}

/**
 * Loads a session's photo (from the page's blob map, or the photo store)
 * and atomically activates it. Returns false with sourcesError set when the
 * photo is not available on this device.
 */
const sourcesBusy = ref(false);
const sourcesError = ref<string | null>(null);

async function ensureSessionActive(sessionId: string): Promise<boolean> {
  if (trace.activeSessionId === sessionId && trace.embedReady) return true;
  const session = trace.sessions.find((s) => s.id === sessionId);
  if (session === undefined) {
    sourcesError.value = 'That photo sheet is no longer part of this bin.';
    return false;
  }
  sourcesBusy.value = true;
  sourcesError.value = null;
  try {
    let blob = trace.sessionBlobs.get(sessionId) ?? null;
    if (blob === null) blob = await getPhoto(session.traceSourceId);
    if (blob === null) {
      sourcesError.value =
        'The photo of this sheet is not stored on this device, so its tools cannot be re-traced. You can still edit the layout.';
      return false;
    }
    await trace.activateSession(sessionId, blob);
    return true;
  } catch (error) {
    sourcesError.value =
      error instanceof Error ? error.message : 'Restoring the trace photo failed.';
    return false;
  } finally {
    sourcesBusy.value = false;
  }
}

/** A sheet card: activate its session and open the trace workspace. */
async function openSheet(sessionId: string): Promise<void> {
  if (!(await ensureSessionActive(sessionId))) return;
  stage.value = 'workspace';
  trace.workspaceMode = 'trace';
}

/** A sketch card: open the tool's stored sketch in the sketch workspace. */
function editSketchedTool(toolId: string): void {
  const tool = trace.tools.find((t) => t.id === toolId);
  if (tool === undefined) return;
  switch (tool.source.kind) {
    case 'photo':
      return; // photo tools re-trace through onRetrace instead
    case 'sketch':
      sketchEditor.loadSketch(tool.source.sketch, toolId);
      stage.value = 'sketch';
      return;
    case 'primitive':
      return; // a primitive shape has nothing to reopen
    default:
      return assertNever(tool.source);
  }
}
```

`finishSketch` keeps its validation body; its exit lines (109-111) become:

```ts
  stage.value = 'workspace';
  trace.workspaceMode = 'layout';
```

and its re-edit branch uses `trace.replaceToolOutline(tool.id, profile.outline, source);` (already done in Task 1). The sketch workspace's cancel handler becomes:

```ts
/** Cancelling the sketch returns to the stage that opened it: the source list. */
function cancelSketch(): void {
  stage.value = 'sources';
}
```

Delete `storedPhoto`, `photoMissing`, `lookUpStoredPhoto` and `resumeTrace` (lines 148-206): the per-session lookup in `ensureSessionActive` replaces all of them. `resumeBusy`/`resumeError` are replaced by `sourcesBusy`/`sourcesError`. The photo-missing hint in the layout template keys off `sourcesError` now.

The editing watch (lines 213-258) changes: replace `void lookUpStoredPhoto(bin);` with `trace.sessions = JSON.parse(JSON.stringify(bin.traceSessions)) as TraceSession[];` and keep the rest; its final lines become `stage.value = 'workspace'; trace.workspaceMode = 'layout';`. Import `TraceSession` in the type imports and `getPhoto` stays imported.

`traceModeAvailable` (line 267) becomes: the selected tool's session can be activated, which is only knowable per tool; for the toolbar's generic "trace another" affordance use:

```ts
/** True when some sheet exists to trace on (active now or restorable). */
const traceModeAvailable = computed(() => trace.embedReady || trace.sessions.length > 0);
```

The zero-tools fallback watch (lines 282-289): replace `void setWorkspaceMode('trace')` with `backToSources()` and drop the `traceModeAvailable` condition: with no tools the workspace has nothing to lay out, and the source list is now the home that offers every way forward. Delete `setWorkspaceMode` entirely; the "trace another" toolbar event now routes:

```ts
/** The toolbar's trace-another action: back to the source list to pick a sheet. */
function onTraceAnother(): void {
  if (trace.sessions.length === 1) {
    // One sheet: skip the list and go straight back to tracing on it.
    void openSheet(trace.sessions[0].id);
    return;
  }
  backToSources();
}
```

`onRetrace` becomes:

```ts
/** Re-traces a photo tool: activate its own session, then open trace mode. */
async function onRetrace(toolId: string): Promise<void> {
  const tool = trace.tools.find((t) => t.id === toolId);
  if (tool === undefined || tool.source.kind !== 'photo') return;
  if (!(await ensureSessionActive(tool.source.sessionId))) return;
  trace.selectedToolId = toolId;
  trace.retraceRequestId = toolId;
  stage.value = 'workspace';
  trace.workspaceMode = 'trace';
}
```

`openPhotoStage` is deleted (the breadcrumb's first chip now calls `backToSources`). `onPhotoReplaced` reduces to clearing `sourcesError`. `onSheetConfirmed` becomes:

```ts
function onSheetConfirmed(): void {
  // PhotoStage committed the session's paper on confirm; tracing starts now.
  stage.value = 'workspace';
  trace.workspaceMode = 'trace';
}
```

`restart` sets `stage.value = 'sources'` and keeps `trace.reset()`.

New template:

```vue
<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center ga-1 breadcrumb">
      <v-chip
        :variant="stage !== 'workspace' ? 'flat' : 'outlined'"
        :color="stage !== 'workspace' ? 'primary' : undefined"
        size="small"
        label
        @click="backToSources"
      >
        Sources
      </v-chip>
      <v-icon icon="mdi-chevron-right" size="16" class="text-medium-emphasis" />
      <v-chip
        :variant="stage === 'workspace' ? 'flat' : 'outlined'"
        :color="stage === 'workspace' ? 'primary' : undefined"
        :disabled="!workspaceReady"
        size="small"
        label
        @click="stage = 'workspace'"
      >
        Trace and lay out
      </v-chip>
    </div>

    <template v-if="stage === 'sources'">
      <v-alert v-if="sourcesError" type="error" density="compact">
        {{ sourcesError }}
      </v-alert>
      <v-progress-linear v-if="sourcesBusy" indeterminate />
      <SourceListStage
        :sessions="trace.sessions"
        :sketch-tools="sketchTools"
        :busy="sourcesBusy"
        @open-sheet="openSheet"
        @open-sketch="editSketchedTool"
        @add-photo="addPhotoSheet"
        @draw-shape="drawShape"
      />
    </template>

    <template v-else-if="stage === 'photo'">
      <div>
        <v-btn variant="outlined" prepend-icon="mdi-arrow-left" @click="backToSources">
          Back to sources
        </v-btn>
      </div>
      <PhotoStage @confirmed="onSheetConfirmed" @photo-replaced="onPhotoReplaced" />
    </template>

    <template v-else-if="stage === 'sketch'">
      <v-alert v-if="sketchFinishError !== null" type="error" density="compact" class="mb-2">
        {{ sketchFinishError }}
      </v-alert>
      <SketchWorkspace @cancel="cancelSketch" @finish="finishSketch" />
    </template>

    <div v-else>
      <div v-show="workspaceMode === 'trace'">
        <div class="mb-3">
          <v-btn
            variant="outlined"
            prepend-icon="mdi-arrow-left"
            @click="tools.length > 0 ? (trace.workspaceMode = 'layout') : backToSources()"
          >
            {{ tools.length > 0 ? 'Back to layout' : 'Back to sources' }}
          </v-btn>
        </div>
        <TraceCanvas v-if="embedReady" @accepted="workspaceMode = 'layout'" />
      </div>
      <div v-show="workspaceMode === 'layout'">
        <v-alert v-if="sourcesError" type="error" density="compact" class="mb-2">
          {{ sourcesError }}
        </v-alert>
        <p v-if="sourcesBusy" class="text-body-2 text-medium-emphasis">
          Restoring the stored trace photo.
        </p>
        <v-progress-linear v-if="sourcesBusy" indeterminate class="mb-2" />
        <LayoutWorkspace
          :editing-entry="editingEntry"
          :retrace-available="traceModeAvailable"
          @trace-another="onTraceAnother"
          @retrace="onRetrace"
          @edit-sketch="editSketchedTool"
          @saved="restart"
          @cancelled="restart"
        />
      </div>
    </div>
  </div>
</template>
```

Add `import SourceListStage from './SourceListStage.vue';` and drop the `v-btn-toggle` block, the old stage-1 template, and any now-unused imports (`shallowRef`, `TracedBin` if unused, `PaperCorners`, `loadPhoto`, `rectifyPaper`, `embedImage`: the store owns those calls now).

Also check `web/src/components/trace/PhotoStage.vue` for a "start over with a new photo" path that previously reset the whole trace store; with multiple sheets, replacing the photo before confirm must only replace the pending session (call `trace.startPhotoSession` again; the superseded pending id is simply never committed and its blob entry is overwritten or left to `reset()`). Do not let it call `trace.reset()` when `trace.tools.length > 0`; if the current code does, gate it: `if (trace.tools.length === 0) trace.reset();` followed by the `startPhotoSession` call, and keep the existing "loading a new photo discards these tools" copy only for the true fresh-start case.

Mobile check (owner's browser check will confirm): workspaces stay full-bleed as today; SourceListStage's one-column grid rule covers 375 px.

- [ ] **Step 3: Typecheck and full test run**

Run: `npx vue-tsc --noEmit`
Expected: clean, including the deferred Task 5 leftovers (no references to `resumeTrace`, `sourceId`, `traceInput` remain; `grep -rn "sourceId\|traceInput\|sketchCancelStage\|resumeTrace" web/src` returns nothing).
Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Replace the input stage with a source list and rewire workspace entry."
```

---

### Task 7: Final gate

- [ ] **Step 1: Full build and tests**

Run (inside `web/`): `npm run build`
Expected: vue-tsc clean, production build succeeds.
Run: `npm test`
Expected: all suites pass.

- [ ] **Step 2: Spec sweep**

Confirm each spec point maps to landed code: three-variant `ToolSource` with owned re-edit data (Task 1); `traceSessions` on the bin, v11 reshaped in place, v10 migration with classification (Task 2); persistence rule, orphan drop via reference counting plus sweep (Tasks 3, 4); atomic activation with session-keyed `embedReady` (Task 5); source list with first-run shortcut, "Sources" breadcrumb chip, modal workspaces with "Back to sources", re-trace activating the tool's own session, edit-sketch direct, `traceInput`/`sketchCancelStage` removed (Task 6). Confirm no em-dash characters were introduced (U+2014, written as an escape here so this plan itself stays clean): `grep -rnP '\x{2014}' web/src` returns nothing.

- [ ] **Step 3: Commit anything outstanding**

```bash
git add -A
git commit -m "Finish the multi-source tool bin data model and source list."
```

Owner-owed afterwards (out of scope for the executor): browser check of the source list flow at desktop and 375 px, and an Orca Slicer check of an exported multi-source bin.
