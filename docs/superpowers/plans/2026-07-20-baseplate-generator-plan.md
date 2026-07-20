# Baseplate generator: implementation plan

Date: 2026-07-20. Companion to `docs/superpowers/specs/2026-07-20-baseplate-generator-design.md`.

This plan orders the work. It does not restate the design. Keep the design document open beside it: every
dimension, type body, algorithm stage, validator message, UI control and test assertion is specified there
and is not repeated here. Where this plan says "per section 4.10", go read section 4.10 and implement what
it says.

What this plan adds on top of the design is the part the design does not carry: what lands in which order,
what fails to compile if you get the order wrong, what two files have to agree about, what green looks
like at each stop, and where you must stop and ask the owner instead of guessing.

## State of the work

- **Branch:** `worktree-baseplate-generator`, in the worktree at
  `E:\Development\GridfinityGenerator\.claude\worktrees\baseplate-generator`. Working tree clean at the
  time of writing.
- **Already committed:** `879e473 Specify the baseplate generator from measured reference geometry.` That
  commit is the design document and nothing else. **No source code for this feature exists yet.** The
  parent commit `1a02db9` is the merge of the divider wall test sweep into `master`.
- **Not yet created:** `web/src/engine/baseplate/` (the whole module), `web/src/engine/gridfinity/shapes.ts`,
  `web/src/stores/baseplateDesigner.ts`, `web/src/components/BaseplateTab.vue`,
  `web/tests/baseplate.spec.ts`, `web/tests/plan/baseplate.spec.ts`, `web/tests/stores/` (the directory
  itself).
- **Verified present**, with the line counts the design's citations were taken against:
  `types.ts` 357, `planFile.ts` 1182, `geometry.ts` 113, `rowDescriptor.ts` 121, `binGenerator.ts` 962,
  `constants.ts` 204, `binDownloads.ts` 232, `AddBinCard.vue` 84, `MainPage.vue` 366, `ManualBinTab.vue`
  326, `MoreOptions.vue` 108, `BatchBox.vue` 315, `useBinPreview.ts` 62, `geometry.worker.ts` 100,
  `workerClient.ts` 58, `binDesigner.ts` 167.
- **Line numbers drift.** Spot checks put the design's citations within about two lines of the real
  positions (for example `prismFromProfile` is cited at `binGenerator.ts:436` and actually sits at 439).
  Locate every insertion point by **symbol name**, not by line number, and treat a cited line as a hint
  about where in the file to look.

### Reference STLs

Eight verified reference STLs and their option-panel screenshots live at:

```
C:\Users\jakob\AppData\Local\Temp\claude\E--Development-GridfinityGenerator\ce5d5b80-a840-467a-8b9a-84cc943c0e98\scratchpad\baseplate-ref\
```

Contents: `1x1-default`, `2x2-default`, `3x2-default`, `2x2-connectable`, `2x2-magnets-full`,
`2x2-screws-full`, `2x2-magnets-screws-connectable`, `connector`, each as a `.stl` plus a `.png` of the
option panel that produced it, and `_run-summary.json`.

Use them **only** to cross-check a dimension you are about to code against, when the design's number
surprises you. Two rules govern that use:

1. **Scratchpad files are temporary.** They will be gone after this session's workspace is cleared. Nothing
   in the implementation may reference that path, and nothing may depend on those files existing.
2. **Any measurement worth keeping belongs in the design document, not in a re-measurement.** If you find a
   number the design does not carry, or one that contradicts it, stop and raise it with the owner so the
   design gets amended. Do not silently re-measure and code against your own figure. That is exactly the
   fudge convention 12 forbids, and the design's section 4.1 records the validation method that made these
   numbers trustworthy in the first place.

### Standing conventions for every stage

- `CLAUDE.md` conventions apply throughout. Convention 6 in particular: no em-dash character anywhere, and
  no hyphen standing in for one, in source, comments, UI text or commit messages.
- Convention 1: no hand-tuned constants. Every dimension traces to the design's section 4.9 table.
- Convention 3: nothing under `web/src/engine/` imports Vue, Pinia or touches the DOM.
- Convention 11: the main agent does not make these edits itself. Each stage is delegated with a
  self-contained prompt.
- The verification bar for **every** stage without exception is `npm run build` plus `npm test` inside
  `web/`, both green. The per-stage bars below are in addition to that, never instead of it.

### Test notation used below

- **`4.12/n`** means test number `n` in the design's geometry test plan (section 4.12, tests 1 to 17).
- **`5.13/n`** means test number `n` in the design's application test plan (section 5.13, tests 1 to 23).
- **`G1` to `G4`** are the application-layer constraints on the geometry layer at the end of section 6.
  They are constraints, not tests. Do not confuse them with `4.12/1` and friends.

---

## Stage 0: shared shape primitives

**Goal.** Move `hullBetween`, `insetPolygon`, `loftChain` and the already-exported `roundedRectPolygon` out
of `binGenerator.ts` into a new shared module, and widen `loftChain`'s signature, so the baseplate module
can reuse them instead of growing a parallel copy.

