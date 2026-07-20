# STL cutout bin: implementation plan

Date: 2026-07-20. Companion to `docs/superpowers/specs/2026-07-20-stl-cutout-bin-design.md`.
Read the design first; this document does not restate its reasoning.

An earlier plan at `.claude/plans/cutout-bin-plan.md` (commit `3b18a6b`) is superseded by
these two documents. The design's provenance section lists the ten items absorbed from it.

## What is being built

A fourth way to make a bin: **upload a 3D model and let the bin close around it.**

The user opens a new Cutout bin tab, uploads one or more STL files, drags each into place
inside a translucent bin in the 3D view, and the bin's interior fills in solid around them,
leaving a pocket shaped like each model. Each pocket is cut slightly larger than its model so
the real part drops in rather than jamming, and that amount is set per model because different
objects in one tray want different fits. Whether a pocket ends up open at the top or fully
enclosed depends only on how high the user placed the model. The uploaded files are kept on the
device so a bin stays editable later.

## How the work is shaped

Nine stages. The order is driven by one idea: **build it from the geometry outward.**

1. Stages 1 and 2 are pure geometry with real test coverage, and they land first because
   everything else depends on the carve being correct.
2. Stages 3 to 5 are the data layer: the bin type, the plan file, and storing the uploaded
   files on the device.
3. Stage 6 connects the geometry to the app through the background worker.
4. Stages 7 to 9 are what the user actually touches, and their verification is partly a
   hands on check by the owner, because there is no automated test for how a 3D drag feels.

Stage 1 is the one that carries risk to existing work: it pulls shared geometry out of the
already shipped tool trace bin. Its whole definition of done is that the existing tests still
pass untouched.

Two project rules shape most of the decisions below, and are worth stating plainly:

- **One source of truth.** Where the trace bin and the cutout bin do the same thing, the code
  lives in one place used by both. Where a figure is derived, it is derived once and quoted
  everywhere else, never restated.
- **Established methods, no tuned constants.** Every number in the geometry is derived from
  something real (the clearance, the printer's nozzle width, the bin's own dimensions) rather
  than picked because it made one test look right. Where a number is a pure interface choice,
  it is labelled as one and put to the owner.

## How to use this plan

Nine stages, ordered by dependency. Every stage's definition of done includes `npm run build`
and `npm test` green inside `web/`, so `master` is never left broken. Stages 1 through 6 are
engine and plan layer work with real test coverage. Stages 7 through 9 are UI work whose
verification is partly an owner browser check, marked as checkpoints.

Owner checkpoints are marked **[CHECKPOINT]** and are blocking: the implementer stops and
reports rather than deciding.

## Stage 0: owner decisions before any code

**Already decided by the owner on 2026-07-20: clearance is per model, not per bin.** Each
uploaded model carries its own value, defaulting to 0.4 mm. This is settled and is not to be
reopened; design sections 5.2, 7.10 and 8.6 carry the reasoning and the consequences. It
affects stages 2, 3, 4, 6 and 8, and each of those stages says how.

**Also already decided by the owner on 2026-07-20: the clearance step shows an indeterminate
progress indicator, not a percentage.** The owner originally asked for a real percentage
progress bar and has accepted an indeterminate one after being shown why it is not achievable
with the current single worker structure. Design section 8.5 carries the full record: what
was asked for, why the worker cannot report it, what a shared memory second worker would cost
to make it possible, and that the owner may revisit once the timings from stage 2 exist. Do
not implement a fake percentage that advances on a timer. It affects stages 6 and 8.

**Also already decided by the owner on 2026-07-20: the per model transform rows are display
only, not editable.** The gizmo is the sole input method for position and rotation, and the
numbers beside it are a diagnostic readout in the sense of rule 8. The reasoning is that an
editable row and a dragged handle would have to be kept in sync in both directions, and a
single input path avoids that bookkeeping entirely. The clearance field is not affected: it
stays an editable number box, because it is not a gizmo controlled value and there is no
gestural way to express a fit. Design section 7.7 carries the record. It affects stage 8.

**Also already decided by the owner on 2026-07-20: one worker, not a second instance for
previews.** While the user drags, nothing is carved at all, because the ghost tier is pure
rendering on the main thread. So the second instance would only ever serve to abandon a carve
the user had already superseded by moving a model again before it finished. The owner chose to
measure first rather than build that upfront. The consequence to accept knowingly is that a
superseded carve cannot be cancelled with a single worker, so a new request waits for it to
finish. Design section 8.7 carries the record. It affects stage 6.

**New requirement added by the owner on 2026-07-20: the carve pipeline logs its stage timings
to the console.** The owner wants real numbers from normal use, both to settle the triangle
ceiling and to decide later whether a second worker is justified. Design section 8.11
specifies it in full: which stages are timed, what each line reports, how a cache hit is
distinguished from a cache miss, and that the logging lives in one place in the worker rather
than in the engine modules. It affects stages 2 and 6, and it is built once, in stage 6.

**Owner decisions no longer block stage 1.** The two questions that would have changed code
written in the early stages are settled above and their rows are gone from the open questions
table. The three that remain (gizmo handle size, the 1 mm translation snap and the 0.05 mm
clearance step, `Fit bin to models` as a button) are answered at their own stages and are
marked there.

