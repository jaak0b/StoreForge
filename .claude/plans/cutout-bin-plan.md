# STL Cutout Bin: Implementation Plan

Status: Stage 1 is complete and merged to master. Stages 2 to 4 are unbuilt.

Written to be handed to an implementation agent that has none of the conversation this
came from. It reflects the owner's decisions, which in one case overrode the original
planning recommendation.

Read `CLAUDE.md` before implementing anything: rule 1 (watertight geometry, meaningful
tests), rule 2 (no swallowed errors, user-worded messages), rule 3 (engine stays
framework-agnostic), rule 7 (UI text is plain technical prose), rule 8 (diagnostics are
labeled rows of raw values), rule 9 (never downscale exported geometry), rule 10 (extend
the concept's existing home, never duplicate), rule 11 (subagent discipline), rule 12
(established algorithms only, never a hand-tuned constant). Never use an em-dash
character anywhere.

## 1. The feature

The user imports one or more 3D models (STL) and places them inside a bin. The bin's
interior is filled solid up to a chosen height, and the models are boolean-subtracted
from that solid to leave shaped pockets that hold those objects.

Inspiration was the Cutout generator at gridfinitygenerator.com, studied for concept
only; their code is never copied. Two things they do badly that this plan fixes:

- They subtract the model at exact size, so the cavity does not fit the object. Their own
  UI admits this and tells the user to scale the model down by hand, which is wrong
  because uniform scaling gives clearance proportional to size (a long thin part gets a
  huge gap lengthwise and almost none across).
- They support one model per cutout. This plan supports several.

## 2. Owner decisions (settled, do not relitigate)

| Decision | Choice |
| --- | --- |
| Bin type | **Separate bin type with its own workspace tab.** Reason given: it holds widely different data. |
| Models per bin | **Multiple.** |
| Rotation | **Full 3D rotation.** The user is responsible for not creating unprintable geometry. |
| Persistence | **Every uploaded model is stored** so a cutout bin stays fully editable after a browser refresh. |
| Clearance default | **0.4 mm**, one nozzle width, which is what the tool assumes elsewhere. |
| Pocket top | **No through-top mode and no sink-depth control.** The user positions each model freely in all six degrees of freedom, so whether a pocket ends up open at the top or fully buried is purely a consequence of its Z position. One geometry path, no mode switch, no automatic sweep to the top. |

### The cost of the separate-bin-type decision, which the implementation must absorb

The existing traced tool bin already fills the interior solid and subtracts cutters.
A separate bin type means that logic is reached from two places. It must therefore be
**extracted into one shared engine module and called by both**, never copied. This is the
single most important structural constraint here and the most likely place to go wrong.
An implementation writing a second interior-fill-and-carve routine has taken the wrong
path. The shared part is the *geometry*; the data model and the tab are genuinely
separate, which is the part that holds different data.

## 3. What already exists

### 3.1 Stage 1, merged

- `web/src/engine/cutout/stlReader.ts`: `parseStl` handles binary and ASCII STL, plus
  `RawMesh`, `StlParseResult`, `MAX_TRIANGLES`. Format detection uses the length-based
  check (`80 + 4 + 50 * triangleCount === byteLength`), not the naive "starts with the
  word solid" test, because many binary writers put `solid` in the 80 byte header.
- `web/src/engine/cutout/cutoutMesh.ts`: `meshToManifold`, `meshBounds`, `MeshBounds`.
- Tests in `web/tests/cutout/`, including a round trip through the repo's own STL writer
  and a regression test for the mandatory merge step (verified to fail without it).

### 3.2 The pocket carving that must be shared, not duplicated

`web/src/engine/trace/pocketBin.ts` `buildPocketBinBody` does, in order: build the
standard slotted bin body, fill the interior cavity solid, subtract a cutter per placed
item, re-apply the label slot (the fill closed the insert channel), then check `status()`
and throw. Those steps are exactly what a cutout bin needs. `maxPocketDepthMm` and the
structure of `validatePocketLayout` are reusable too.

### 3.3 Other homes to reuse

- `web/src/composables/useTopDownCanvas.ts`: shared top-down mm canvas (view transform,
  fit, client-to-mm, frozen view during drag, resize observer, interior outline and
  dotted 42 mm cell rendering, plus `cssPxToMm` for screen-space affordances). Consume
  it; never re-extract or duplicate it.
- `web/src/photoStore.ts`: IndexedDB wrapper for trace photos, deliberately treating a
  missing photo as a normal condition rather than an error. The precedent for mesh storage.
- `web/src/engine/plan/traceSources.ts`: out-of-band asset garbage collection, split out
  so it is testable with a fake store because node has no IndexedDB.
- `web/src/engine/trace/edit.ts`: `circleSegments(offsetMm)` derives facet counts for
  offsetting. Reuse this derivation rather than writing a second one.
- `web/src/workerClient.ts` `withResolvedBinInsert`: the precedent for resolving
  out-of-band assets on the main thread, because the geometry worker cannot reach
  browser storage.

## 4. Verified manifold-3d facts

Benchmarked directly against the installed manifold-3d 3.5.1. Authoritative.

- **`Mesh.merge()` is mandatory** before constructing a Manifold from STL data. STL
  parsers emit unshared vertices (three per triangle), which fail with "Not manifold"
  without merge and succeed with `NoError` with it. Miss this and every valid STL is
  rejected.
- **`new Manifold(mesh)` throws a raw `Error("Not manifold")`** on an open mesh rather
  than returning a bad status, so the import path must catch and translate.
- **`minkowskiSum` cost scales with input triangle count**, roughly 1.2 ms per triangle
  (600 tris 0.9 s, 8k tris 8.9 s, 31.5k tris 38.5 s).
- **`Manifold.simplify(tolerance)` makes it tractable.** Contract: all surfaces move by
  less than the tolerance. At 0.1 mm it took 31.5k triangles to 2.9k in 18 ms, after
  which the Minkowski took 4.0 s.
- **`ExecutionContext` supports progress and cancellation**, is documented safe across
  workers, and `minkowskiSum` explicitly honours it.

**Correction to an earlier estimate.** A figure of "roughly five minutes at the 250k
triangle ceiling" was circulated and is probably wrong: it applied the raw per-triangle
Minkowski cost without accounting for `simplify` running first. Since simplify is fast
and collapses the count sharply, cost is driven by the post-simplify count, which
plateaus. **Stage 2 must measure real end-to-end cost at several input sizes and set the
ceiling from those numbers** rather than inheriting the current 250k.

## 5. Stage 2: clearance and cutter geometry (engine only)

### 5.1 Extract the shared carving module

Create the shared home for interior-fill-and-carve (suggested
`web/src/engine/gridfinity/pocketCarve.ts`) and refit `trace/pocketBin.ts` onto it with
no behaviour change, proven by the existing trace tests staying green. Its own commit,
before any cutout geometry. The module owns: filling the interior solid, subtracting a
set of cutters, re-applying the label slot, and the status check.

### 5.2 Clearance

Grow the cavity uniformly outward from the model surface by a user-set tolerance. The
exact operation is the **Minkowski sum of the model with a ball of that radius**, which
is morphological dilation by definition. Naming it as such satisfies rule 12: a standard
primitive chosen because it is the correct model, not a tuned number.

```ts
/**
 * Grow the cutter outward by clearanceMm using the Minkowski sum with a sphere of that
 * radius (morphological dilation), the exact definition of a uniform outward offset.
 * The model is first reduced by Manifold.simplify(simplifyToleranceMm), whose contract
 * guarantees every surface moves by less than the tolerance; Minkowski cost scales with
 * input triangle count, so this is what makes the exact offset tractable at all.
 */
export function applyClearance3d(
  m: ManifoldToplevel, solid: Manifold,
  clearanceMm: number, simplifyToleranceMm: number, ctx?: ExecutionContext,
): Manifold;
```

Derive the sphere's facet count by reusing `circleSegments` from `trace/edit.ts`. Comment
the honest consequence: a faceted sphere makes the dilation an inscribed approximation,
so realized clearance is slightly under nominal in some directions. That is a bounded,
derived consequence of the segment count, not a fudge, and the bound should be stated.

Options rejected, with reasons worth preserving: a 2D cross-section offset gives zero
clearance in Z and discards all 3D shape (that is a traced pocket, a different feature);
an SDF level-set remesh would require robust inside/outside classification over arbitrary
triangle soup and would resample the whole surface, so it is not practical here; uniform
scale-up is the inspiration tool's workaround and is wrong as described in section 1.

Defaults: clearance 0.4 mm per the owner. Simplify tolerance 0.1 mm, justified as below
the layer height and line width at which the pocket surface is realized, so the
simplification is not the limiting error term. Expose it as an advanced field.

Rule 9: `simplify` runs on the **cutter only**, never on the exported bin. Put an explicit
comment at the call site, because a reviewer will reasonably ask.

### 5.3 Cutter construction, per model

1. `meshToManifold` (performs the mandatory merge).
2. Scale by the stored unit scale.
3. Apply the stored 3D rotation.
4. `applyClearance3d`, with an `ExecutionContext` attached for progress and cancellation.
5. Translate to the model's stored position. Per the owner's decision the position is
   free in all six degrees of freedom and there is no sink-depth control and no
   sweep-to-top: whether a pocket is open at the top or buried follows from its Z.

Cutters then go through the shared module's union and difference, so the existing status
check and slot re-application cover them unchanged.

### 5.4 Validation

Extend the structure of `validatePocketLayout` with 3D predicates. Every message
user-worded per rule 2, following existing wording patterns:

- Pocket reaching below the floor, quoting actual depth and the maximum for that bin height.
- Pocket breaking into a wall.
- Pocket overlapping the label slot strip.
- Model-to-model overlap.
- Model taller than the bin.
- Magnet and screw holes sit below the floor, so a legal pocket cannot reach them. Assert
  with a test rather than relying on the argument.

### 5.5 Tests

Watertightness and `NoError` on a carved bin; exactly one positive-volume component from
`decompose()` (NOT `genus() === 0`, which is invalid here: sealed voids in the hollow base
make genus legitimately negative, as the divider work established); volume monotonicity;
each validation failure asserting message text. Use a generated primitive written through
the repo's own STL writer and read back as the fixture.

**Also assert nothing appears below the container floor.** The divider feature shipped a
defect where wall roots printed through the base, invisible to every test because they all
asked whether the solid was valid and none asked whether material appeared where it had no
business being. A cutout pocket has the same failure mode.

**Unverified, check first:** whether the stacking lip stays intact when a cutter reaches
the lip region.

## 6. Stage 3: data model and persistence

### 6.1 The bin type

Add the cutout bin as its own origin and product data. Sketch, to be adapted to the code:

```ts
export interface CutoutModel {
  id: string;
  name: string;              // original filename, used in messages and re-import
  meshSourceId: string;      // key into the mesh store
  unitScale: number;         // 1 = mm, 25.4 = inches, 1000 = metres
  clearanceMm: number;
  rotation: { x: number; y: number; z: number };   // full 3D, degrees
  triangleCount: number;     // diagnostics readout
}

export interface ModelPlacement {
  modelId: string;
  xMm: number; yMm: number; zMm: number;   // free in all six degrees of freedom
}
```

Because rotation is full 3D, the XY footprint cannot come from a cheap axis-aligned box
computed once at import. Derive it from the rotated mesh whenever rotation changes, and
cache it then rather than recomputing per drag frame.

### 6.2 Storage

Meshes cannot live in the plan. localStorage is 5 MB per origin, the plan is JSON so
binary must be base64'd at 1.33x, and a 10k-triangle STL is 500 KB, hence 665 KB encoded.
One modest model would consume 13 percent of the plan budget and eight would exhaust it.

Mirror the photo store precedent exactly:

- New `web/src/meshStore.ts` beside `photoStore.ts`, using the **same IndexedDB database**
  with a new object store, bumping the version and creating the store in the existing
  upgrade hook. Reusing the database rather than opening a second one is the rule 10 answer.
- Store the **original STL ArrayBuffer**. Re-parsing on load costs milliseconds, and
  keeping the original means changing clearance or simplify tolerance later does not
  compound degradation.
- **Extend `engine/plan/traceSources.ts`** into an asset-kind-aware collector and sweeper
  rather than writing a parallel one. Its fake-store test pattern extends directly.

The owner requires a cutout bin to stay fully editable after a browser refresh; storing
the original mesh in IndexedDB satisfies this on the same device.

### 6.3 Plans crossing machines

A JSON plan export carries model metadata and placements but not the mesh. On another
machine the mesh is absent. Per the photo precedent this is a normal condition, not an
error, and must be visible rather than silently producing a solid block:

- The queue row shows the bin as needing its model, naming the stored filename.
- The designer offers to re-import that file and re-links it to the existing
  `meshSourceId`, preserving placement, rotation and clearance.
- Preview and download refuse with a user-worded message naming the file to import.

Optional later: export the plan zipped with its STLs. fflate is already a dependency via
the 3MF writer. Design the plan file so this is additive.

### 6.4 Worker wiring

The worker cannot conveniently reach IndexedDB and should not. Follow the existing
precedent: the main thread loads mesh blobs and passes ArrayBuffers as transferables,
adding a resolver beside `withResolvedBinInsert`. Expose a progress and cancellation
channel through Comlink, since this is the first genuinely long geometry operation in the
app and the preview must not appear frozen.

## 7. Stage 4: UI

New cutout tab and canvas, consuming `useTopDownCanvas` rather than reimplementing it.

- File import, with the reader's user-worded errors surfaced rather than logged.
- Placement in the 2D top-down canvas for XY, with Z and full 3D rotation as controls.
  The 3D preview is the verification view.
- Clearance field per model.
- Diagnostics as labeled rows per rule 8: triangle count, bounding box, resulting depth.
- **Progress and cancellation UI for the clearance step**, explicitly requested by the
  owner. Manifold's execution context reports normalized progress, so show real progress
  rather than an indeterminate spinner.
- Unit mismatch handling: on import, if the largest dimension is under 3 mm or over
  500 mm, surface a non-blocking proposal that the model was probably authored in metres
  or inches, offering a unit choice stored as `unitScale` so it round-trips. Do not offer
  free non-uniform scaling, which silently changes the part the pocket must hold.

## 8. Risks, stated honestly

- **Non-watertight input is rejected outright.** There is no repair step. Meshes from the
  wild are frequently not watertight, so a meaningful fraction of imports will be refused.
  Adding repair is a substantial separate feature. A convex hull fallback is tempting
  because it is cheap and always succeeds, but it silently produces a wrong pocket for any
  concave part, so it must never be applied automatically.
- **Minkowski on pathological input is unmeasured.** Benchmarks used clean generated
  solids. Real STLs have slivers, near-degenerate triangles and self-intersections.
  Behaviour on a barely-valid mesh could be far slower than the linear trend or could
  fail. Mitigation: execution context cancellation plus a wall-clock ceiling with a
  user-worded message. **Largest technical risk in the plan.**
- **The triangle ceiling is currently unjustified** at 250k. See section 4.
- **Stacking lip interaction** with a cutter reaching the lip region is unverified.

## 9. Definition of done, per stage

Every stage: `npm run build` and `npm test` green inside `web/`. Commit messages are a
single short sentence. The trailer `Co-Authored-By: Claude <noreply@anthropic.com>` is
allowed; no other AI attribution.

- **Stage 2**: shared carving module extracted with trace behaviour unchanged; clearance
  offsets correctly with tests proving containment; carved bins watertight and a single
  positive-volume component; nothing below the container floor; every validation failure
  asserts its message text; triangle ceiling set from measurement.
- **Stage 3**: models persist and reload across a refresh; the orphan sweep deletes an
  unreferenced mesh and spares a referenced one; a plan exported and re-imported on a
  clean profile loads, stays editable, names the missing file and refuses download with
  the user-worded message; plan JSON size asserted independent of mesh size.
- **Stage 4**: a user imports an STL, places and rotates it, sets clearance, previews the
  bin, and saves it to the queue; the bin downloads as STL and appears on a plate; the
  long clearance step shows real progress and can be cancelled; validation failures are
  readable in the UI.

**Verify in the browser, not only in tests.** The divider feature shipped four defects
that a green suite passed clean through, every one caught by the owner using the app or by
an agent driving a real pointer: silent data loss on save, snapping that could not reach a
valid position, a drag that did nothing with a real mouse, and geometry printing where it
did not belong. Several later "passing" tests were also green for reasons unrelated to
what they claimed to check. Watch a new test fail before trusting it.