**Design reference:** section 4.10, "Prerequisite refactor" and "Prerequisite extension to `loftChain`".
Risk R8.

### Files

**Created**

- `web/src/engine/gridfinity/shapes.ts`. Receives `roundedRectPolygon`, `hullBetween`, `insetPolygon`,
  `loftChain` verbatim, with their doc comments, all exported.

**Modified**

- `web/src/engine/gridfinity/binGenerator.ts`. Deletes the four function bodies (currently at lines 65,
  101, 150 and 394), imports them back from `./shapes`, and **re-exports `roundedRectPolygon`**. See the
  agreement note below.

### What to change

`loftChain` gains two optional trailing parameters, `cornerRadius = OUTER_CORNER_RADIUS` and
`segments = CORNER_SEGMENTS`, per section 4.10. Existing call sites pass neither and must stay
character-identical. The point of the widening is stage 2 step 3, which calls `loftChain(m, pitch, pitch,
sections, 0, 0)` to get four sharp corners; if you make the parameters required, or reorder them, stage 2
either will not compile or will silently round the internal cell corners and fail `4.12/6`.

`prismFromProfile` and `buildFoot` **stay in `binGenerator.ts`**. They are not part of this move. Stage 2
imports `prismFromProfile` from `binGenerator.ts` (section 4.10 stage 9) and `4.12/4` imports `buildFoot`
from there too.

### The one thing two files must agree about

`roundedRectPolygon` currently has four import sites outside `binGenerator.ts`:

| File | Line | Symbols imported from `binGenerator` |
| --- | --- | --- |
| `web/src/engine/label/placement.ts` | 16 | `prismFromProfile`, `roundedRectPolygon` |
| `web/src/engine/label/slot.ts` | 9 | `buildOuterEnvelope`, `prismFromProfile`, `roundedRectPolygon` |
| `web/src/engine/trace/pocketBin.ts` | 27 | `roundedRectPolygon` (in a multi-symbol import) |
| `web/tests/binGenerator.spec.ts` | 8 | `roundedRectPolygon` (in a multi-symbol import) |

The test file is the binding constraint. This stage's definition of done forbids touching any test, so
`binGenerator.ts` **must re-export `roundedRectPolygon`** (`export { roundedRectPolygon } from './shapes';`
or equivalent) rather than merely importing it for internal use. An import alone does not re-export in
TypeScript, and `web/tests/binGenerator.spec.ts:8` will fail to resolve.

Given the re-export, the three source import sites may be left alone. Repointing them at `shapes.ts` is
optional tidiness; if you do it, do it in this stage and nowhere later, and it must not change behaviour.

### Dependencies

- **Nothing lands before this.** It is the first stage.
- **Stage 2 cannot start until this is done.** Stage 2's build algorithm is written entirely against
  `loftChain` with the widened signature. Attempting stage 2 first means either duplicating the lofting
  code (a rule 10 violation the design explicitly rules out) or writing a second lofting function.
- Nothing else in the plan depends on stage 0. Stage 1 is independent of it.

### Definition of done

```
cd web
npm run build
npm test
```

Both green, **with no test file modified in this stage**. Confirm that with `git status` and
`git diff --stat`: the diff must contain exactly two paths, `web/src/engine/gridfinity/shapes.ts` (new) and
`web/src/engine/gridfinity/binGenerator.ts` (modified), plus the three optional import repoints if you took
them.

**Stop condition, and it is a hard one.** If any test under `web/tests/` needs an edit to go green, the
move was not behaviour-preserving. Do not edit the test. Revert, work out what actually changed (the usual
culprits are a default parameter that alters an existing call's result, a lost `const` capture of a module
constant, or an import cycle changing evaluation order), and redo the move. A test edit in stage 0 is
evidence of a defect, not of a stale test.

### Tests from the design's test plans

None. Stage 0 introduces no new behaviour and therefore no new test. Its entire proof is that the existing
bin geometry suite, `web/tests/binGenerator.spec.ts` above all, passes untouched.

### Owner checkpoints

None.

---

## Stage 1: data model and plan file

**Goal.** Teach the plan layer that a baseplate and a connection clip are products: types, validation,
file version, row strings and the geometry mapping, with no UI and no geometry.

**Design reference:** sections 5.2, 5.3, 5.5, 5.10 (the `geometry.ts` half only), 5.11, and 5.12's
`downloadSubtitles` table.

### Files

**Created**

- `web/src/engine/baseplate/constants.ts`. See the ordering note below: this stage creates the constants
  and the two parameter interfaces, stage 2 adds the generators beside them.