## Stage 1: extract the shared carve module

**Goal.** Move the fill, subtract and re-slot stages out of the traced pocket bin into a
shared module, with no behaviour change whatsoever.

**Created.**
- `web/src/engine/gridfinity/carvedBin.ts`
- `web/tests/gridfinity/carvedBin.spec.ts`

**Modified.**
- `web/src/engine/trace/pocketBin.ts`: `buildPocketBinBody` reduces to place, validate, build
  cutters, delegate. `interiorSection` and the fill and subtract code are removed.
  `maxPocketDepthMm` is re-exported from `carvedBin.ts` under its existing name so no caller
  and no test changes.

**Not modified.** `web/tests/trace/pocketBin.spec.ts`. This is the point of the stage.

**Depends on.** Nothing. Do this first: everything downstream builds on it, and doing it
before the cutout flow exists guarantees the extraction is driven by the existing behaviour
rather than shaped around the new one.

**Interface.** As specified in design section 2.3: `interiorSection`, `buildInteriorFill`,
`maxCarveDepthMm`, `buildCarvedBinBody`, `labelStructureStrip`. `buildCarvedBinBody` takes
ownership of the cutters and deletes them on both the success and the failure path.

**Tests from the design.** Section 10.1, all eight.

**Definition of done.**
- `npm run build` and `npm test` green inside `web/`.
- **Every test in `web/tests/trace/pocketBin.spec.ts` passes with the file unmodified.**
  If any test in that file, or anywhere under `web/tests/trace/`, needs a change to pass, the
  refactor was not behaviour preserving. **Stop and report; do not adjust the test.**
- `git diff --stat` shows no change under `web/tests/trace/`.

## Stage 2: the cutout carve geometry

**Goal.** Turn a stored model plus a placement and a clearance into a carved bin. Pure
engine, no worker, no UI, no persistence.

**Created.**
- `web/src/engine/geometry/circleSegments.ts`: `circleSegments(radiusMm, toleranceMm)`,
  moved out of `engine/trace/edit.ts` with the tolerance made a parameter. See below.
- `web/src/engine/cutout/cutoutBin.ts`: `CutoutModelSpec`, `CutoutBinParams`,
  `DEFAULT_CUTOUT_CLEARANCE_MM`, `maxClearanceMm(gridX, gridY)`,
  `simplifyToleranceMm(clearanceMm)`, `prepareCutoutModel` (the import stage: scale to mm,
  centre, simplify, offset), `placeCutter` (rotate then translate),
  `validateCutoutPlacement` returning warnings as an array, `buildCutoutBinBody`,
  `generateCutoutBin`, `generateCutoutBinUnion`.
- `web/tests/cutout/cutoutBin.spec.ts`
- `web/tests/geometry/circleSegments.spec.ts`
- Fixture models under `web/tests/cutout/fixtures/` if the existing tetrahedron, cube and
  sphere fixtures are not enough. An asymmetric solid is required for the rotation order
  test; a right triangular prism is sufficient and can be generated in the test rather than
  stored as a file, matching how the existing cutout tests build their fixtures.

**Modified.**
- `web/src/engine/trace/edit.ts`: its private `circleSegments` is removed and the shared one
  imported, called with `CHORDAL_TOLERANCE_MM`. `CHORDAL_TOLERANCE_MM` and
  `MIN_CIRCLE_SEGMENTS` policy: the tolerance constant stays in `edit.ts` because it is the
  trace flow's own accuracy policy; the floor moves with the derivation. **No behaviour
  change**, proven by `web/tests/trace/edit.spec.ts` passing unmodified.

**There is no `offsetSphereSegments` function.** An earlier draft of the design derived a
fresh formula for the offset sphere's facet count. It does not exist and must not be written.
The codebase already derives a facet count from the identical sagitta error model, and design
section 8.3 shows the two derivations are the same formula differing only in which tolerance
is passed in. The cutout flow calls
`circleSegments(clearanceMm, simplifyToleranceMm(clearanceMm))`. Writing a second derivation
of this is a rule 10 defect, and it would also drop the multiple of four rounding that makes
the pocket dimension test pass honestly.

**Depends on.** Stage 1.

**Ordering constraint.** The rotation order test must be written **before** the transform
code, not after. It is the one test in this feature that is easy to write to match whatever
the implementation happens to do, and worthless if written that way. It asserts against an
independently computed `three.js` `ZYX` Euler matrix applied to known corner points, not
against the implementation's own output.

**Tests from the design.** Section 10.2, all seventeen.

**Clearance is per model here, and this is where that is established.** `prepareCutoutModel`
takes one model's clearance and nothing else knows about any other model's. Specifically:

- `simplifyToleranceMm` is a pure function of **one** model's clearance, so the tolerance is
  per model too. Design section 8.2 works through why the derivation still holds when two
  models in one bin carry different tolerances, and confirms nothing downstream assumed a
  single bin wide value.
- The shared carve stage from stage 1 receives finished cutter solids and never sees a
  clearance or a tolerance. If it needs either, the layering is wrong.
- The zero clearance fast path that skips simplify and Minkowski is per model, so a bin can
  mix an exact model and a dilated one.

