# STL cutout bin: implementation plan

Date: 2026-07-20. Companion to `docs/superpowers/specs/2026-07-20-stl-cutout-bin-design.md`.
Read the design first; this document does not restate its reasoning.

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

**[CHECKPOINT]** Answer the five remaining open questions in design section 11 before stage 1
begins. Two of them change code written in the early stages and are cheap now, expensive later:

| Question | Affects | Default if unanswered |
| --- | --- | --- |
| Read only versus editable transform rows | Stage 8 | read only |
| Second worker instance for previews | Stage 6 | second instance |

The remaining three (gizmo handle size, the 1 mm translation snap and the 0.05 mm clearance
step, `Fit bin to models` as a button) can be answered at their own stages and are marked
there.

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
- `web/src/engine/cutout/cutoutBin.ts`: `CutoutModelSpec`, `CutoutBinParams`,
  `DEFAULT_CUTOUT_CLEARANCE_MM`, `maxClearanceMm(gridX, gridY)`,
  `simplifyToleranceMm(clearanceMm)`,
  `offsetSphereSegments(clearanceMm, toleranceMm)`, `prepareCutoutModel` (the import stage:
  centre, simplify, offset), `placeCutter` (rotate then translate),
  `validateCutoutPlacement` returning warnings as an array, `buildCutoutBinBody`,
  `generateCutoutBin`, `generateCutoutBinUnion`.
- `web/tests/cutout/cutoutBin.spec.ts`
- Fixture models under `web/tests/cutout/fixtures/` if the existing tetrahedron, cube and
  sphere fixtures are not enough. An asymmetric solid is required for the rotation order
  test; a right triangular prism is sufficient and can be generated in the test rather than
  stored as a file, matching how the existing cutout tests build their fixtures.

**Modified.** Nothing outside `engine/cutout/`.

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

**Definition of done.**
- `npm run build` and `npm test` green.
- Every warning in design section 9.2 that belongs to the carve is **returned** in the result
  array, never thrown. A test asserts that a model fully outside the bin still yields a
  watertight solid.
- The simplify tolerance, the sphere segment count and the clearance ceiling are computed from
  their formulas. A literal `0.04`, `7` or a hardcoded millimetre cap anywhere in the module
  fails this stage.
- The two mixed clearance tests from design section 10.2 pass: two models with different
  clearances each get their own dilation, and a bin mixing 0 mm with 0.4 mm carves both
  correctly. These are what prove per model actually reached the geometry.

## Stage 3: plan layer types

**Goal.** `CutoutBin` and `CutoutModel` exist in the plan model and every exhaustive switch
over `ProductOrigin` compiles again.

**Modified.**
- `web/src/engine/plan/types.ts`: `ModelPlacement`, `CutoutModel`, `CutoutBin`, widened `Bin`
  and `ProductOrigin`, widened `BinProduct.bin`, `PLAN_FILE_VERSION = 6`.
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

**Modified.**
- `web/src/worker/geometry.worker.ts`: `missingCutoutModels`, `putCutoutModel`,
  `releaseCutoutModels`, `generateCutoutBinPreview`, `generateCutoutBin`,
  `generateCutoutBinUnion`, plus the module level model cache keyed by
  `${modelSourceId}:${clearanceMm}` and the active preview `ExecutionContext`.
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
- If the owner chose a second worker instance in stage 0, `workerClient.ts` holds two
  `Comlink.Remote` handles and routes cutout previews to the second.

**The cache key is the load bearing detail of this stage.** It is
`${modelSourceId}:${clearanceMm}`, model identity and clearance together, and getting it wrong
has no visible symptom. A cache keyed by model alone would silently reuse the previous dilation
after a clearance change: the preview renders, the solid is watertight, the download succeeds,
and the printed part is simply the wrong size. Design section 8.6 has the full treatment,
including that only the changed model's offset is recomputed while the bin is then re-carved
whole, and why the carve is deliberately not made incremental.

**Definition of done.**
- `npm run build` and `npm test` green.
- A test drives the worker's cache logic at the engine level: importing the same model twice
  performs the Minkowski offset once. Assert on a call count through an injected seam rather
  than on wall clock time, which is not a stable assertion in CI.
- The two cache tests from design section 10.2 pass: the key changes with clearance and not
  with placement, and recomputing one model's offset leaves the other models' entries intact.
- `releaseCutoutModels` drops superseded clearance keys for a model still in the bin, so
  tuning a clearance through several values does not accumulate solids in the WASM heap.
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