- `web/src/engine/baseplate/types.ts` (or the interfaces may live in `constants.ts` beside their bounds,
  which is what section 4.0 asks for when it says "declared once, in the baseplate engine module beside its
  bounds constants"). `BaseplateMagnets`, `BaseplateParams`, `ConnectionClipParams` per section 4.11.
- `web/tests/plan/baseplate.spec.ts`.

**Modified**

- `web/src/engine/plan/types.ts`: `BaseplateProduct` and `ConnectionClipProduct` after `InsertProduct`
  (around line 213); the `Product` union; `ProductOrigin` and its doc comment; branches in `insertOf`,
  `binOf` and `originOf`; `PLAN_FILE_VERSION` 5 to 6 (line 356) and `PlanFile.version` with its doc
  comment. `BaseplateMagnets` is **imported** from the baseplate module, never redeclared (section 4.0).
- `web/src/engine/plan/planFile.ts`: new `isNumberInRange` helper beside `isPositiveInteger` (line 41);
  `validateMagnets`, `validateBaseplate`, `validateClip`, `pickBaseplate`; wiring into `validateProduct`
  (line 581) and `pickProduct` (line 626); the explanatory comment at lines 1102 to 1106. New imports:
  `PITCH` from `../gridfinity/constants` and the six bound constants from the baseplate module.
- `web/src/engine/plan/rowDescriptor.ts`: `captionOf` branches (line 84), `describeProduct` branches (line
  101), and the new exported `downloadSubtitles`.
- `web/src/engine/plan/geometry.ts`: `PrintablePart` union members (line 14), new `baseplateParamsOf`,
  `partsOf` branches (line 50), `previewBinParams` branches (line 98).
- `web/src/components/AddBinCard.vue`: **two edits only**, folded forward from stage 4. See dependencies.
- `web/tests/plan/rowDescriptor.spec.ts`, `web/tests/plan/geometry.spec.ts`,
  `web/tests/plan/planFile.spec.ts`: additions per section 5.13.

### What to change

Implement sections 5.2, 5.3, 5.5, 5.11 and the `geometry.ts` half of 5.10 as written. Points an
implementer would otherwise get wrong:

- **`describeProduct` ordering is load-bearing.** The baseplate and clip branches go **before** the
  label-content fallthrough at `rowDescriptor.ts:112`. That fallthrough reads `product.insert` or
  `product.content` and dereferences `.text` on it, so a baseplate reaching it throws at runtime. There is
  no compiler guard on this one: `captionOf` ends in `assertNever` and will flag a missing branch, but
  `describeProduct` will not.
- **`validateBaseplate` checks in a fixed order** (section 5.5): `unitsX`, `unitsY`, `customXMm`,
  `customYMm`, magnets, `screwHoles`, `connectable`. `5.13/9` asserts exact message strings, so a product
  with two bad fields must report the first one in that order.
- **No bound may be a literal in `planFile.ts`.** The four magnet bounds, `BASEPLATE_UNITS_MAX`,
  `CUSTOM_SPAN_MIN` and the two clip tolerance bounds are imported from the baseplate module and
  interpolated into the messages; `PITCH` is imported from `gridfinity/constants`. No `42`, no `20`, no
  `8.2` typed into `planFile.ts`. This is constraint G3 and it is what makes `5.13/10`'s boundary
  acceptance and the UI's slider ranges provably the same numbers.
- **No new legacy read path** (section 5.3). `legacyProductOf` gets no baseplate branch and
  `const legacy = version === 1 || version === 2` at `planFile.ts:1107` is untouched. Only the comment
  block above it changes.
- **`pickBaseplate` copies field by field.** `5.13/12` fails if you spread.
- Do not touch `serializePlanFile`, `mergeEntries` or `mergeBatches`. Section 5.5 is explicit that they
  need no change, and `5.13/13` and `5.13/14` prove it.

### Dependencies

**What must land before this stage:** nothing. Stage 0 and stage 1 are independent and may be done in
either order or in parallel.

**Ordering decision this plan makes** (not a design change): the design's staging note says stage 1 depends
on stage 2 for the *shape* of `BaseplateParams` and `ConnectionClipParams` and the exported constants, and
offers temporary local declarations in `geometry.ts` as the escape hatch. Do not take the escape hatch.
Instead, create `web/src/engine/baseplate/constants.ts` and the parameter interfaces in this stage. They are
pure data and type declarations, they import nothing from manifold, and section 4.9 already names the
baseplate module as their home. Stage 2 then adds `generateBaseplate` and friends beside them and deletes
nothing. This removes the temporary-type churn entirely and, more importantly, means the validators bind to
the real exported constants from the first commit rather than to placeholders that could drift.

If you nonetheless take the design's temporary-type route, the deletion of those temporaries is stage 2's
first task and stage 2 is not done until `grep` finds no temporary declaration left.

**The `AddBinCard.vue` fold-forward, carried explicitly.** Widening `ProductOrigin` to
`'manual' | 'screw' | 'traced' | 'baseplate' | 'clip'` makes `AddBinCard.vue` **fail to compile on its
own**, because `TAB_OF_KIND` is typed `Record<ProductOrigin, TabName>` (line 21) and the record is now
missing two keys. That is the intended safety net, not an accident. Fold stage 4's map edit forward into
this stage rather than stubbing it, so every stage's tree is honest and `npm run build` is green at every
commit. Concretely, in this stage:

- line 18: `type TabName = 'manual' | 'screw' | 'trace' | 'baseplate';`
- lines 21 to 24: add `baseplate: 'baseplate',` and `clip: 'baseplate',` to `TAB_OF_KIND`.

Nothing else in that file. The `v-tab`, the `v-window-item` and the `BaseplateTab` import stay in stage 4.
`tabDisabled` (line 36) and the Ctrl+N watcher (line 28) need no change now or later.

**What breaks if this lands out of order.** Two known interim gaps exist between stage 1 and the stages
that close them. Both are acceptable because no UI can create these products yet, but both are reachable by
**importing a plan file** that contains one, so state them in the stage 1 handover:

1. Between stage 1 and stage 4, `TAB_OF_KIND` maps `'baseplate'` to a tab value that has no `v-tab` and no
   `v-window-item`. An imported baseplate row whose Edit button is clicked disables the three existing tabs
   and lands on an empty window. Closed by stage 4.
2. Between stage 1 and stage 3, `partsOf` returns a baseplate part but `binDownloads.ts` dispatches with
   `if (part.part === 'insert') ... else assume bin`, with **no `assertNever` and therefore no compile
   error**. A baseplate part silently takes the bin path and `fileStem` throws on `product.bin`. Closed by
   stage 3. This is the reason stage 3 must not be deferred past stage 4.

### Definition of done

```
cd web
npm run build
npm test
```

Both green. `PLAN_FILE_VERSION` is 6 and no `42`, `20`, `8.2`, `4` or `0.5` bound literal appears in
`planFile.ts`.

### Tests from the design's test plans

`5.13/1` through `5.13/19`, plus `5.13/23`.

- `5.13/1` to `5.13/4` (round trip) and `5.13/9` to `5.13/14` (validation, merge) go in the new
  `web/tests/plan/baseplate.spec.ts`.
- `5.13/5` to `5.13/8` (version compatibility) extend `web/tests/plan/planFile.spec.ts`. `5.13/5` is the
  existing 4-to-5 legacy test with its asserted output version changed to 6, and that single assertion
  change is the only edit permitted to an existing test in this stage. `5.13/8` asserts the exact string
  "The file has plan version 7, but this app reads versions 1 to 6.", which is what catches the guard being
  hardcoded rather than derived from the constant.
- `5.13/15` extends `web/tests/plan/rowDescriptor.spec.ts`.
- `5.13/16` to `5.13/19` extend `web/tests/plan/geometry.spec.ts`. `5.13/18` (the detached magnets object)
  is the one that catches an aliasing bug the preview would otherwise hit on every keystroke.
- `5.13/23` (`partKey` dedupe across clip tolerances) is a `binDownloads` concern by file but a pure
  `JSON.stringify` assertion by content; place it wherever the existing `partKey` coverage lives, or in
  `web/tests/plan/baseplate.spec.ts` if there is none.

`5.13/20` to `5.13/22` are store tests and belong to stage 4.

### Owner checkpoints

None. Note in the handover, for the eventual release note, the risk the design records under "The version
bump is one-way for the user": once stage 1 ships, `persist()` writes version 6 and an older deployed build
or a stale second tab refuses the whole plan.

---

## Stage 2: geometry

**Goal.** Land the baseplate module: the plate generator, the clip generator, the derived-size helpers, the
measured constants, and the worker plumbing that exposes them.

**Design reference:** sections 4.2 through 4.11 for the geometry, 4.9 for the constant table, 4.10 for the
nine build stages, 5.9 for the worker and client, and constraints G1 to G4.

### Files

**Created**

- `web/src/engine/baseplate/generator.ts` (or `index.ts`; the module layout is yours as long as the exports
  in section 4.11 are reachable from `web/src/engine/baseplate/`). Contains `generateBaseplate`,
  `generateConnectionClip`, `baseplateSpanMm`, `baseplateRiserMm`, `clipFootprintMm`, and the internal
  helpers for the socket clipper, the cell cavity union, the magnet boss and the connector slot prism.
- `web/tests/baseplate.spec.ts`.

**Modified**

- `web/src/engine/baseplate/constants.ts` (created in stage 1): add the measured constants of section 4.9
  that the validators did not need. The bounds and defaults from stage 1 stay exactly as they are.
- `web/src/engine/gridfinity/constants.ts`: add `BASEPLATE_LOWER_CHAMFER`, `BASEPLATE_VERTICAL`,
  `BASEPLATE_UPPER_CHAMFER`, `BASEPLATE_HEIGHT`, `BASEPLATE_SOCKET_CLEARANCE`. Section 4.9's table assigns
  these to `gf`, not `bp`, because they are equalities with existing bin constants rather than new numbers.
  Write the equality in the comment where the table names one (`BASEPLATE_LOWER_CHAMFER` equals
  `LIP_LOWER_TAPER`, `BASEPLATE_VERTICAL` equals `LIP_SEAT_VERTICAL`, `BASEPLATE_UPPER_CHAMFER` equals
  `FOOT_UPPER_CHAMFER`).
- `web/src/worker/geometry.worker.ts`: imports beside line 15, two methods appended to the api object after
  line 95. Do not pull `loadFont()` into either: neither product carries text (section 5.9).
  `GeometryWorkerApi` is inferred from `typeof api`, so it widens with no edit.
- `web/src/workerClient.ts`: imports extended, two forwarding functions appended after line 58. No
  `withResolvedBinInsert` or `withResolvedInsertContent` wrapping (section 5.9).

### What to change

Implement section 4.10's nine stages in order. What an implementer would otherwise get wrong:

- **The footprint is `n * PITCH` exactly.** Not `binOuterSizeMm(cells)`. Section 4.2 states this and
  `4.12/2` is the assertion. Reusing the bin's outer size is the single most likely wrong turn in the whole
  feature, because the function is right there and reads plausible.
- **`insetPolygon` is deliberately not used for the clipper** (section 4.10 stage 2). `loftChain` already
  produces the offset sections analytically. Routing them through a Clipper offset adds tessellation error
  and will drift `4.12/5`'s section widths off their 1e-3 tolerance.
- **Overshoot the cavity** (risk R1). Cell squares must continue past the pitch above z = 4.65 and the
  clipper past the outline, so the boolean cuts cleanly instead of landing exactly on the boundary where
  the knife-edge rims cross. `4.12/1` is the guard, and it is checking 24 size and option combinations
  precisely because this failure is combination-dependent.
- **Owner decision 1 is structural, not a coincidence of values.** `MAGNET_DIAMETER_DEFAULT` and
  `MAGNET_HEIGHT_DEFAULT` are re-exports of `MAGNET_HOLE_DIAMETER` and `MAGNET_HOLE_DEPTH`, not copied
  literals (section 4.9). `4.12/8` asserts the 13.0 offset in geometry, which is the assertion form of the
  decision.
- **Pitch threading** (section 4.10, "Pitch threading"). `pitchMm` is a `BaseplateParams` field defaulting
  to `PITCH`, threaded everywhere, but the socket profile and the magnet positions are **not** keyed to it.
  This is constraint G4 and it is what makes `customXMm: null` mean "the pitch" rather than "42".
- **Magnet omission on a shortened span** (section 4.7): a magnet is emitted only when its full boss circle
  lies inside the plate outline. `4.12/15` is the assertion. See Q1 below before you implement it.

### Dependencies

- **Stage 0 must land first.** `loftChain` with its two new optional parameters is the backbone of stages 2
  and 3 of the build algorithm. Without the widening, stage 3 of the algorithm (sharp-cornered cell
  squares) has no way to ask for zero corner radius.
- **Stage 1 must land first if you took this plan's ordering decision** (the constants and parameter
  interfaces live in the baseplate module from stage 1). If you took the design's temporary-type route
  instead, stage 2 may precede stage 1, and stage 2's first task is deleting those temporaries.