**Assertion policy, which is not the obvious one.** Read design section 10.0 before writing a
single geometry assertion. **Do not assert `genus() === 0` on a carved bin.** A cutter can
seal a void in the hollow base, `decompose()` reports a sealed void as a negative volume
component, and a sealed void makes the whole solid's genus legitimately negative. The
assertion would then fail on correct geometry, and the natural response to that (weakening
the assertion, or changing the geometry until the number comes back) is a defect either way.
Use the pattern the divider work established and shipped in `web/tests/binGenerator.spec.ts`:
`status() === 'NoError'` for validity, the local `componentVolumes` helper with `solids`
having length 1 for connectedness, `voids` having length 0 where no sealed void is intended,
and `genus()` only on the positive volume component from `decompose()` when a spurious handle
is the specific thing being ruled out. Reuse `componentVolumes` rather than writing a second
one.

**Nothing below the container floor.** The divider feature shipped wall roots that printed
through the base as ribs on the first layer, and every test in the suite passed throughout,
because they all asked whether the solid was valid and none asked whether material had
appeared where it had no business being. A cutout pocket has the same failure mode. Assert it
**differentially**, against the same bin with no cutters, following
`web/tests/binGenerator.spec.ts`: `trimByPlane([0, 0, -1], -FLOOR_TOP)` volumes compared with
`toBeCloseTo(..., 6)`, and `slice(0.1)` plan areas compared the same way. Run both **with
magnet holes enabled**, because magnet and screw holes legitimately sit below the floor and
the differential form is exactly what tolerates them without hardcoding a second derivation
of the base geometry. This must be asserted by test, not argued in a comment.

**The wall clock ceiling on the offset (design 8.9).** `prepareCutoutModel` records a start
time before the Minkowski sum and, on return, discards and reports rather than caching if the
elapsed time exceeds the ceiling. Implement the mechanism in this stage. Its **value** comes
from the measurement below and is not to be guessed; until that measurement exists, take the
value from a named constant with a comment saying it is provisional, and set it for real as
part of the checkpoint. Be honest in the comment that the check bounds what is accepted, not
what is attempted: a blocked synchronous WASM call cannot be interrupted from outside. The
message is the one in design 9.2, including the zero clearance escape route, which is a real
escape because zero clearance skips both simplify and Minkowski.

**[CHECKPOINT] Measure the triangle ceiling and set `MAX_TRIANGLES` from the numbers.**
`MAX_TRIANGLES = 250000` is already shipped in `web/src/engine/cutout/stlReader.ts` and
already quoted in a user facing message, and it was picked without measurement. Rule 12 makes
replacing it with a measured figure mandatory, not optional, and **the owner has been told he
will get real timings rather than another estimate**, so this is a blocking checkpoint and
its output is a table of raw numbers per rule 8, not a prose conclusion.

Method, from design section 8.8:

- Measure end to end in the **worker, in a browser**, not in the Node suite: from handing
  bytes to the import stage to the cached solid being ready, covering parse, weld, validate,
  scale, centre, simplify and Minkowski at the default 0.4 mm clearance.
- Record per input: wall clock total, wall clock for the Minkowski stage alone, triangle count
  before and after simplify, and peak memory if it can be read. The **post simplify count** is
  the number that matters most, because it is what tests the plateau hypothesis.
- Sweep roughly 1000, 5000, 20000, 50000, 150000 and 250000 triangles.
- Use both clean generated solids (a subdivided sphere is the worst realistic case for
  simplification) **and at least two real world downloaded STLs**. A ceiling calibrated only
  on generated geometry repeats the mistake being corrected.
- Set the ceiling from where the measured curve crosses an acceptable wait, and comment the
  constant with the measurement and its date. If memory or parse time binds before Minkowski
  time does, set it from whichever actually binds.
- **Do not treat the circulated "roughly five minutes at 250000 triangles" figure as data.**
  It applied the raw per triangle cost without accounting for simplify running first and is
  probably wrong.
- If simplification does not reduce counts enough to make large models tractable, **lower the
  ceiling**. Never loosen the simplify tolerance past its error budget. The tolerance is a fit
  guarantee; the ceiling is a convenience limit, and only one of them may be spent for speed.

**Take these numbers from the console timing instrumentation, not from a throwaway harness.**
The owner's stage 0 requirement (design 8.11) already logs the parse, the clearance offset and
the carve per model in milliseconds, which is exactly the breakdown this measurement needs, so
the two must not be built twice. The instrumentation lands in stage 6, where the worker
methods it wraps first exist, and this checkpoint is therefore reported once stage 6 makes the
worker path reachable in a browser. The mechanism of the wall clock ceiling still belongs to
this stage; only its measured value waits.

It is a legitimate outcome that 250000 turns out to be fine. It is not legitimate to keep
asserting it without having looked. Report the table and the proposed ceiling; the owner
confirms before the constant changes.

**Definition of done.**
- `npm run build` and `npm test` green.
- Every warning in design section 9.2 that belongs to the carve is **returned** in the result
  array, never thrown. A test asserts that a model fully outside the bin still yields a
  watertight solid.