- **Stages 3 and 4 both depend on this.** Stage 3's `partFootprint` imports `baseplateSpanMm` and
  `clipFootprintMm` (constraints G1 and G2). Stage 4's preview calls the worker methods added here.

### Definition of done

```
cd web
npm run build
npm test
```

Both green, with the whole of section 4.12 (`4.12/1` through `4.12/17`) passing.

Additionally, and this is a deliverable of the stage rather than a test: **measure preview generation time
for a 20 by 20 plate with all options on**, and record it as a labeled diagnostic readout in the stage
handover (convention 8: labeled rows of raw values, not a prose sentence). Measure it the way the preview
will actually pay for it, which is one `generateBaseplate` call through the worker, not an in-process
microbenchmark.

### Tests from the design's test plans

All of section 4.12: `4.12/1` through `4.12/17`, in the new `web/tests/baseplate.spec.ts`, written in the
style of `binGenerator.spec.ts` (`loadManifold()`, assert `status()`, `genus()`, `boundingBox()`,
probe-cube intersection volumes, always `.delete()`).

The four that carry the most weight, and which must not be weakened into something easier to satisfy:

- `4.12/1`, manifold status across all 24 size and option combinations. The guard on risk R1.
- `4.12/4`, the two-sided mating probe stated in terms of `buildFoot`'s own output. It fails if the socket
  is too tight **or** too loose, which is why it is stated two-sided; a one-sided version passes on a
  socket that no longer grips.
- `4.12/8`, magnet position at 13.0 from the cell centre. Owner decision 1 in assertion form.
- `4.12/13`, the assembly probe, which asserts both that the clip does not interfere **and** that its
  groove actually engages the rib. Only the second half proves the parts mate; the first half alone passes
  on a clip that has stopped gripping entirely.

### Owner checkpoints

**Stop and ask, before stage 4 is designed.** Report the 20 by 20 preview measurement to the owner and wait
for a decision. This is open question Q2 and it is the reason stage 4's preview design cannot be settled
inside stage 4. If the number is large, the mitigations the design names are raising the debounce for this
tab or gating the preview behind a button above a unit-count threshold, the way `smAndDown` gates it today.
`useBinPreview`'s ticket discards a stale result but does not cancel stale work, so on a slow plate the
worker falls arbitrarily behind. Do not pick a mitigation unilaterally.

**Stop and ask, if `4.12/1` proves unstable.** Section 4.4 and risk R1 both say the zero-thickness top rim
is the reference's real design, not an artefact. If the overshoot mitigation does not make it robust, the
decision to deviate from the reference belongs to the owner, not to the implementer.

---

## Stage 3: export

**Goal.** Make a baseplate and a clip downloadable as STL and 3MF, alone and inside a batch.

**Design reference:** section 5.10, the `binDownloads.ts` half.