- The simplify tolerance and the clearance ceiling are computed from their formulas, and the
  sphere segment count comes from the shared `circleSegments`. A literal `0.04`, a literal
  segment count, or a hardcoded millimetre cap anywhere in the module fails this stage.
- `web/tests/trace/edit.spec.ts` passes **unmodified** after the `circleSegments` move. If it
  does not, the move was not behaviour preserving. Stop and report; do not adjust the test.
- The below floor differential tests pass with magnet holes enabled.
- The two stacking lip tests from design 10.2 are written and pass: a fully buried model
  leaves the lip intact, and a model raised through the rim cuts the lip only where it passes
  through. This interaction is **unverified** rather than known, so if the second test fails,
  that is a finding to report, not a test to relax.
- No assertion anywhere in the new tests uses `genus()` on a whole carved bin.
- The two mixed clearance tests from design section 10.2 pass: two models with different
  clearances each get their own dilation, and a bin mixing 0 mm with 0.4 mm carves both
  correctly. These are what prove per model actually reached the geometry.

## Stage 3: plan layer types

**Goal.** `CutoutBin` and `CutoutModel` exist in the plan model and every exhaustive switch
over `ProductOrigin` compiles again.

**Modified.**
- `web/src/engine/plan/types.ts`: `ModelPlacement`, `CutoutModel` (including `unitScale`,
  design 5.6), `CutoutBin`, widened `Bin` and `ProductOrigin`, widened `BinProduct.bin`,
  `PLAN_FILE_VERSION = 6`.
- `web/src/engine/plan/geometry.ts`: walls guard, `partsOf`, `previewBinParams`,
  `PrintablePart.models`.
- `web/src/engine/plan/rowDescriptor.ts`: explicit `cutout` branches in `detailToken` and
  `synthesizedTitle`.
- `web/src/components/AddBinCard.vue`: `TAB_OF_KIND` gains `cutout`. Widening `ProductOrigin`
  makes this file fail to compile until it does, which is the intended coupling.
- `web/tests/plan/rowDescriptor.spec.ts` and `web/tests/plan/geometry.spec.ts`: new cases.

**Depends on.** Nothing, but keep it after stage 2 so the geometry types it references exist.

**Watch for.** `detailToken` and `synthesizedTitle` are **not** exhaustive over `bin.origin`.
They branch on `traced` and fall through to a branch that reads `bin.walls`. A cutout bin
would take that fall through. The compiler will not catch this. Design section 10.4 has the
test that does.

The tab component does not exist yet at this stage, so `AddBinCard.vue` maps `cutout` to a
tab name whose window item is added in stage 7. Either add a placeholder window item in this
stage or accept that the tab is unreachable until stage 7; prefer the placeholder so the
build reflects reality.

**Tests from the design.** Section 10.4, the `describeProduct` and `partsOf` rows.

**Definition of done.** `npm run build` and `npm test` green. No `assertNever` call site is
left unhandled.

## Stage 4: plan file validators

**Goal.** A version 6 plan containing cutout bins round trips, and every malformed field
produces its own message.

**Modified.**
- `web/src/engine/plan/planFile.ts`: `validateCutoutModels`, `pickCutoutModels`, the `cutout`
  branch in `validateBin` and `pickBin`, the widened origin message.
- `web/tests/plan/planFile.spec.ts`: new cases.

**Depends on.** Stage 3.

**Clearance specifics.** `validateCutoutModels` takes the bin's `gridX` and `gridY`, which
`validateBin` already has, so the out of range message can quote the real limit from
`maxClearanceMm` rather than saying the value is merely wrong. This follows the precedent of
the existing pocket depth message, which names the depth the bin actually allows. An absent
`clearanceMm` defaults to `DEFAULT_CUTOUT_CLEARANCE_MM` on pick, following the precedent of
`minHoleWidthMm`, so a plan written by an early build still loads.

Do not restate 0.4 or the ceiling formula in this module. Both are imported from
`engine/cutout/cutoutBin.ts`, which is their single home.

**Unit scale.** `unitScale` validates as a finite number greater than 0 and defaults to 1 on
pick when absent, which is exactly what a plan written before the field existed meant, since
such a plan described a model already treated as millimetres. Design 5.4 has the message and
5.6 the reasoning.

**Forward compatibility, and the one thing it forbids.** A later export of the plan zipped
with its model STLs must be purely additive: a container around the same version 6 JSON, with
no version bump, no field changes and no migration. Design 5.3 works through what that
constrains. The practical rule for this stage is that `modelSourceId` stays an **opaque key
and never encodes a path or any device local storage detail**, and that model metadata stays
complete without the bytes, so a reader holding only the JSON can still list, describe and
validate the bin. Do not add model bytes to the plan JSON in any encoding.

**Tests from the design.** Section 10.4, the round trip, defaulting, walls exclusion, version
5 compatibility and version 7 rejection rows.

**Definition of done.**
- `npm run build` and `npm test` green.
- A version 5 plan file fixture still loads with no warnings. This is the regression that
  matters most: a break here silently empties every existing user's queue on next load,
  because `binQueue.loadPlan` degrades a parse failure to an empty plan and only logs.
- Every message in the design's section 5.4 table is asserted by at least one test.

## Stage 5: the IndexedDB model store and asset sweep