### Files

**Modified**

- `web/src/binDownloads.ts`: branches in `generatePartMeshes` (line 41), `generatePartUnion` (line 48),
  `partFootprint` (line 55), `partName` (line 80) and `fileStem` (line 90).
- A test file for the two assertions below. Extend the nearest existing home rather than creating a new
  spec if one exists for `binDownloads`.

### What to change

Per section 5.10. Points an implementer would otherwise get wrong:

- **These five functions have no `assertNever`.** Each is an `if (part.part === 'insert') ... ` followed by
  an implicit bin assumption. The compiler will not tell you if you miss one. Grep for `part.part` and
  `product.kind` in the file and confirm all five got a branch.
- **`partFootprint` must call `baseplateSpanMm` and `clipFootprintMm`, never recompute.** This is
  constraint G1, described in the design as the single most important item on its list. `partFootprint`
  feeds the plate arranger, so a locally recomputed size means a batch export can lay one plate over its
  neighbour with no error shown.
- **No `generateBaseplateUnion` worker method.** `generatePartUnion` calls the same `generateBaseplate` the
  mesh path calls. The union variants exist for parts whose preview form is two meshes, and a baseplate's
  is one.
- **`downloadProduct3mf` and `downloadBatch` need no change at all.** If you find yourself editing either,
  re-read section 5.10's "3MF path" paragraph: `PlateItem.label` is already `MeshData | null` and
  `writePlate3mf` already emits a single-filament object for a null label.
- **Filename stems follow ours, not the reference site's**: `gridfinity_baseplate_4x2.stl`,
  `gridfinity_baseplate_4x2_custom.3mf`, `gridfinity_connection_clip.stl`,
  `gridfinity_connection_clip_tol0p2.stl`. The `_custom` and `_tol` suffixes are not decoration: without
  them, two genuinely different parts download over each other.

### Dependencies

- **Stages 1 and 2 must both land first.** Stage 1 supplies `PrintablePart`'s new members and
  `baseplateParamsOf`; stage 2 supplies `baseplateSpanMm`, `clipFootprintMm` and the worker methods.
- **This must land before stage 4 reaches the owner for a browser check.** Stage 4 makes it possible to
  queue a baseplate through the UI, and the interim gap named in stage 1 means a queued baseplate takes the
  bin download path and throws in `fileStem` until this stage lands. Stage 3 before stage 4 is the ordering
  this plan uses; if you must invert them, the owner's stage 4 browser check cannot include downloading.

### Definition of done

```
cd web
npm run build
npm test
```

Both green, plus the two stage-specific tests below.

### Tests from the design's test plans

Neither of stage 3's tests is numbered in the design's two test plans. They are named in the design's own
stage 3 verification bar and are authored here:

1. `partFootprint` on a custom-size plate equals `baseplateSpanMm` on both axes. Written as a comparison
   against `baseplateSpanMm`, not against a hardcoded 156.0, so it stays true if the pitch parameter is
   ever exercised. This is the executable form of constraint G1.
2. The clip filename stems differ across tolerances (`gridfinity_connection_clip` against
   `gridfinity_connection_clip_tol0p2`).

`5.13/23` (`partKey` distinguishes clip tolerances) landed in stage 1; if it was placed in a
`binDownloads` spec rather than the plan spec, confirm it still passes here.

### Owner checkpoints

**Stop and ask. 3MF export is not proven until the owner verifies it in Orca Slicer.** This is the
project's standing verification bar in `CLAUDE.md`, not a stage-local nicety. Hand the owner a downloaded
baseplate 3MF and ask them to confirm it opens as a **single-filament object** with the plate on extruder
1 and no second-extruder part. Do not record stage 3 as complete on the strength of green tests alone, and
do not describe the 3MF path as working before that confirmation comes back.

---

## Stage 4: UI

**Goal.** Add the Baseplate tab, its store and its preview, and generalize the queue's row noun from "bins"
to "parts".

**Design reference:** sections 5.6, 5.7 (everything except the connection clip subsection), 5.8, 5.11's
edit-routing paragraph, and all of 5.12.

### Files

**Created**

- `web/src/stores/baseplateDesigner.ts`, per section 5.6.
- `web/src/components/BaseplateTab.vue`, per section 5.7's numbered list and panel sketch, **excluding**
  item 10 (the connection clip section), which is stage 5.
- `web/tests/stores/baseplateDesigner.spec.ts`. The `web/tests/stores/` directory does not exist yet.

**Modified**

- `web/src/components/AddBinCard.vue`: the `BaseplateTab` import, the `v-tab value="baseplate"` after the
  Tool bin tab (line 46), the `v-window-item value="baseplate"` after line 63. The `TabName` union and the
  `TAB_OF_KIND` entries were already folded forward in stage 1; do not touch them again.
- `web/src/composables/useBinPreview.ts`: one line, the fallback at line 40, "Bin generation failed."
  becomes "Generating the preview failed." The signature is **not** changed (section 5.8 enumerates the
  three call sites that would otherwise need edits for no gain).