**Goal.** Model blobs persist, and orphaned blobs of both kinds are collected in one sweep.

**Created.**
- `web/src/idb.ts`: `DB_NAME`, `DB_VERSION = 2`, `openDatabase`, `withStore(storeName, ...)`.
- `web/src/modelStore.ts`: `putModel`, `getModel`, `deleteModel`, `listModelIds`.
- `web/src/engine/plan/storedAssets.ts`: `AssetStoreLike`, `ReferencedAssetIds`,
  `referencedAssetIds`, `sweepOrphanAssets` with the `protectedIds` parameter.
- `web/tests/plan/storedAssets.spec.ts`.

**Modified.**
- `web/src/photoStore.ts`: internals delegate to `idb.ts`. Exported signatures and failure
  messages unchanged.
- `web/src/stores/binQueue.ts`: `sweepStoredPhotos` becomes `sweepStoredAssets`, passing both
  stores and the protected ids.
- `web/src/main.ts`: the startup sweep call follows the rename.

**Deleted.**
- `web/src/engine/plan/traceSources.ts` and `web/tests/plan/traceSources.spec.ts`, superseded
  by `storedAssets`.

**Depends on.** Stage 3, for `CutoutBin` in the traversal.

**Test policy, which differs from stage 1.** This refactor renames a module, so its test file
is renamed and its imports change. That is permitted. What is **not** permitted is changing
what any existing trace photo assertion asserts: each of the six existing cases in
`traceSources.spec.ts` carries over with the same setup and the same expectation, only the
imported names differing. If a trace assertion's expected value has to change, stop and
report.

**Store the original file, not the processed solid.** `putModel` stores the uploaded STL
bytes exactly as they arrived. Never the simplified solid, never the dilated cutter, never a
re-exported mesh. Design 6.1 has the reasoning; the short version is that simplification
error would otherwise compound across every later clearance change, so a user tuning a fit
from 0.4 to 0.6 to 0.8 would silently degrade the model each time, and re-parsing costs
milliseconds against a Minkowski sum measured in seconds. The stored bytes are also what a
re-import must reproduce and what a zipped export would carry.

**Watch for.** The `onupgradeneeded` handler must create every missing store, using the
existing `if (!db.objectStoreNames.contains(...))` guard for each. A user upgrading from
version 1 gets `models` created; a fresh user gets both. Test this by hand at least once,
because Node cannot.

**Tests from the design.** Section 10.5, all six.

**Definition of done.**
- `npm run build` and `npm test` green.
- The cutout model sweep tests pass, in particular the two bins sharing one `modelSourceId`
  case, which is what rules out a refcount implementation.
- **[CHECKPOINT]** Owner confirms in the browser that an existing plan with trace photos
  survives the database version bump: photos still load on a traced bin edit after the
  upgrade. Node has no IndexedDB, so no test can show this.

## Stage 6: worker and client wiring

**Goal.** The carve is reachable from the main thread, with the model cache, the transfer
semantics and the preview cancellation in place.

**Created.**
- `web/src/worker/timing.ts`: the single home for the console timing instrumentation from
  design 8.11. One `timed(stage, modelName, run)` helper plus the cache hit and miss lines.
  Nothing under `web/src/engine/` gains a `console` call.

**Modified.**
- `web/src/worker/geometry.worker.ts`: `missingCutoutModels`, `putCutoutModel`,
  `releaseCutoutModels`, `generateCutoutBinPreview`, `generateCutoutBin`,
  `generateCutoutBinUnion`, plus the module level model cache keyed by
  `${modelSourceId}:${unitScale}:${clearanceMm}` and the active preview `ExecutionContext`.
- `web/src/workerClient.ts`: mirroring wrappers.
- `web/src/binDownloads.ts`: cutout branches in `generatePartMeshes` and `generatePartUnion`,
  with a `plainModels` deep clone mirroring `plainPockets`.
- `web/src/composables/useBinPreview.ts`: widen to `useBinPreview<P, R = PartMeshes>`.

**Depends on.** Stages 2, 3, 5.

**Ordering constraint.** The `useBinPreview` widening must keep its three existing call sites
compiling with no change at all. The default type parameter makes this so; verify it by
building, not by reading.

**Watch for.**
- `Comlink.transfer` on an upload buffer **moves** it. The main thread must not read it
  afterwards. The authoritative copy is the blob in IndexedDB.
- The export paths must not participate in the cancel previous protocol. Only
  `generateCutoutBinPreview` cancels its predecessor.
- A `Cancelled` status is not an error and must not surface to the user. The carve stage
  distinguishes it from a genuine failure.
- The import stage's wall clock ceiling from stage 2 reports through this layer as a user
  worded message like any other offset failure, and the affected row reverts to its previous
  clearance rather than blocking.
- **The progress indicator is indeterminate.** Do not add a progress channel that reports a
  fabricated percentage. `ExecutionContext.progress()` cannot be read while the worker thread
  is blocked inside the eager operation, which is the whole reason for the owner's stage 0
  decision. Design 8.5 has the record.