- `web/src/components/MainPage.vue`: the six required row-noun changes in section 5.12's first table, and
  the five recommended same-screen consistency changes in its second table. The `selectedBinTotal` to
  `selectedPartTotal` rename (line 76) is mechanical and is required by two of the required rows.
- `web/src/components/BatchBox.vue`: two strings from section 5.12's second table.
- `web/src/engine/plan/rowDescriptor.ts`: nothing new. `downloadSubtitles` landed in stage 1; this stage
  only wires `MainPage.vue`'s two hardcoded download-menu subtitles (lines 223 and 229) to it.

### What to change

Per sections 5.6, 5.7, 5.8 and 5.12. Points an implementer would otherwise get wrong:

- **Do not reuse `MoreOptions.vue`.** It binds straight off `useBinDesigner` through `storeToRefs` (line
  39) and renders `DividerEditor` and the bin magnet switch. Section 5.7's "Why not `MoreOptions.vue`"
  settles this; Quantity and Notes are restated as two plain fields and that is accepted.
- **`params` derives from `product`, not alongside it** (section 5.6, "Deliberate deviation from
  `useBinDesigner`"). The store's `product` getter builds the `BaseplateProduct`, and `params` is
  `baseplateParamsOf(this.product)`. Do not copy `ManualBinTab.vue`'s pattern of building the product in
  the tab while the store computes geometry separately; that split is the thing this deviates from, and
  `5.13/20` and `5.13/21` exist because of the class of bug it causes.
- **The two collapses live in the store getters, nowhere else.** `spanX` returns
  `customSize ? customXMm : null` and `magnets` returns `magnetMode === 'full' ? {...} : null`. `5.13/20`
  fails if the product getter reads `state.customXMm` directly.
- **All slider and field bounds bind to the exported constants**, the same ones `planFile.ts` validates
  against (constraint G3). A literal `8.2` in the template is the defect this constraint exists to prevent.
- **The preview adapts at the call site**, with the single `.then` in section 5.8. `useBinPreview`'s
  signature is untouched.
- **The edit-routing watcher guard** (section 5.11) is
  `app.editingKind === 'baseplate' || app.editingKind === null`, mirroring `ManualBinTab.vue:105-109`. The
  parallel `'clip'` guard that selects clip-only mode is stage 5's.
- **UI text is subject to convention 7** (plain technical prose, complete sentences, community
  terminology) and **convention 8** (the total width and depth readout is labeled rows, not prose).
  Consider the `writing-ui-guidance` skill before finalizing the hint strings.

### Dependencies

- **Stages 1, 2 and 3 must all land first.** Stage 1 for the types and the `TAB_OF_KIND` fold-forward,
  stage 2 for the worker preview methods and the bound constants, stage 3 so a queued baseplate can
  actually be downloaded when the owner checks it.
- **Q2 must be answered before this stage's preview is designed.** See the owner checkpoint. Stage 4 cannot
  choose between "preview on every keystroke at the standard 300 ms debounce", "raise the debounce" and
  "gate behind a button above a threshold" without stage 2's measurement and the owner's call.
- **What breaks if this lands before stage 3:** the queue can hold a baseplate the download path mishandles
  (`fileStem` throws on `product.bin`). Nothing surfaces at compile time.
- **Stage 5 depends on this**, and only on this. Stage 5 adds a card inside the component this stage
  creates.

### Definition of done

```
cd web
npm run build
npm test
```

Both green, with `5.13/20` through `5.13/22` passing.

### Tests from the design's test plans

`5.13/20`, `5.13/21` and `5.13/22`, in the new `web/tests/stores/baseplateDesigner.spec.ts`.

`5.13/22` is the one that ties the form to the file format: the store's `product` output must pass
`validateProduct` for both the default form state and the fully optioned state. It is what proves owner
decision 1 did not push a default (6.5 and 2.4) outside the validator's range, and it catches that class of
bug at build time rather than through a user's rejected import.

Consult the `writing-unittests` skill before writing these; a store test that only re-asserts the initial
state values catches nothing.

### Owner checkpoints

**Stop and ask, before implementing the preview.** Carry Q2's answer from stage 2 into this stage. Do not
assume the standard debounce is fine.

**Stop and ask, at the end of the stage.** The owner must check in the browser that the tab previews, that
a plate queues, that the row re-opens for edit with its values restored, and that the queue header reads
"N parts queued". Convention: manual browser checks happen when the owner asks or when a stage's bar names
one, and this stage's bar names one.

---

## Stage 5: connection clip UI

**Goal.** Add the connection clip card to the Baseplate tab, including the clip-only edit mode.

**Design reference:** section 5.7's "Connection clip offering" subsection and its panel sketch.

### Files

**Modified**

- `web/src/components/BaseplateTab.vue`: the `v-card variant="tonal"` clip section below the action
  buttons (item 10 of section 5.7's left-column list), the component-local `clipQuantity` and
  `clipToleranceMm` refs, `addClips()`, and the clip-only edit mode.

### What to change

Per section 5.7's "Connection clip offering". Points an implementer would otherwise get wrong:

- **`clipQuantity` and `clipToleranceMm` are component-local refs, not store state.** Neither belongs to
  any baseplate design and neither needs to survive a tab switch. Do not add them to
  `useBaseplateDesigner`.
- **The card is always rendered, never hidden.** When `store.connectable` is false its caption gains a
  second sentence ("Turn on Connectable so the plates have edges for the clip to grip."). A user returning
  to add clips for plates queued in an earlier session must not have to toggle a switch on an unrelated new
  design to find the control.
- **`addClips()` leaves the baseplate form untouched**, so clips can be added before or after the plate
  itself is queued.
- **Clip-only edit mode:** the tab detects `app.editingKind === 'clip'`, collapses to just the clip card
  with quantity and tolerance prefilled from the stored product, changes the button to "Save changes", and
  hides the baseplate form. This is the one place the tab has two modes.
- The tolerance hint text is quoted verbatim in section 5.7 and is the user-facing explanation of owner
  decision 2 (the clearance is applied to the clip only, so a clip printed at a larger tolerance still fits
  a plate already printed). Do not paraphrase it into something shorter; that sentence is the whole reason
  a user will understand why raising the slider is safe.

### Dependencies

- **Stage 4 must land first.** This is a section inside the component stage 4 creates.
- **Stage 2 must have landed**, since the clip generator and `clipFootprintMm` are what make a queued clip
  previewable and downloadable.
- **Nothing depends on this stage.** It is split from stage 4 deliberately: the clip's edit mode is the one
  genuinely fiddly piece and should not be entangled with getting the baseplate form right. If clip
  geometry slips, stages 0 to 4 still ship a complete baseplate feature and only this card waits.

### Definition of done

```
cd web
npm run build
npm test
```

Both green.

### Tests from the design's test plans

None. Neither test plan numbers a clip UI test. The proof is the owner check below.

### Owner checkpoints

**Stop and ask.** The owner must confirm in the browser that a clip row queues, that it re-opens into
clip-only mode with its tolerance prefilled, and that it downloads under a tolerance-distinct filename
(`gridfinity_connection_clip.stl` against `gridfinity_connection_clip_tol0p2.stl`).

---

## Open questions and where each must be resolved

The design closes with four open questions (section 7). None may be silently resolved by an implementer
picking whichever branch is easier to code. Each is listed here with the stage that cannot proceed past it.

### Q1: custom size combined with magnets

**Must be resolved by: stage 2**, before section 4.10 stage 6 (magnet bosses) is written.

The design specifies that a magnet is emitted only when its full boss circle (centre plus `bossRadius`)
lies inside the plate outline, and states plainly that this is a design rule and not a measurement: the
reference site's behaviour with custom size plus magnets was never captured. The alternative it rejects
(emit the magnet and let the outline clip it, producing an open pocket in the plate's side wall) is worse,
but the owner may prefer a third option, such as refusing to shorten a column below the width a magnet boss
needs. `4.12/15` is written against the specified rule, so a different answer changes both the generator
and that test. Raise it at the start of stage 2, not after the boss code is written.

### Q2: is a 20 by 20 baseplate previewable

**Measured in: stage 2. Must be resolved by: stage 4**, before the preview wiring is written.

A 20 by 20 plate is 840 mm square and roughly 400 sockets of CSG. `useBinPreview`'s 300 ms debounce plus a
ticket that discards the stale result without cancelling the stale work means the worker can fall
arbitrarily behind on a large plate. Stage 2 produces the measurement as a labeled readout; the owner picks
the mitigation if one is needed (raise the debounce for this tab, or gate the preview behind a button above
a unit-count threshold). This is the explicit reason the two stages are separated by a checkpoint rather
than run together.

### Q3: clip print orientation

**Must be resolved by: stage 2**, before `generateConnectionClip` is finalized.

`connector.stl` is a prism with its 19.6 mm length along Z, so the reference exports it standing on a 4.30
by 3.67 mm footprint. The design specifies generating it exactly as measured, because that is the
orientation the measurements validate and because layer orientation matters for a snap fit's flexure. But a
19.6 mm tall part on that footprint is tippy and a batch of them may print badly. Laying it down (length
along X, flat bottom face on the build plate) would put a roughly 2.9 mm wide bridge over the groove roof.
The choice is confined to the generator, since `partFootprint` follows whatever it emits through
`clipFootprintMm`, but `4.12/12` asserts the bounding box as `[4.30, 3.6738, 19.60]` and would need
rewriting for a laid-down clip. Ask the owner in stage 2.

### Q4: should a baseplate be selectable into a build plate batch

**Must be resolved by: stage 3**, since that is where `partFootprint` decides how a plate is arranged.

Nothing prevents it and `createBatch` works unchanged. Owner decision 3 (the row noun becoming "parts")
removes the wording objection, so the remaining question is only whether mixing a 336 mm plate with bins in
one arrangement is useful or merely a way to fail the fit check. The design's recommendation is to allow it
and let the existing user-worded "does not fit" message do its job, which costs no code. Confirm that with
the owner during stage 3 rather than assuming it, because the alternative (excluding baseplates from batch
selection) is a `MainPage.vue` change that would otherwise arrive late.