- **There is one worker instance, settled in stage 0.** `workerClient.ts` keeps its single
  `Comlink.Remote` handle and cutout previews go through it like every other request. Do not
  add a second instance, and do not add a partial version of one such as a second WASM load
  behind a flag. The accepted consequence is that a superseded carve cannot be cancelled, so a
  new request waits for it to finish; the ghost tier is what keeps the drag itself responsive.
  Design 8.7 has the record, and the console timings from 8.11 are what would reopen it.

**Console timing instrumentation, per design 8.11.** Build it here and nowhere else. The
worker wraps its own stages with the `timing.ts` helper: STL parse, the clearance offset (the
Minkowski step) and the carve itself, each line naming the model and reporting milliseconds,
with a cache hit on the clearance offset logged as its own line distinct from a miss. It ships
enabled. The geometry functions under `web/src/engine/` stay free of logging: a `console` call
inside them would both scatter the concern and put a side effect in a module that must remain
framework agnostic and pure.

**The cache key is the load bearing detail of this stage.** It is
`${modelSourceId}:${unitScale}:${clearanceMm}`, and getting it wrong has no visible symptom. A
cache missing either the clearance or the unit scale would silently reuse the previous
dilation after that value changed: the preview renders, the solid is watertight, the download
succeeds, and the printed part is simply the wrong size. **The unit scale is in the key for
exactly the same reason the clearance is**: a scale correction (design 5.6) rescales the model
before it is simplified and dilated, so it invalidates the entry just as a clearance change
does, and `releaseCutoutModels` must evict superseded scale keys as well as superseded
clearance keys so accepting a rescale does not leave the pre correction solid in the WASM
heap. Design section 8.6 has the full treatment, including that only the changed model's
offset is recomputed while the bin is then re-carved whole, and why the carve is deliberately
not made incremental.

**Definition of done.**
- `npm run build` and `npm test` green.
- A test drives the worker's cache logic at the engine level: importing the same model twice
  performs the Minkowski offset once. Assert on a call count through an injected seam rather
  than on wall clock time, which is not a stable assertion in CI.
- The two cache tests from design section 10.2 pass: the key changes with clearance and not
  with placement, and recomputing one model's offset leaves the other models' entries intact.
- `releaseCutoutModels` drops superseded clearance keys for a model still in the bin, so
  tuning a clearance through several values does not accumulate solids in the WASM heap.
- Importing a model in the browser prints a timed console line per stage naming the model and
  its milliseconds, and importing the same model again at the same clearance prints the cache
  hit line instead of the offset line. `grep` finds no `console` call under `web/src/engine/`.
- **[CHECKPOINT]** Owner confirms the cancellation refinement is worth keeping. If the `await`
  yield between models does not in fact let a queued cancel through (design section 11, last
  bullet), the honest response is to drop the cancellation and rely on the ghost tier and the
  debounce, not to add timers to force it.

## Stage 7: the viewport composable and the editor viewport

**Goal.** A 3D viewport that can show ghosts and drive two gizmos, without duplicating the
existing scene scaffolding.

**Created.**
- `web/src/composables/useThreeScene.ts`: renderer, scene, camera, `OrbitControls`, lights,
  grid helper, `ResizeObserver` resize, animation loop, the Z up to Y up rotation, mesh
  building from `MeshData`, and the full disposal path.
- `web/src/components/cutout/CutoutViewport.vue`: the carved bin mesh plus translucent ghost
  meshes, two `TransformControls` instances, the drag arbitration, the selection raycast and
  the teardown.

**Modified.**
- `web/src/components/BinViewport.vue`: refactored onto `useThreeScene`. Props, emits and
  rendered output unchanged. The two `MeshStandardMaterial`s move from module scope to
  instance scope, which is required once two viewports can be alive at once.

**Depends on.** Stage 6, for the mesh types.

**Watch for, all verified against `three@0.178.0` in the design.**
- `TransformControls` extends `Controls`, not `Object3D`. Add `controls.getHelper()` to the
  scene, not the controls.
- Construct the **translate** instance first. The instance constructed first wins a tie,
  because `dragging-changed` dispatches synchronously from the `defineProperty` setter before
  the browser delivers `pointerdown` to the second listener.
- Rotate instance `setSize(1.6)`, translate at the default 1. Arrow tips sit at 0.5 and the
  arcs at 0.5 in gizmo units, so equal sizes collide exactly.
- Add the `pointercancel` and `lostpointercapture` guard that forces `dragging = false` on a
  still dragging instance. Without it a lost pointer leaves `OrbitControls` disabled forever.
- Set `gizmoTarget.rotation.order = 'ZYX'`. This is the Euler convention fix from design
  section 4.3, and this is the line that implements it.
- Suppress the selection raycast when either instance reports a non null `axis` or reports
  `dragging`, and when the pointer moved more than a few pixels since `pointerdown`.
- Teardown removes the helper from the scene **before** calling `dispose()`.

**Definition of done.**
- `npm run build` and `npm test` green. There are no component tests, so the suite proves
  only that nothing else broke.
- **[CHECKPOINT]** Owner confirms in the browser: the three existing `BinViewport` call sites
  (manual bin tab, trace layout workspace, and the third) look and behave exactly as before
  after the refactor. This is the only verification available for a refactor with no test
  coverage.
- **[CHECKPOINT]** Owner confirms the gizmo: all handles visible at once, arrows and quads
  and arcs each individually grabbable, no handle unreachable because another sits on top of
  it, the camera never fights a drag, and orbit works normally again after every drag
  including one that ends off canvas. Confirm or adjust the rotate `setSize` value.

## Stage 8: the cutout tab

**Goal.** The whole flow usable end to end: upload, place, preview, queue, edit, download.

**Created.**
- `web/src/stores/cutout.ts`: models, selection, snap flag, bin envelope, label content,
  the reset action, and the `protectedIds` getter the sweep reads.
- `web/src/components/cutout/CutoutTab.vue`: the layout in design section 7.2.
- `web/src/components/cutout/ModelList.vue`: rows, upload, per row delete, per row clearance.
- `web/src/components/cutout/ModelReadout.vue`: the labeled diagnostic rows.

**Modified.**
- `web/src/components/AddBinCard.vue`: the placeholder window item from stage 3 becomes the
  real `<CutoutTab />`.

**Depends on.** Stages 4, 5, 6, 7.

**Watch for.**
- **Write the model blob to IndexedDB before any queue mutation that references it.** This is
  the sharpest trap in the feature. `binQueue.persist()` sweeps on every plan mutation.
- Register the in progress models as `protectedIds` for the whole time the tab holds them and
  no plan row references them.
- The two tier preview: ghosts follow the gizmo every frame with no worker call; the carve
  runs on `dragging-changed(false)` after the 300 ms debounce. The `Stale` chip is visible
  from the first gizmo movement until a fresh carve lands.
- Rehydrating an edit mirrors `TraceTab.vue`: watch `app.editingKind` and `app.editingEntryId`
  with `{ immediate: true }`, deep clone the stored models into the store, load each blob from
  the model store, and report the ones that are missing without blocking layout editing of
  the rest.
- Deep clone everything crossing into the worker to strip Vue proxies.

**Unit mismatch handling, per design 5.6.** STL carries no unit information and inch authored
models are common, so a model imported at the wrong size carves a pocket that fits nothing
while nothing about the file or the app looks wrong. On import, after parsing and before the
worker round trip, compare the model's largest raw dimension against the two thresholds: under
3 mm proposes metres (`unitScale` 1000), over 500 mm proposes inches (`unitScale` 25.4).

- The proposal is **non blocking**. The model imports, places and carves at `unitScale` 1
  while it stands, so a user whose file really is that size ignores it and carries on.
- Two buttons, `Rescale as metres` or `Rescale as inches`, and `Keep as millimetres`.
  Accepting sets `unitScale`, re-runs the import stage for that model (the cache key changed),
  and updates `sizeMm` and the readout. Rejecting leaves it at 1. Either answer is stored in
  the plan, so the question is not asked again for that model or on a later load.
- **Offer whole units only, never a free scale factor field.** A free scale lets the user
  resize the part the pocket must hold, which is the inspiration tool's mistake and the thing
  clearance exists to do properly. Rescaling by 25.4 is not resizing the part, it is stating
  what the part always measured.
- The thresholds are heuristics and are commented as such. Rule 12 is satisfied because they
  decide only **whether to ask the user a question**; nothing is derived from them and the
  user's answer is what changes the geometry. A heuristic that silently rescaled a model would
  be exactly the fudge rule 12 forbids, so never apply the correction automatically.

**Missing model recovery, per design 6.4.** A plan opened on another machine has the metadata
and not the bytes. Per the photo store precedent this is a normal condition, not an error, and
an error message alone is not enough when everything needed to make the bin whole is present
except one file the user probably still has.

- The queue row states that the bin needs its models and names them by stored filename. The
  bin keeps its place, its title and its editability.
- Preview and download refuse with the existing message naming the file. Never generate a bin
  with an empty `models` list, which exports as a solid block and wastes a real print.
- The model list shows a missing model in its own state with a `Locate file` button. Everything
  else in the tab stays editable: resize, label, move the models that resolved, delete the one
  that did not.
- Choosing a file stores it under the **same `modelSourceId`** and preserves `placement`,
  `unitScale` and `clearanceMm` exactly. Nothing has to be re-placed. Several missing models
  are recovered one at a time, each by its own button.
- **If the user picks a different file from the original**, accept it and make the substitution
  visible rather than guarding against it, because STL carries no identity and a stored hash
  could only ever say no, never yes. Update `name` to the new file's name, recompute
  `triangleCount` and `sizeMm` and show them, preserve the placement (a wrong model then sits
  wrong *visibly*, through the ghost and the bounds warnings), re-run the unit check on the new
  file, and state the rename once as a non blocking note: `The file "NEW" was linked to the
  model previously stored as "OLD". Check the size readout if you expected a different model.`
- A file that will not import at all produces the ordinary import rejection and the model stays
  missing, so the user can try another file.

**The transform rows are display only, settled in stage 0 and recorded in design 7.7.**
`ModelReadout.vue` renders position, rotation, size, footprint and resting height as labeled
rows of raw values per rule 8, and none of them is an input. The gizmo is the sole input
method for position and rotation, so no text field, no stepper and no editable cell appears on
those rows, and there is no second path writing the placement into the store. The reason to
hold this line is that an editable row would have to be pushed to the gizmo and pulled back
from it on every drag, and keeping a typed value and a dragged handle agreeing in both
directions is the bookkeeping this decision removes. Editable fields stay a reasonable later
addition, and nothing here forecloses them: the store action the gizmo drives would simply
gain a second caller. **The clearance field is the deliberate exception** and remains an
editable number box, because it is not a gizmo controlled value.

**The clearance control, per design section 7.10.** One per model row, and the only control in
this tab that triggers slow work, so it gets its own handling:

- A number field with stepper arrows, step 0.05 mm, **committed on blur or on Enter**, not a
  slider and not per keystroke. Exact entry is the point (a user going from 0.4 to 0.5 after a
  tight fit), and every intermediate value a slider or a keystroke would pass through is a
  fresh Minkowski sum.
- Bounds are 0 to `maxClearanceMm(gridX, gridY)`, so the field cannot express a value the
  stage 4 validator would reject. Zero is legal and takes the fast path.
- While one model's offset recomputes: an indeterminate progress bar on **that row only**, its
  clearance field disabled so a second change cannot queue behind the first, every other row
  fully editable, and the gizmo still live. The bin shows the previous carve with the `Stale`
  chip. It must never look frozen.
- On failure: the field reverts to the last clearance that succeeded, the bin keeps generating
  with it, and the row shows `Applying a clearance of C mm to the model "NAME" failed
  (DETAIL). The model is still using its previous clearance of P mm.` Reverting rather than
  blocking leaves the user with a working bin and a clear statement of what did not happen.

**[CHECKPOINT]** Confirm the two interface increments (1 mm gizmo translation snap, 0.05 mm
clearance step) and whether `Fit bin to models` is a button rather than continuous auto sizing.

**Definition of done.**
- `npm run build` and `npm test` green.
- **[CHECKPOINT]** Owner confirms end to end in the browser: upload two STLs, place both,
  see the ghost tier during a drag and the real carve after, queue the bin, reload the page,
  reopen the bin for editing, and find both models still there and still placed correctly.
  The reload is the part that proves the IndexedDB path; nothing else can.
- **[CHECKPOINT]** Owner confirms the per model clearance in the browser: set the two models
  to clearly different clearances, for example 0.2 mm and 1.0 mm, and confirm the two pockets
  differ accordingly and that changing one does not alter the other. Confirm the recomputing
  row stays responsive and that the rest of the tab keeps working while it runs.
- **[CHECKPOINT]** Owner confirms the missing model recovery on a clean profile: export a plan
  with a cutout bin, load it in a browser profile with no IndexedDB data, and confirm the queue
  row names the missing file, the download refuses rather than producing a solid block, and
  `Locate file` re-links the model with its placement, rotation and clearance intact. This is
  the path no test can cover, and the "solid block" failure is the one that wastes a print.
- An inch authored STL, or any model deliberately exported at 1/25.4 scale, raises the unit
  proposal on import; accepting it corrects the size rows and re-carves, and rejecting it
  leaves the model at `unitScale` 1. Both answers survive a reload.

## Stage 9: downloads and batches

**Goal.** A cutout bin exports as STL and 3MF, and survives a print batch.

**Modified.**
- `web/src/binDownloads.ts`: `partFootprint`, `partName` and `fileStem` gain cutout handling
  if stage 6 did not already cover them.
- `web/tests/plate/arranger.spec.ts` and `web/tests/threeMf/writer.spec.ts` if a cutout part
  reaches either with a shape they do not already handle.

**Depends on.** Stage 8.

**Definition of done.**
- `npm run build` and `npm test` green.
- A cutout bin turned into a batch and back out again keeps its models, proved by a plan layer
  test through `batches.ts` rather than by hand.
- **[CHECKPOINT]** Per the project's verification bar, the owner opens an exported 3MF of a
  cutout bin in Orca Slicer and confirms the pocket is present, the solid is watertight, and
  the label part is on the second extruder slot. The export format is not considered proven
  until this happens.
- **[CHECKPOINT]** Owner prints one cutout bin and confirms the real object drops into the
  pocket. The 0.4 mm default is a reasoned starting value, not a measured one, and only a
  physical print settles whether it is right. If it proves too tight or too loose, the fix is
  to change the default in its single home in `engine/cutout/cutoutBin.ts`, and the per model
  control means an individual model can be tuned without disturbing the default.

## Summary of ordering constraints

```
Stage 0 (decisions)
   |
Stage 1 (shared carve)  ---> Stage 2 (cutout carve) ---+
   |                                                   |
Stage 3 (plan types) ---> Stage 4 (validators)         |
   |                          |                        |
   +---> Stage 5 (idb + sweep)                         |
                              |                        |
                              +---> Stage 6 (worker) <-+
                                        |
                                     Stage 7 (viewport)
                                        |
                                     Stage 8 (tab)
                                        |
                                     Stage 9 (export)
```

Stages 2 and 3 are independent of each other and can run in parallel. Everything else is
sequential.

## The one rule that overrides the schedule

Stage 1's definition of done is that `web/tests/trace/pocketBin.spec.ts` passes unmodified.
If it does not, the shared carve extraction changed behaviour in a shipped feature. Do not
adjust the test to match the new code, do not proceed to stage 2, and do not merge. Stop and
report what changed and why.
