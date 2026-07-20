# STL cutout bin: design

Date: 2026-07-20. Status: proposed, awaiting owner approval.

## Provenance

An earlier plan for this feature lived at `.claude/plans/cutout-bin-plan.md` (commit
`3b18a6b`). **It is superseded by this document and its companion plan.** Where the two
disagreed, this document's decisions stand: the clearance is computed before rotation and
cached, overlapping models are permitted rather than rejected, out of bounds placement is a
non blocking warning rather than a validation failure, and the simplify tolerance is derived
from the clearance rather than fixed.

Ten items the earlier plan carried and this one lacked have been absorbed, and are listed
here by name so a later reader can verify nothing was lost:

1. **Unit mismatch handling on import** (`unitScale`, the heuristic and the proposal): 5.6.
2. **Missing model recovery by re-import**, not merely an error message: 6.4.
3. **The triangle ceiling must be measured, not inherited**: 8.8, and a plan checkpoint.
4. **A wall clock ceiling on a pathological clearance operation**: 8.9, the largest
   technical risk in the earlier plan.
5. **`genus() === 0` is the wrong validity assertion here**, because sealed voids in the
   hollow base make genus legitimately negative: section 10 preamble.
6. **Assert that nothing appears below the container floor**, and that magnet and screw
   holes are the legitimate exception: 10.1 and 10.2.
7. **Never apply a convex hull fallback automatically** to a non watertight mesh: 1, out of
   scope, and 11.
8. **Stacking lip interaction with a cutter reaching the lip region is unverified**: 10.2
   and 11.
9. **Store the original STL bytes** so a later clearance change does not compound
   degradation: 6.1, where this design already did so, with the reasoning now recorded.
10. **Design the plan file so a zipped with models export is additive later**: 5.3.

Two further points were reconciled deliberately rather than simply absorbed: the offset
sphere's facet count now reuses the codebase's existing derivation (8.3), and the owner's
original request for a real percentage progress bar is recorded together with why it is not
achievable and what was accepted instead (8.5).

## In plain terms

Today a bin is an open box, optionally split by divider walls or carved with tool shaped
pockets traced from a photo. This adds a fourth way to make one: **drop a 3D model into the
bin and let the bin close around it.**

The user opens a new Cutout bin tab, uploads one or more STL files, and sees each model
floating inside a translucent bin in the 3D view. They drag each model into place with the
usual arrows and rotation rings, and the bin's interior fills in solid around them, leaving a
pocket shaped exactly like each model. Print the bin and the real objects drop into their
pockets.

Three things follow from that, and they are the whole design:

- **Each pocket is cut slightly larger than its model** so the real part actually fits rather
  than jamming. The amount is set per model, because a socket set and a wrench in the same
  tray do not want the same fit.
- **Where a model sits in height decides whether its pocket is open or closed.** Push a model
  up through the rim and its pocket opens at the top; sink it fully and the bin closes over
  it. There is no setting for this and no mode to choose, only where the user put the model.
- **The uploaded files are kept on the device**, so a bin can still be opened and rearranged
  weeks later rather than becoming a one shot export.

What the user sees and does, end to end: pick the tab, upload files, drag them into position,
watch the bin carve itself, add it to the print queue like any other bin, and download it as
STL or 3MF.

The rest of this document is the implementation detail behind that.

## 1. Summary and scope

A new bin type whose interior is carved by subtracting user supplied STL models. The user
uploads one or more models, places each freely in the bin with a drag gizmo in the 3D
viewport, and the generator fills the bin interior solid and subtracts the placed models,
each dilated by a clearance so the real object drops into the printed pocket.

### In scope

- A separate bin origin (`cutout`) with its own tab in the add bin card.
- Multiple models per bin, each with an independent position, rotation and clearance.
- Full 3D placement through a combined translate and rotate gizmo in the viewport.
- Clearance as a true 3D offset (Minkowski sum with a sphere), default 0.4 mm.
- Persistence of every uploaded model in IndexedDB so a bin stays editable after a reload.
- Plan file round trip, queue row description, STL and 3MF download, print batches.
- Extraction of the carve stage shared with the existing traced pocket bin.

### Out of scope

- Any through top mode or sink depth control. Whether a pocket opens at the rim is purely a
  consequence of where the user put the model in Z. One geometry path, no modes.
- Scaling of imported models. The gizmo offers translate and rotate only. Scaling an
  imported tool model would silently produce a pocket that does not match the real object,
  so it is excluded deliberately rather than merely unimplemented.
- Mesh repair. A model that is not a closed solid is rejected with a user worded message.
  In particular, **a convex hull fallback is never applied automatically.** It is the
  tempting repair, because `Manifold.hull()` is cheap and always succeeds on any triangle
  soup, so a non watertight import could always be made to produce *something*. That is
  exactly why it is prohibited: for any concave part, and every tool worth a shadow pocket is
  concave somewhere, the hull is a different shape from the model, so the pocket would be
  silently wrong rather than visibly absent. Refusing the import tells the user the truth;
  hulling it tells them a lie they only discover after a print. A hull offered explicitly, as
  a clearly labelled user choice, is a possible later feature and nothing here forecloses it.
  What is forbidden is applying it as an automatic fallback.
- Automatic bin sizing. A button derives a suggested footprint from the placed models, but
  nothing resizes the bin behind the user's back.
- Formats other than STL. `3MF` and `STEP` import are possible later; the reader module is
  already factored so a second parser is additive.

### Verified starting point

`web/src/engine/cutout/` already contains `stlReader.ts` (`parseStl`, `RawMesh`,
`StlParseResult`, `MAX_TRIANGLES = 250000`) and `cutoutMesh.ts` (`meshBounds`,
`meshToManifold`), with 20 passing tests in `web/tests/cutout/`. Nothing imports either
module today: there is no worker method, no client wrapper, no product kind, no validator,
no UI and no carve geometry. Everything below builds on those two modules unchanged.

## 2. The shared carve module

### 2.1 What the two flows actually share

I compared `web/src/engine/trace/pocketBin.ts::buildPocketBinBody` against what a cutout bin
must do. **Re-verified against that function after the divider wall work merged**, which
touched `pocketBin.ts`: the two changes there were `hasFusedLabel` becoming `hasFusedShelf`
and the divider guard in `validatePocketLayout` moving from `dividerCountX/Y` counts to
`params.walls.length > 0`. Neither is inside the fill, subtract or re-slot stages, so the
factoring below stands unchanged. References here name functions rather than line numbers so
they do not rot on the next merge.

The traced pocket bin performs these steps:

1. `buildSlottedBinBody(m, { ...params, scoop: false })`, the standard bin with its label
   slot or fused shelf, with the scoop suppressed.
2. Build the interior fill: a rounded rectangle cross section of the interior, extruded from
   `FLOOR_TOP` to `bodyTop`, reaching `eps` into the floor plate so it welds.
3. `union([body, fill])`, giving a bin whose interior is solid material.
4. Build cutter solids. **This is the only step that differs.**
5. `difference(filled, unionOfCutters)`.
6. Re-apply the label slot, because the interior fill closed the insert channel.
7. Check `status()` and throw on anything other than `NoError`.

A cutout bin performs steps 1, 2, 3, 5, 6 and 7 identically, and differs only in step 4:
its cutters are transformed, clearance dilated imported meshes rather than extruded 2D tool
outlines. The shared concept is therefore concrete and substantial, not a vague resemblance:

> **Fill a Gridfinity bin's interior solid, subtract a set of cutter solids, and restore the
> label slot the fill closed.**

That is a bin geometry stage. It is not a trace concept, and it currently lives under
`engine/trace/` only because the traced pocket bin was the first flow to need it.

### 2.2 Where it belongs

New module: **`web/src/engine/gridfinity/carvedBin.ts`**.

It goes in `gridfinity/` because that directory owns bin geometry and already owns
`buildSlottedBinBody`, which this stage sits directly on top of. It is its own module rather
than more lines in `binGenerator.ts`, already by some margin the largest module in that
directory, because rule 3 says a new geometry stage is its own module.

### 2.3 Interface

```ts
/**
 * The interior cavity cross section a carve fills solid: the same inset rounded
 * rectangle the bin generator's interior cutter uses at floor level. The single
 * home for this profile; both carve flows take it from here.
 */
export function interiorSection(m: ManifoldToplevel, gridX: number, gridY: number): CrossSection;

/**
 * The interior fill solid: the interior cavity from the floor top up to the
 * nominal bin top, reaching eps into the floor plate so it welds to it.
 * Exported so tests can measure the fill independently of any carve.
 */
export function buildInteriorFill(m: ManifoldToplevel, params: BinParams): Manifold;

/**
 * The deepest a cut may reach before it breaks through the interior floor:
 * from the nominal bin top down to the top of the floor plate.
 */
export function maxCarveDepthMm(heightUnits: number): number;

/**
 * Build a bin whose interior is filled solid and then carved by the given
 * cutter solids. The caller owns validating its own cutters; this stage owns
 * the fill, the subtraction, restoring the slot the fill closed, and the
 * manifold status check.
 *
 * Takes ownership of `cutters`: every element is deleted before returning,
 * on the success and the failure path alike.
 */
export function buildCarvedBinBody(
  m: ManifoldToplevel,
  params: BinParams & { labelSlot?: boolean } & Pick<SlottedBinParams, 'fusedLabel'>,
  cutters: Manifold[],
  /** Names the flow in the invalid solid message, for example 'Pocket bin'. */
  subject: string,
): Manifold;
```

Cutters are passed as an already built `Manifold[]` rather than as a builder callback. The
callback form would let the stage decide when cutters are built, which no caller needs, and
it would obscure ownership. Passing the array makes deletion responsibility explicit and
testable.

### 2.4 What moves and what each flow keeps

**Moves from `engine/trace/pocketBin.ts` to `engine/gridfinity/carvedBin.ts`:**

| Moving | Note |
| --- | --- |
| `interiorSection` | Currently a private function; becomes exported. |
| `maxPocketDepthMm` | Renamed `maxCarveDepthMm`. `pocketBin.ts` re-exports it under the old name so its callers and its tests are untouched. |
| The interior fill construction | Currently inline in `buildPocketBinBody` steps 2 and 3. |
| The subtract, re-slot and status check | Currently inline in `buildPocketBinBody` steps 5, 6 and 7. |
| The `eps = 0.01` overlap constant and its comment | It belongs to the fill and the subtraction, both of which move. |

**`pocketBin.ts` keeps:** `PocketBinParams`, `PlacedPocket`, `placeTools`, `outlineSection`,
`placedCutSection`, `validatePocketLayout`, `generatePocketBin`, `generatePocketBinUnion`,
and the construction of its extruded outline and finger hole cutters. `buildPocketBinBody`
shrinks to: place tools, validate, build cutters, call `buildCarvedBinBody`.

**The cutout flow (`engine/cutout/cutoutBin.ts`) owns:** turning a stored model plus its
placement and clearance into a cutter solid, its own validation, and its own generators.

Note one asymmetry that confirms the cut line is in the right place. The pocket flow extrudes
its cutters up to `bodyTop + LIP_HEIGHT + eps` so a pocket is always open at the top. The
cutout flow deliberately does not do that: its cutter is the model itself, wherever the user
put it, so a raised model opens its pocket and a sunk one does not. That "reach past the top"
is cutter construction, which stays with the pocket flow, not a property of the shared stage.

### 2.5 A second, smaller shared concept

`validatePocketLayout` protects the label slot structure's plan strip (`SLOT_REACH_DEPTH`, or
`FUSED_SHELF_REACH_DEPTH` when fused) from being cut into. A cutout model dropped over the
front wall would break the insert seat in exactly the same way. That check is therefore also
shared, and moves to `carvedBin.ts` as:

```ts
/**
 * The plan strip the label insert slot or the fused label shelf occupies, or
 * null when the bin has neither. Any carve overlapping it would undercut the
 * seat the insert rests on.
 */
export function labelStructureStrip(
  m: ManifoldToplevel,
  params: BinParams & { labelSlot?: boolean } & Pick<SlottedBinParams, 'fusedLabel'>,
): { section: CrossSection; name: string } | null;
```

Both flows call it and word their own message around it, because the message names the thing
that offended ("the pocket for X", "the model Y").

### 2.6 Honest note on how alike they are

The two flows are alike in the carve stage and in nothing else. The traced flow is 2.5D: a
tool outline is a cross section and a pocket is a prism with a flat floor. The cutout flow is
fully 3D. There is no shared placement model, no shared validation of shape, and no shared
UI. The factoring above is deliberately narrow for that reason. Attempting a broader shared
abstraction ("a thing placed in a bin") would unify types that have nothing in common beyond
the word "placed", which rule 10 does not ask for and which would make both flows harder to
read.

## 3. The carve pipeline

### 3.1 Where the expensive work actually goes

The single most important structural decision: **the clearance offset is computed once per
model per clearance value and cached in the worker, not once per carve.**

The Minkowski sum with a sphere is rotation invariant, because a sphere is isotropic.
Offsetting and then rotating gives the same solid as rotating and then offsetting. So the
offset can be computed in the model's own frame, at import time, and reused for every
subsequent placement change. This is the reason the sphere is the correct offset primitive
here, over and above it being a true 3D offset rather than a per axis one.

That splits the pipeline into a slow import stage that runs once and a fast edit stage that
runs on every drag end.

**Because clearance is per model (5.2), the cached offset is keyed by model identity, unit
scale and clearance together.** Section 8.6 works through what that costs and how the UI
covers it, and 5.6 covers why the unit scale belongs in the key. Moving a model is cheap;
changing its clearance or its unit scale is not.

### 3.2 Import stage, once per model (and again if its clearance or unit scale changes)

| # | Stage | Call | Cost |
| --- | --- | --- | --- |
| 1 | Parse | `parseStl(buffer)` | Linear in file size. Milliseconds. |
| 2 | Build mesh | `new m.Mesh({ numProp: 3, vertProperties, triVerts })` | Negligible. |
| 3 | **Weld** | `mesh.merge()` | Mandatory. Without it every valid STL is rejected as not manifold, because STL gives every triangle its own three vertices. Already handled inside `meshToManifold`. |
| 4 | Validate solid | `new m.Manifold(mesh)` then `status()` | Throws a raw `Not manifold` error on an open mesh, already translated to a user worded message by `meshToManifold`. |
| 5 | **Scale to mm** | `solid.scale(unitScale)` | Free. Identity for the normal `unitScale` of 1. See 5.6. |
| 6 | Centre | `solid.translate(-cx, -cy, -cz)` from `boundingBox()` | Deferred and free. See 4.2. |
| 7 | **Simplify** | `solid.simplify(toleranceMm)` | Proportional to triangle count. This is what makes stage 8 tractable. |
| 8 | **Offset** | `simplified.minkowskiSum(m.Manifold.sphere(clearanceMm, segments))` | Roughly 1.2 ms per input triangle. Dominates everything. |
| 9 | Cache | store under `${modelSourceId}:${unitScale}:${clearanceMm}` | See 5.6 and 8.6 for why the unit scale is part of the key. |

The scale step comes **before** the centring and the simplify, and this order is forced. The
simplify tolerance and the clearance are both millimetre figures, so they only mean what they
say once the solid is in millimetres: simplifying at 0.04 mm a solid still in inch units
would spend forty times the intended error budget.

When `clearanceMm` is 0 there is no offset to compute and no error budget to spend, so
stages 7 and 8 are both skipped entirely and the centred solid is cached directly. That makes
a zero clearance import effectively instant.

### 3.3 Edit stage, once per carve

| # | Stage | Call | Cost |
| --- | --- | --- | --- |
| 1 | Transform | `cached.rotate([rx, ry, rz]).translate([x, y, z])` | Manifold combines and applies transforms lazily, so this is close to free. **Rotate then translate**, see 4.3. |
| 2 | Bin body | `buildSlottedBinBody(m, { ...params, scoop: false })` | Unchanged from today. |
| 3 | Interior fill and union | `buildInteriorFill`, `union` | Unchanged from today. |
| 4 | Union of cutters | `m.Manifold.union(cutters)` | Modest. |
| 5 | Subtract | `m.Manifold.difference(filled, cutter)` | The real per carve cost. Sub second for typical models. |
| 6 | Restore slot | `applySlotToBody` | Unchanged. |
| 7 | Status | `body.status() !== 'NoError'` throws | Unchanged. |

Only stage 5 is meaningfully expensive, and it runs on the already simplified geometry.

### 3.4 Scoop

Cutout bins pass `scoop: false`, exactly as pocket bins do and for the same reason: the
interior is filled solid, so a scoop has nothing to sweep and would only fight the carve.

### 3.5 A model partly or wholly outside the interior

Free placement is the requirement, so neither case is an error and neither blocks anything.
Both are detected in the worker and returned as user worded warnings alongside the mesh.

Detection, on the transformed cutter against the interior fill solid:

- **Wholly outside**: `cutter.intersect(interiorFill).isEmpty()`. The carve removes nothing.
  Message: `The model "NAME" sits entirely outside the bin interior, so it carves nothing.
  Move it into the bin.`
- **Partly outside**: `cutter.subtract(interiorFill)` is not empty while the intersection is
  not empty either. The pocket breaks through a wall or the floor. Message: `The model
  "NAME" reaches outside the bin interior, so its pocket breaks through the bin. Move it
  further in, or use a larger or taller bin.`
- **Over the label structure**: the transformed cutter's plan projection overlaps
  `labelStructureStrip`. Message: `The model "NAME" reaches under the label insert slot,
  which needs to stay solid for the insert to rest on. Move it away from the front wall.`
  (`the fused label shelf` substituted when the bin carries a fused label.)

These are warnings, returned in the result, rendered as a warning alert, and the mesh is
still produced and still downloadable. The user is responsible for deciding whether a pocket
that opens through a wall is what they meant.

### 3.6 Two models that overlap

Nothing special happens and nothing is reported. The cutters are unioned before subtraction,
so overlapping models simply merge into one pocket. This differs deliberately from the
traced pocket bin, which rejects overlapping pockets: there, two overlapping tool outlines
are certainly a layout mistake, because two tools cannot occupy the same place on a shadow
board. Here, deliberately intersecting two models to compose a pocket shape is a legitimate
technique, and forbidding it would remove capability for no safety gain.

### 3.7 Cutter that swallows the whole interior

If the union of cutters contains the entire interior fill, the result is a bin with a plain
open interior, which is valid geometry and needs no special handling. The partly outside
warning will normally already have fired.

## 4. The placement model

### 4.1 Representation

**Recommendation: Euler angles in degrees plus a translation vector, six named scalars.**

```ts
/** Where one imported model sits in the bin, in bin-local millimetres. */
export interface ModelPlacement {
  /** Position of the model's centred origin along X. */
  xMm: number;
  /** Position of the model's centred origin along Y. */
  yMm: number;
  /** Position of the model's centred origin along Z, measured from the bed. */
  zMm: number;
  /** Rotation about the global X axis, in degrees. */
  rotXDeg: number;
  /** Rotation about the global Y axis, in degrees. */
  rotYDeg: number;
  /** Rotation about the global Z axis, in degrees. */
  rotZDeg: number;
}
```

Reasoning:

1. `Manifold.rotate` takes **degrees**, and its documentation states that degrees exist so it
   can "eliminate [rounding error] completely for any multiples of 90 degrees", with more
   efficient code paths for those cases. Storing a 4x4 matrix would force `transform(Mat4)`
   and forfeit both properties, and axis aligned placements are the common case.
2. The plan file is validated field by field with user worded messages. Six named finite
   numbers validate with the existing `isFiniteNumber` idiom and read meaningfully in an
   exported plan. A flat array of sixteen numbers validates only as "sixteen finite numbers"
   and tells a human reader nothing.
3. The plan layer already stores rotation as `rotationDeg: number` on `TracedTool`. Degrees
   are the established convention in this codebase.

Alternative, not chosen: store a 4x4 matrix. It sidesteps every Euler convention question
(see 4.3) at the cost of an opaque plan file, weaker validation, and losing the 90 degree
fast path.

### 4.2 Units and origin

All values are millimetres in the bin's own frame, which is the frame the whole geometry
layer already uses: the bin is centred on the origin in X and Y, and Z is measured up from
the build plate, so the interior floor top is at `FLOOR_TOP` (7.0 mm) and the nominal bin top
is at `heightUnits * HEIGHT_UNIT`.

**The imported mesh is centred at import time.** Its axis aligned bounding box centre is
translated to the origin and that becomes the canonical cached solid. Two consequences, both
wanted:

- Rotation in manifold is about the origin, so rotating a centred mesh rotates it about its
  own centre. A model authored far from its own origin would otherwise swing across the bin
  when rotated, which is unusable with a gizmo.
- `three.js` rotates an `Object3D` about its own origin too, so the ghost mesh in the
  viewport and the carved solid rotate about the same point. Without centring they would
  visibly disagree.

`ModelPlacement.xMm/yMm/zMm` is therefore the position of the model's bounding box centre.
The readout also shows the derived resting height (`zMm - rotatedSizeZ / 2`) because that is
the number a user actually reasons about when deciding whether a pocket breaks the floor.

### 4.3 Rotation order, and a convention trap

`Manifold.rotate(v)` documents: "From the global reference frame, a model will be rotated in
*x-y-z* order." That is **extrinsic XYZ**.

`three.js` `Euler` defaults to order `'XYZ'`, which is **intrinsic XYZ**, and intrinsic XYZ
equals extrinsic ZYX. The two are not the same, and they disagree for any rotation that is
not about a single axis. Reading `object.rotation.x/y/z` off a default `Euler` and feeding it
to `Manifold.rotate` would make the ghost preview and the carved pocket disagree the moment
a user rotates about two axes.

The fix is one line and must not be omitted: **set the gizmo target's Euler order to `'ZYX'`**
(`gizmoTarget.rotation.order = 'ZYX'`), because three's intrinsic ZYX equals extrinsic XYZ,
which is manifold's convention. The stored angles are then read directly off that Euler.

I could not execute this to confirm, so it is specified as a requirement with a test that
catches it: a compound rotation of 90 degrees about X followed by 90 degrees about Y is not
commutative, so a known asymmetric solid rotated that way lands in a different place under
the two conventions. The test asserts the manifold bounding box matches the three.js matrix
applied to the same corner points. See 9.1.

### 4.4 Order of operations

**Rotate, then translate.** `cached.rotate([rx, ry, rz]).translate([x, y, z])`.

This is forced, not chosen. Rotation is about the origin, so it must happen while the model
is still centred there; translating first would rotate the model about the bin's centre
instead of its own. It also matches `three.js`, which applies an `Object3D`'s scale, then
rotation, then position, so the ghost and the carve agree by construction.

### 4.5 The rotated footprint

The owner's requirement is that the footprint comes from the rotated mesh, not the raw
bounding box, and that the sizing is done post transform.

Two derivations, for two different purposes, and they must not be confused:

- **Live, during a drag**: `new THREE.Box3().setFromObject(ghostMesh)` in the viewport. This
  walks the actual transformed vertices, so it is exact, not a bounding box of a bounding
  box. The ghost is the full resolution imported geometry, so this costs a vertex pass per
  frame on at most 250000 triangles, which three handles comfortably. This drives the live
  readout and the live fit hint.
- **Authoritative, in the worker**: `transformedCutter.boundingBox()` on the offset, rotated
  manifold. This includes the clearance dilation, which the ghost does not, and it is the
  figure the fit check and the "fit bin to models" suggestion use.

Both are returned as raw numbers to the readout. Neither is ever rounded before use.

Note that transforming the eight corners of the untransformed bounding box and taking their
extent would be cheaper but is a strict overestimate for any non box shaped model, and would
raise false "does not fit" warnings. It is not used.

## 5. Data model

### 5.1 New types in `engine/plan/types.ts`

```ts
/**
 * One imported model carved out of a cutout bin's interior. The model's
 * triangles are not stored here: they live in this device's model store under
 * modelSourceId, because a single 10000 triangle STL is about 665 KB as base64
 * and the whole localStorage plan has 5 MB to work with.
 */
export interface CutoutModel {
  /** Stable unique identifier within the bin. */
  id: string;
  /** The uploaded file's name, shown in the model list. */
  name: string;
  /**
   * Key of the model's STL bytes in this device's model store. A plan imported
   * from another device has the id but not the bytes; the bin is then listed
   * but cannot be generated until the model is uploaded again.
   */
  modelSourceId: string;
  /** Triangle count as imported, for the diagnostic readout. */
  triangleCount: number;
  /**
   * Multiplier taking the file's own coordinates to millimetres. STL carries
   * no unit declaration at all, so this is the user's answer to a question the
   * file cannot answer: 1 for a file already in mm, 25.4 for one authored in
   * inches, 1000 for one in metres. Defaults to 1 and stays 1 unless the user
   * accepts the proposal in 5.6. Stored so the choice round trips in the plan
   * rather than having to be made again on every load.
   */
  unitScale: number;
  /**
   * Size of the model's own bounding box in mm after unitScale is applied,
   * before any rotation.
   */
  sizeMm: { x: number; y: number; z: number };
  /** Where the model sits in the bin. */
  placement: ModelPlacement;
  /**
   * How far this model's pocket is dilated beyond the model surface, in mm, as
   * a true 3D offset. Per model, not per bin: a socket set and a wrench in one
   * tray do not want the same fit.
   *
   * Deliberately a sibling of placement rather than a field inside it. A
   * placement change is cheap (a lazy transform of a cached solid); a clearance
   * change is expensive (it invalidates that cache and re-runs the Minkowski
   * sum). Keeping them apart lets the diff between two model records answer
   * "was this cheap or expensive?" directly, with no extra bookkeeping.
   */
  clearanceMm: number;
}

/**
 * A bin whose interior is carved by imported models, as designed on the Cutout
 * bin tab. Like a traced bin it carries no divider walls: the interior is
 * filled solid for the carve, so walls have nothing to divide.
 */
export interface CutoutBin extends BinEnvelope {
  origin: 'cutout';
  /** The models carved out of the interior. Empty means an uncarved solid interior. */
  models: CutoutModel[];
}

export type Bin = ManualBin | ScrewBin | TracedBin | CutoutBin;
export type ProductOrigin = 'manual' | 'screw' | 'traced' | 'cutout';
```

`BinProduct.bin` widens from `ManualBin | TracedBin` to `ManualBin | TracedBin | CutoutBin`,
so a cutout bin can be ordered with an empty slot or with no label feature at all.
`BinWithInsertProduct.bin` is already `Bin` and needs no change.

### 5.2 Clearance is per model, and that was a deliberate trade

```ts
/**
 * Default dilation of a cutout pocket beyond the model surface. One nozzle
 * width, matching the extrusion width the rest of the tool assumes, which is
 * the smallest gap an FDM printer can be expected to actually leave open.
 */
export const DEFAULT_CUTOUT_CLEARANCE_MM = 0.4;
```

Its home is `engine/cutout/cutoutBin.ts` and both the store default and the plan loader
default read it from there. It is the single source: no other module restates 0.4.

**Recorded for the future: the owner considered one clearance per bin and rejected it.** The
reasoning is that models sharing a tray genuinely differ in the fit they want, a snug locating
pocket beside a loose drop in one, and a single bin wide value would force the user to print
two bins to get two fits. The costs of per model are accepted knowingly:

- an extra control on every model row rather than one control per bin,
- a cache keyed by clearance as well as model, so changing one model's clearance re-runs the
  expensive offset for that model (8.6),
- a per model simplify tolerance, since the tolerance is derived from the clearance (8.2).

None of these is a reason to revisit the decision. They are written down so that a later
reader finds the trade already reasoned through rather than reopening it.

### 5.3 Plan file version bump

`PLAN_FILE_VERSION` goes from 5 to **6**. A version 6 file may contain `origin: 'cutout'`
bins; versions 1 through 5 cannot and are read exactly as they are today. No conversion is
needed in either direction for existing data, because the change is purely additive: no
existing field changes meaning.

`parsePlanFile` already rejects a file whose version exceeds `PLAN_FILE_VERSION` with
`The file has plan version N, but this app reads versions 1 to M.` That message stays and
now names 6, which is the correct behaviour when an older build meets a newer plan.

#### Leaving room for a plan exported with its models

A JSON plan carries model metadata but not model bytes (6.4), so a plan moved between
machines arrives without its models. The obvious later answer is a second export format: the
plan JSON plus the STL files in one zip. `fflate` is already a dependency through the 3MF
writer, so nothing new is needed to build one.

That is deliberately **not** in scope now, but the file format is designed so it can be added
**purely additively**, and this constrains the design today in three ways:

- **`modelSourceId` is an opaque key, never a path.** A zipped export names its entries from
  the id, and an id that had encoded a device local storage detail would not survive the
  trip. Treating it as opaque keeps the same id meaningful inside a zip, inside IndexedDB and
  inside a plan from another machine, so a re-import can re-link by id (6.4).
- **Model metadata is complete without the bytes.** `name`, `triangleCount`, `sizeMm`,
  `unitScale`, `placement` and `clearanceMm` are all in the plan. A reader that has the JSON
  and not the bytes can still list, describe and validate the bin. A zipped export therefore
  adds bytes to a description that is already whole, rather than completing a description
  that was partial.
- **The zip would carry the same JSON unchanged**, as a plan file entry beside a directory of
  models. So a zipped export is a container around the version 6 plan, not a version 7 plan.
  Adding it later needs no version bump, no field changes and no migration, and an older
  build handed the inner JSON still reads it exactly as it reads any version 6 plan.

The one thing this rules out is storing model bytes inline in the plan JSON as base64, which
6.1 rejects on size grounds anyway. The two reasons agree.

### 5.4 Validators

Following the established `validateX(raw, subject): string | null` plus `pickX(raw): X`
pattern in `planFile.ts`. Messages are technical and name the offending field, matching the
existing style of `validatePockets`.

```ts
export function validateCutoutModels(raw: unknown, subject: string): string | null;
export function pickCutoutModels(raw: Record<string, unknown>): CutoutModel[];
```

Exact messages, in check order:

| Condition | Message |
| --- | --- |
| `models` is not an array | `${subject}: models must be a list` |
| an element is not an object | `${subject}: a cutout model is not an object` |
| `id` missing or empty | `${subject}: a cutout model is missing its id` |
| duplicate `id` | `${subject}: cutout model id ${id} appears twice` |
| `name` not a string | `${subject}: cutout model ${id}: name must be a string` |
| `modelSourceId` missing or empty | `${subject}: cutout model ${id}: modelSourceId must be a non-empty string` |
| `triangleCount` not an integer of at least 1 | `${subject}: cutout model ${id}: triangleCount must be an integer of at least 1` |
| `triangleCount` over the ceiling | `${subject}: cutout model ${id}: triangleCount must not exceed ${MAX_TRIANGLES}` |
| `unitScale` not finite or not greater than 0 | `${subject}: cutout model ${id}: unitScale must be a number greater than 0` |
| `sizeMm` missing a finite x, y or z | `${subject}: cutout model ${id}: sizeMm needs finite x, y and z` |
| `placement` not an object | `${subject}: cutout model ${id}: placement must be an object` |
| any placement field not finite | `${subject}: cutout model ${id}: placement ${field} must be a number` |
| `clearanceMm` not finite or negative | `${subject}: cutout model ${id}: clearanceMm must be a number of at least 0` |
| `clearanceMm` above the bin's limit | `${subject}: cutout model ${id}: clearanceMm is C mm, but a bin GX by GY cells allows at most M mm` |

The clearance ceiling is derived, not picked. A clearance dilates the model in every
direction, so once it exceeds half the bin's narrowest interior dimension the dilation alone
is wider than the bin and no model can fit whatever its size:

```ts
/**
 * The largest clearance a bin of this footprint can hold: half its narrowest
 * interior dimension, beyond which the dilation alone exceeds the interior.
 * The single home for this figure; the validator message and the clearance
 * field's maximum both quote it.
 */
export function maxClearanceMm(gridX: number, gridY: number): number {
  return Math.min(binInteriorSizeMm(gridX), binInteriorSizeMm(gridY)) / 2;
}
```

`validateCutoutModels` therefore takes the bin's `gridX` and `gridY`, which `validateBin`
already has, so the message can quote the real limit. This follows the precedent set by the
pocket depth message, which names the actual depth the bin allows rather than saying the value
is out of range.

In `validateBin`, a new branch mirroring the traced one:

```ts
if (bin.origin === 'cutout') {
  if (bin.walls !== undefined || bin.dividerCountX !== undefined || bin.dividerCountY !== undefined) {
    return `${subject}: a cutout bin cannot have divider walls`;
  }
  return validateCutoutModels(bin.models, subject);
}
```

and the trailing message widens to
`${subject}: bin origin must be manual, screw, traced or cutout`.

`clearanceMm`, `unitScale` and `sizeMm` are accepted as absent and defaulted on pick
(`DEFAULT_CUTOUT_CLEARANCE_MM`, `1`, and zeroes recomputed on next generation), following the
precedent set by `minHoleWidthMm` and `filledHoleIndices`, so a plan written by an early
build still loads. Defaulting `unitScale` to 1 is the right default in both directions: a
plan written before the field existed described a model that was already treated as
millimetres, so 1 reproduces exactly what that plan meant.

### 5.5 Downstream plan layer changes

- `engine/plan/geometry.ts`: `toSlottedBinParams` widens its walls guard from
  `bin.origin === 'traced' ? [] : bin.walls` to treat `cutout` the same way. `partsOf` and
  `previewBinParams` gain a `cutout` branch carrying the models through, mirroring how they
  carry `pockets`. `PrintablePart` gains an optional `models?: CutoutModel[]` beside
  `pockets?: BinPockets`.
- `engine/plan/rowDescriptor.ts`: `detailToken` and `synthesizedTitle` both currently branch
  on `origin === 'traced'` and **fall through to the divider walls branch otherwise**. They
  are not exhaustive, so a cutout bin would silently read `bin.walls` (undefined) and crash
  or read as a manual bin. Both must gain an explicit `cutout` branch:
  `countPhrase(n, 'cutout')` for the detail, and `Cutout bin` or
  `Cutout bin, ${countPhrase(n, 'cutout')}` for the title. This is a trap, not a nicety.
- `binDownloads.ts`: `generatePartMeshes` and `generatePartUnion` gain a cutout branch, and
  everything crossing into the worker is deep cloned to strip Vue proxies, exactly as
  `plainPockets` does today.
- `components/AddBinCard.vue`: `TAB_OF_KIND` is `Record<ProductOrigin, TabName>`, so widening
  `ProductOrigin` makes this file fail to compile until the mapping is added. That coupling
  is intentional and is the reason the origin union is the right place to start.

### 5.6 Unit mismatch on import

**An STL file declares no units.** Both the binary and the ASCII form store bare floating
point coordinates with nothing anywhere saying what they measure. Every consumer simply
assumes; this app assumes millimetres, as slicers do. That assumption is right most of the
time and silently wrong the rest, because a model authored in inches or in metres is a
perfectly valid STL that this app will read at the wrong size, dilate by a clearance that is
now meaningless relative to the part, and carve into a pocket that fits nothing. Nothing
about the file is malformed, so no import check catches it, and nothing in the app looks
broken. It is the one import failure whose only symptom is a wasted print.

Inch authored models in particular are common: much of Thingiverse and most hardware
libraries of American origin are drawn in inches.

#### The field

`CutoutModel.unitScale` (5.1), a multiplier taking file coordinates to millimetres. It is a
plain number rather than an enumeration of unit names so that an unusual authoring unit is
expressible, and it is stored so the choice round trips rather than being asked again on
every load. It is applied in the import stage, before centring and before simplifying (3.2).

#### The check

On import, after parsing and before anything else is shown, look at the largest dimension of
the model's own bounding box in file coordinates. Two thresholds, each stated with the
reasoning that sets it rather than picked to make one file work:

- **Under 3 mm.** The bin interior a model must be placed into is at least 39.6 mm across,
  and no object anyone builds a Gridfinity pocket for is a 3 mm speck. A largest dimension
  under 3 mm is far more likely a model authored in metres, where a 150 mm tool reads as
  0.15, than a genuinely tiny part. Proposed correction: `unitScale` 1000.
- **Over 500 mm.** The largest bin this app can generate is bounded by the build plate, and
  a model over half a metre in its longest direction cannot be carved into any of them. It
  is far more likely a model authored in inches, where a 40 mm part reads as 1.57 and a
  6 inch part reads as 6 but a *scaled up* export reads as hundreds. Proposed correction:
  `unitScale` 25.4.

These two are heuristics and are named as such. They are not measurement pipeline
constants and rule 12 does not bind them the way it binds the trace geometry, because
nothing is derived from them: they only decide **whether to ask the user a question**, and
the user's answer is what changes the geometry. That distinction is the whole reason this is
safe. A heuristic that silently rescaled a model would be exactly the kind of fudge rule 12
forbids.

The check runs on the raw file bounds, so it is a comparison of two numbers and costs
nothing.

#### The proposal

Per rule 2 this is a user fixable condition surfaced as a user worded message, and per rule 7
it is complete technical prose. It is **non blocking**: the model is imported, placed and
carved at `unitScale` 1 while the proposal sits above the model list, so a user who knows the
file is right can simply ignore it.

Largest dimension under 3 mm:

> `The model "NAME" is 0.15 mm at its longest, which is too small to hold anything. STL files
> do not record their units, so it was probably authored in metres. Rescale it as metres, or
> keep it as millimetres if the size is correct.`

Largest dimension over 500 mm:

> `The model "NAME" is 812.80 mm at its longest, which is larger than any bin this app can
> make. STL files do not record their units, so it was probably authored in inches. Rescale
> it as inches, or keep it as millimetres if the size is correct.`

Two buttons, `Rescale as metres` (or `Rescale as inches`) and `Keep as millimetres`.

- **Accepting** sets `unitScale` to 1000 or 25.4, re-runs the import stage for that model
  (the scale changes the solid, so the cached offset for the old scale is not reusable), and
  updates `sizeMm` and the readout. The proposal is dismissed. The readout's size rows then
  show the corrected millimetre figures, which is the confirmation the user needs.
- **Rejecting** dismisses the proposal and leaves `unitScale` at 1. It is not asked again for
  that model, because a user who has answered once should not be asked twice about the same
  file.

Either way, the answer is recorded in the plan, so reopening the bin later does not reopen
the question.

The unit choice is offered as **a choice between whole units only**, never as a free scale
factor field. A free scale is exactly the inspiration tool's mistake in a new place: it lets
a user resize the part the pocket is supposed to hold, which changes the fit silently and is
the thing clearance exists to do properly. Rescaling by 25.4 is not resizing the part, it is
stating what the part always measured. That distinction is why one is offered and the other
is not, and it is the same reason scaling is out of scope in section 1.

#### Interaction with the cached offset

This is the part that is easy to get wrong, and its failure mode is the silent one already
named as a top risk in section 11.

**A unit scale change invalidates that model's cached offset exactly as a clearance change
does.** The cached entry holds a solid that has already been scaled, centred, simplified and
dilated (3.2). Change the scale and every one of those four stages produces something
different: the simplify tolerance is spent against different absolute dimensions, and a 0.4 mm
dilation of a part 25.4 times larger is a proportionally different fit.

So **the cache key is `${modelSourceId}:${unitScale}:${clearanceMm}`**, not
`${modelSourceId}:${clearanceMm}`. All three parts are load bearing, and the consequence of
omitting the unit scale is identical to the consequence of omitting the clearance, which
section 11 already names: the preview renders, the solid is watertight, the download
succeeds, and the printed part is simply the wrong size. Sections 8.6 and 8.10 use this
three part key throughout, `missingCutoutModels` reports against it, and
`releaseCutoutModels` evicts superseded scales the same way it evicts superseded clearances,
so answering the proposal does not leave the pre correction solid in the WASM heap.

The `unitScale` field sits beside `clearanceMm` and `placement` in `CutoutModel` for the same
reason clearance does (5.1): a diff between two model records must show at a glance whether a
change was cheap (placement, a lazy transform) or expensive (scale or clearance, a fresh
Minkowski sum).

## 6. The IndexedDB model store

### 6.1 Sharing the database connection

`web/src/photoStore.ts` today hardcodes `DB_NAME = 'storeforge'`, `DB_VERSION = 1`, and an
`onupgradeneeded` that creates only the `photos` object store. Adding a second store requires
bumping the shared version, and two modules that each own a version number for the same
database will drift apart and corrupt each other's upgrades.

Per rule 10, one module owns the connection:

- **`web/src/idb.ts`** (new): owns `DB_NAME`, `DB_VERSION = 2`, `openDatabase()` with an
  `onupgradeneeded` that creates every missing store (the existing
  `if (!db.objectStoreNames.contains(...))` guard is already idempotent and simply gains a
  second store), and the generic `withStore(storeName, mode, run, failure)` helper. This is
  the existing `photoStore.ts` internals moved verbatim with the store name parameterised.
- **`web/src/photoStore.ts`**: keeps `putPhoto`, `getPhoto`, `deletePhoto`, `listPhotoIds`
  with unchanged signatures and unchanged messages, now delegating to `idb.ts`. No caller
  changes.
- **`web/src/modelStore.ts`** (new): `putModel(id, bytes: Blob)`, `getModel(id)`,
  `deleteModel(id)`, `listModelIds()`, against the `models` store.

Keeping models in their own object store is not merely tidy. The photo sweep lists keys from
the `photos` store only, so a model stored beside a photo would be deleted by the very next
plan persist. A separate store makes that failure structurally impossible.

#### What is stored is the original file, and that is load bearing

`putModel` stores **the uploaded STL bytes exactly as they arrived**, never the simplified
solid, never the dilated cutter, never a re-exported mesh. That is already what this design
does, so no requirement is being added here; what follows is the reasoning, recorded because
storing the processed solid instead would look like an obvious saving and is not.

- **Simplification would otherwise compound.** The import stage simplifies at a tolerance
  derived from the clearance (8.2). If the store held the simplified solid, raising a
  clearance from 0.4 mm to 0.6 mm would simplify an already simplified mesh, and the error
  bounds add: the result would be up to 0.04 mm plus 0.06 mm from the true model rather than
  0.06 mm, and every further adjustment would degrade it again. Because the original is kept,
  every clearance change re-derives from the true model and the tolerance contract holds
  exactly as written, no matter how many times the user tunes the fit. The same argument
  applies to a unit scale correction (5.6), which rescales the true model rather than a
  simplified approximation of it.
- **Re-parsing is free relative to the work it feeds.** Parsing is linear in file size and
  measured in milliseconds (3.2), against a Minkowski sum measured in seconds. There is no
  saving worth having.
- **It keeps rule 9's spirit.** The stored asset is the user's own file, unmodified, so
  nothing the user gave the app is silently degraded on the way to disk.

The stored bytes are therefore also exactly what a re-import must reproduce (6.4) and exactly
what a zipped export would carry (5.3).

Failure messages follow the existing wording: `Storing the cutout model failed (DETAIL).`,
`Reading the stored cutout model failed (DETAIL).`, `Deleting the stored cutout model failed
(DETAIL).`, `Listing the stored cutout models failed (DETAIL).`, and
`Opening the model storage failed (DETAIL).`

### 6.2 Orphan cleanup

`engine/plan/traceSources.ts` currently traverses the plan collecting trace photo ids and
sweeps one store. Adding a second parallel collector would duplicate the plan traversal,
which rule 10 forbids. The module generalises to
**`web/src/engine/plan/storedAssets.ts`**:

```ts
/** The subset of one blob store the sweep needs, injectable for tests. */
export interface AssetStoreLike {
  listIds(): Promise<string[]>;
  deleteAsset(id: string): Promise<void>;
}

/** Every stored blob id a plan row still references, by asset kind. */
export interface ReferencedAssetIds {
  tracePhotos: Set<string>;
  cutoutModels: Set<string>;
}

/**
 * Collects every stored asset id still referenced by a queue entry or a batch
 * item, in one traversal of the plan. An id not in the matching set belongs to
 * no plan row and can be deleted.
 */
export function referencedAssetIds(
  entries: QueueEntry[],
  batches: PrintBatch[],
): ReferencedAssetIds;

/** Deletes every stored asset no plan row references anymore, per store. */
export function sweepOrphanAssets(
  stores: { photos: AssetStoreLike; models: AssetStoreLike },
  entries: QueueEntry[],
  batches: PrintBatch[],
): Promise<{ tracePhotos: string[]; cutoutModels: string[] }>;
```

One traversal, one sweep, two stores. `binQueue.persist()` keeps its single fire and forget
call site and `main.ts` keeps its startup call; both just call the generalised action.

A cutout model is referenced when it appears in `bin.models[].modelSourceId` for a bin with
`origin === 'cutout'`, in either an entry or a batch item. Note that two bins can legitimately
reference the same `modelSourceId` (duplicating a queue row deep clones the product, ids
included), so the sweep must be by set membership and never by refcount.

### 6.3 Write ordering

The same constraint the trace flow documents applies verbatim, and for the same reason:
`binQueue.persist()` sweeps stored assets, so **the model blob must be written to IndexedDB
before the queue mutation that references it.** Writing in the other order deletes the model
microseconds after storing it. This is the sharpest trap in the whole feature.

A model upload therefore writes the blob immediately, before the bin is ever queued, and the
model store gains a temporary reference: during editing the models are not yet referenced by
any plan row. Two options:

- **Recommended**: sweep only ids not referenced **and** not held by the live cutout store.
  The sweep gains an optional `protectedIds: Set<string>` parameter, which the Pinia action
  fills from the cutout tab's in progress model list. Simple, keeps the invariant local to
  the sweep, and matches the fact that the tab genuinely still holds those models.
- Alternative: defer the blob write to save time, as the trace flow does. Rejected, because
  the carve preview needs the bytes long before save, so they must exist during editing.

### 6.4 A plan opened on a device that does not have the models

A JSON plan export carries model metadata and placements but not the bytes (5.3). Open that
plan on another machine, or on the same machine after clearing site data, and every
`modelSourceId` resolves to nothing.

Following the trace photo precedent in `photoStore.ts`, which deliberately treats a missing
photo as a normal condition rather than an error, **this is a normal condition, not a
failure.** The bin is intact: its footprint, height, label, placements, rotations, unit
scales and clearances are all in the plan. The only thing missing is the triangles. So the
app must neither discard the bin nor pretend it is fine, and above all must never quietly
generate a bin with an empty `models` list, which would export as a solid block of plastic
and waste a real print.

An error message alone is not enough. Everything needed to make the bin whole again is
present except one file the user almost certainly still has, so the app should ask for it.

**The recovery path, end to end:**

1. **The queue row states what is missing, by filename.** The row descriptor for a cutout bin
   with unresolved models reads as needing them and names them, so the user can see the
   problem in the queue without opening anything. The bin stays in the queue, keeps its
   position and keeps its title.
2. **Preview and download refuse, naming the file.** The existing message covers this:
   `The model "NAME" is not stored on this device, so this bin cannot be generated. Upload
   the model again, or remove it from the bin.` It blocks generation, which is the point.
3. **Opening the bin for editing offers to re-import.** The model list shows the missing
   model in a distinct state with a `Locate file` button beside it, rather than only an
   error. Everything else in the tab stays fully editable: the user can resize the bin, edit
   the label, move the models that did resolve, and delete the missing one if they no longer
   have it.
4. **Choosing a file re-links it to the existing model record.** The file is parsed and
   stored under the **same `modelSourceId`**, so nothing else in the plan has to change and
   nothing has to be re-placed. `placement`, `rotation`, `unitScale` and `clearanceMm` are
   all preserved exactly as the plan carried them. The import stage then runs as it does for
   a fresh upload, and the bin carves.
5. **Several missing models are recovered one at a time**, each by its own button. There is
   no bulk folder picker, because matching files to records by name across a folder is a
   guess this design does not need to make.

#### If the user picks a different file from the original

The app cannot verify that the chosen file is the original one. STL carries no name, no
checksum and no identity of any kind, and the app deliberately does not store a hash of the
original bytes: a hash could only ever say no, never yes, and refusing a file that is
genuinely the right model re-exported from CAD would be worse than the problem it solves.

So a different file is accepted, and the honest thing is to make the substitution visible
rather than to guard against it:

- **The stored `name` is updated to the newly chosen file's name.** The plan should describe
  what the bin actually contains now, not what it once contained. A stale name would make
  every later message name a file that is no longer in the bin.
- **`triangleCount` and `sizeMm` are recomputed** from the new file, exactly as on a fresh
  import, and the readout shows them. If the user picked the wrong file, the size rows are
  where they will see it.
- **The placement is preserved regardless**, because it is the user's positioning work and
  discarding it would be a worse guess than keeping it. A different model at the same
  placement may well sit wrong, but it sits wrong *visibly*, in the ghost preview and in the
  bounds warnings from 3.5, which is the state the rest of this design is built to handle.
- **The unit mismatch check from 5.6 runs again on the new file**, since a re-export may have
  changed its units. Its own proposal appears if it fires.
- **If the chosen file's name differs from the stored one, the app says so once**, as a non
  blocking note rather than a question, because a renamed but correct file is at least as
  likely as a mistake: `The file "NEW" was linked to the model previously stored as "OLD".
  Check the size readout if you expected a different model.`

The one case that is treated as an error is a file that will not import at all: it produces
the ordinary import rejection from 9.1 and the model stays missing, so the user can try
again with another file.

## 7. UI

### 7.1 The tab

`AddBinCard.vue` gains a fourth tab. `TabName` widens to
`'manual' | 'screw' | 'trace' | 'cutout'`, `TAB_OF_KIND` gains `cutout: 'cutout'`, and a
`<v-tab value="cutout">Cutout bin</v-tab>` plus a matching `<v-window-item>` mounting
`<CutoutTab />` with no props and no emits, exactly like the other three. All state lives in
a new `stores/cutout.ts` Pinia store, because the tabs stay mounted and per tab state must
survive tab switches.

### 7.2 Layout

```
+--------------------------------------------------------------------------------+
| Manual bin | Screw entry | Tool bin | Cutout bin                                |
+--------------------------------------------------------------------------------+
|                                                                                 |
|  +----------------------------------------+  +-------------------------------+  |
|  |                                        |  | Models                        |  |
|  |            3D viewport                 |  |  [ Add model (STL) ]          |  |
|  |                                        |  |                               |  |
|  |         .-''-.  <- rotate arcs         |  | +---------------------------+ |  |
|  |        /  ^   \                        |  | | * socket-19.stl      [x]  | |  |
|  |       |   |    |                       |  | |   14842 tri   0.4 mm      | |  |
|  |       |  [#]---+--> translate arrows   |  | +---------------------------+ |  |
|  |       |   ghost model, translucent     |  | | o wrench-10.stl      [x]  | |  |
|  |        \       /                       |  | |   9210 tri    0.4 mm      | |  |
|  |         '-..-'                         |  | +---------------------------+ |  |
|  |                                        |  |                               |  |
|  |  [Snap: on]        (stale) Recarving.. |  | Selected model                |  |
|  +----------------------------------------+  |  Position X      12.40 mm     |  |
|                                              |  Position Y      -3.10 mm     |  |
|  Size   [3] x [2] cells,  [6] units tall     |  Position Z      21.75 mm     |  |
|  [ Fit bin to models ]   [x] Magnet holes    |  Rotation X       0.00 deg    |  |
|                                              |  Rotation Y      90.00 deg    |  |
|  Label  [ text ] [ text2 ] [ icon ]          |  Rotation Z      15.00 deg    |  |
|                                              |  Footprint    62.4 x 31.8 mm  |  |
|  ! The model "wrench-10.stl" reaches         |  Rests at         4.90 mm     |  |
|    outside the bin interior, so its          |  Clearance   [ 0.4 ] mm       |  |
|    pocket breaks through the bin.            |                               |  |
|                                              +-------------------------------+  |
|                          [ Cancel ]  [ Add to queue ]                           |
+--------------------------------------------------------------------------------+
```

### 7.3 Upload

A file input accepting `.stl`. On selection, per file: read the `ArrayBuffer`, `parseStl` it
on the main thread (cheap, and it produces the user worded rejection immediately without a
worker round trip), write the blob to the model store, hand the buffer to the worker for
import stage caching, and append a `CutoutModel` with a placement centred in the bin at a
resting Z that puts the model's bottom on the interior floor. Multiple files at once are
accepted and imported in sequence.

While the import stage runs, the row shows an indeterminate progress bar and the model is
not yet in the carve. The import is where the Minkowski cost is paid, so this is the one
place the user waits, and it is honest to show it there rather than hiding it in the
preview. The bar is indeterminate rather than a percentage for the structural reason worked
through in 8.5, which also records that the owner asked for a percentage and accepted this
instead.

The unit mismatch check from 5.6 runs on the parsed bounds, before the import stage is
handed to the worker. When it fires, its proposal appears above the model list with its two
buttons. It never blocks: the model imports and carves at `unitScale` 1 while the proposal
stands, so a user whose file really is that size can ignore it and carry on.

A model whose bytes are missing from this device (6.4) appears in the list in its own state,
naming the stored filename, with a `Locate file` button that re-imports and re-links it to
the same `modelSourceId`. Every other model and every other control in the tab stays fully
editable while one model is missing.

### 7.4 Selection

**Recommendation: both, kept in sync through a single `selectedModelId` in the store.**

Clicking a ghost mesh in the viewport raycasts and sets it; clicking a row in the model list
sets it; the gizmo attaches to whichever is selected and the list row highlights. This is not
duplication: two input paths write one piece of state.

Both are needed. The viewport click is the natural gesture, but a fully buried model is
invisible and unclickable, and a model dragged outside the camera's fixed framing cannot be
reached at all. The list is the reliable path that always works.

The viewport selection raycast fires on `pointerup`, and only when:

- neither gizmo instance reports a hovered handle (`controls.axis !== null` is exactly the
  hovered state; it is assigned in `pointerHover` from the picker intersection), and
- neither instance reports `dragging`, and
- the pointer moved less than a few pixels since `pointerdown`, so an orbit drag that happens
  to end over a model does not select it.

A `pointerup` on empty space clears the selection and detaches both gizmos.

### 7.5 The gizmo

Two `TransformControls` instances attached to the same target `Object3D`, one left in
`'translate'` mode and one in `'rotate'` mode, both helpers added to the scene. All handles
are visible and grabbable at once: three axis arrows, three plane quads, three rotation arcs.
There is no mode toggle in the UI. Scale is excluded.

Verified against `three@0.178.0`'s `examples/jsm/controls/TransformControls.js`:

- `TransformControls extends Controls`, so it is **not** an `Object3D`. The scene receives
  `controls.getHelper()`, which returns the internal `_root`.
- `updateMatrixWorld` sets handle visibility purely from `this.mode`
  (`this.gizmo['translate'].visible = this.mode === 'translate'` and the rotate equivalent),
  so one instance can never show both handle sets. Two instances is the only way to the
  combined look.
- **Critically**, `enabled` does not affect visibility. It is consulted only in the pointer
  handlers and in one highlight branch. Disabling an instance leaves its handles drawn and
  merely stops it responding, which is exactly the behaviour arbitration needs.
- `axis`, `mode`, `enabled`, `dragging`, `size`, `translationSnap` and `rotationSnap` are all
  defined through an internal `defineProperty` helper whose setter dispatches
  `` `${propName}-changed` `` **synchronously**. So `dragging-changed` exists and fires
  inline, which is what makes the arbitration below deterministic.
- Hit testing uses `this._gizmo.picker[this.mode]` only, so the two instances raycast
  disjoint picker sets and never confuse each other's handles.

#### Drag arbitration

Both instances add their own `pointerdown`, `pointermove` and `pointerup` listeners to the
same `domElement`, so both would otherwise start a drag from one press.

Wiring, on each instance:

```
on 'dragging-changed' (value === true):   orbit.enabled = false;  other.enabled = false;
on 'dragging-changed' (value === false):  orbit.enabled = true;   other.enabled = true;
```

Exact event order for one press, and why it is safe:

1. The browser dispatches `pointerdown` to listeners in registration order. The instance
   constructed first receives it first.
2. That instance's `onPointerDown` returns immediately if `!this.enabled`. Otherwise it
   captures the pointer, calls `pointerHover` (so hover state is computed at press time,
   which is what makes touch work without a preceding hover), then `pointerDown`.
3. `pointerDown` returns without effect if `this.axis === null`, that is, if no handle of
   this instance is under the pointer. In that case the second instance proceeds normally.
4. If a handle is under the pointer, `pointerDown` sets `this.dragging = true`, and the
   `defineProperty` setter dispatches `dragging-changed` **synchronously**, which disables
   the other instance before the browser delivers `pointerdown` to it.
5. The second instance's `onPointerDown` then hits `if (!this.enabled) return` as its first
   statement and does nothing.

So the arbitration is deterministic, needs no timers or flags of our own, and
**the instance constructed first wins any tie.**

Construct the **translate** instance first. Translation is by far the more common operation,
and the arrows and plane quads are the smaller, more central targets, so resolving a rare
overlap in their favour matches what the user most likely meant.

#### Handle overlap and hit priority

Measured from the gizmo geometry in the installed source rather than estimated:

- Translate: arrow cones are positioned at ±0.5 on each axis, and the plane quads are
  0.15 x 0.15 boxes centred at 0.15, so the translate handles occupy out to about 0.55 in
  gizmo units.
- Rotate: the X, Y and Z arcs are `CircleGeometry(0.5, 0.5)`, that is a torus of radius
  **0.5**, and the outer `E` ring is radius 0.75.

At equal `size` the rotation arcs sit at radius 0.5, which is exactly where the arrow tips
are. The worst case overlap is not hypothetical: it is a direct collision.

Recommendation: leave the translate instance at the default `size` of 1 and call
`setSize(1.6)` on the rotate instance. That puts the arcs at radius 0.8 against arrow tips at
0.5, a clear separating band, with the `E` ring out at 1.2 forming the wide bowl the
reference layout shows.

Honesty note: 1.6 is derived from the handle radii quoted above, not measured on screen. I
could not run a browser in this environment, so **the value that makes every handle
comfortably reachable is an owner checkpoint**, to be confirmed visually and adjusted within
roughly 1.4 to 1.8 if the arcs feel too far out or still too close. What is verified is the
underlying geometry and the fact that equal sizes collide.

#### Lost pointerup

A stuck disabled `OrbitControls` is a very visible bug, so this is handled explicitly.

`onPointerDown` calls `this.domElement.setPointerCapture(event.pointerId)` unless a pointer
lock is active, so a pointer that leaves the canvas mid drag still delivers `pointerup` to
the canvas. That covers the common case, verified in the source.

`pointercancel` is **not** handled by `TransformControls` (there is no such listener in the
file). A touch interruption, a browser gesture takeover or a lost capture can therefore end a
drag with no `pointerup`, leaving `dragging === true` and orbit disabled forever. Guard, on
the canvas:

```
on 'pointercancel' and on 'lostpointercapture':
  for each instance: if (instance.dragging) instance.dragging = false;
```

Assigning `dragging = false` goes through the same `defineProperty` setter and dispatches
`dragging-changed` with value `false`, which runs the normal re enable handler. So the
recovery path is the ordinary release path and cannot drift from it.

#### Teardown

`BinViewport` disposes its scene in `onBeforeUnmount`; the editor viewport must dispose two
instances, their listeners and their helper objects:

```
for each instance:
  instance.removeEventListener('dragging-changed', handler)
  instance.removeEventListener('objectChange', handler)
  instance.detach()
  scene.remove(instance.getHelper())
  instance.dispose()          // calls disconnect(), removing its domElement listeners,
                              // and _root.dispose()
canvas.removeEventListener('pointerdown' | 'pointerup' | 'pointercancel' | 'lostpointercapture', ...)
```

`dispose()` disposes `_root` but does not remove it from the scene, so the `scene.remove`
must be explicit and must come before `dispose()`.

#### The alternative, recorded but not chosen

A purpose built single gizmo, drawing arrows, quads and arcs into one `Object3D` with one
picker set and one pointer handler, would avoid the arbitration problem entirely: one set of
listeners, one raycast, one drag, no cross instance disabling, and no possibility of two
gizmos dragging at once. It was considered and is not being pursued because it means
reimplementing hit testing, screen space constant sizing, drag plane construction, snapping
and the highlight states that `TransformControls` already provides, which is substantially
more code to write and to keep correct for no capability the two instance approach lacks.

#### No blocker found

I looked for a reason two simultaneous instances would be unworkable rather than merely
fiddly, and did not find one. The three things that would have made it unworkable are all
disproved by the installed source: `enabled` does not hide handles, hit testing is scoped to
each instance's own picker set, and `dragging-changed` fires synchronously so arbitration
happens before the second listener runs. The remaining costs are the overlap tuning and the
`pointercancel` guard, both specified above.

### 7.6 Snapping

Translation snap **1 mm**, rotation snap **15 degrees**, both on by default, toggled by one
`Snap` switch in the viewport toolbar, applied with `setTranslationSnap` and `setRotationSnap`
on the matching instance (passing `null` disables).

Is this the same concern as `snapEnabled` in `stores/binDesigner.ts`? Partly, and the honest
answer is to share one constant and not the flag.

- **Do not share the flag.** `binDesigner.snapEnabled` is the manual bin designer's divider
  canvas setting. Sharing one boolean across two unrelated tabs would mean toggling snap
  while drawing a divider silently changes how a cutout model drags, which is a surprise, not
  a unification. They are two independent editor settings that happen to have the same name.
- **Do not share the translation step.** `SNAP_STEP_MM` is `PITCH / 4`, that is 10.5 mm,
  chosen so every grid cell boundary lands on the lattice. For positioning a physical object
  inside a bin, 10.5 mm is far too coarse to ever hit the right spot. The quantities genuinely
  differ.
- **Do share the angle step.** `SNAP_ANGLE_STEP_DEG = 15` in `engine/gridfinity/dividerModel.ts`
  is documented as covering the axis aligned and diagonal cases (0, 45, 90) and the common
  thirds (30, 60) in one step size. That reasoning applies unchanged to rotating a model. The
  cutout gizmo imports that constant rather than restating 15.

The 1 mm translation step is a user interface increment rather than a geometric constant, so
rule 12 does not bind it the way it binds the measurement pipeline. It is justified as the
coarsest increment still fine enough to place a pocket deliberately, and it is the unit every
other dimension in this UI is stated in. It is flagged as an owner checkpoint.

### 7.7 Numeric readout

Per rule 8, the selected model's state is shown as labeled rows of raw values, not prose:
position X, Y and Z in mm, rotation X, Y and Z in degrees, the model's own size as X by Y by
Z in mm, the rotated footprint as width by depth in mm, the resting height above the interior
floor, and the triangle count. The unit scale gets its own row whenever it is not 1, reading
the multiplier, so a rescaled model states plainly that it was rescaled rather than leaving
the user to infer it from the size. The size row is the row a user checks after accepting a
unit proposal (5.6) or after re-importing a missing model (6.4), which is why it is listed
separately from the footprint.

**Recommendation: the position and rotation rows are read only.** Reasons: the gizmo is the
input method and the owner's requirement was free positioning, so the readout exists to let
the user see exactly where a free drag landed, not to become a second input path that would
then need its own validation, its own snap interaction and its own undo semantics. Clearance
is a separate matter and **is** an editable numeric field, because it is a fit parameter the
user reasons about numerically and there is no gestural way to express it.

The alternative, editable position and rotation fields, is a reasonable later addition and
nothing in this design forecloses it: the store action that the gizmo drives would simply
gain a second caller. It is left out of the first version to keep one input path.

### 7.8 Bounds feedback

Because placement is free, a model can be dragged partly or wholly outside the interior, and
per rule 2 that is a user worded message rather than a thrown error, and it never blocks the
drag.

- **In the viewport, live**: the ghost mesh's material turns to a warning tint the moment its
  `Box3` leaves the interior box. This is computed on the main thread every frame from the
  exact transformed geometry, so it tracks the drag with no lag and no CSG.
- **In the readout, live**: the footprint row is joined by a `Fits` row reading `yes` or `no`.
- **In the panel, after the carve**: the authoritative warnings from 3.5, which include the
  clearance dilation the ghost does not show, appear as a warning alert naming each model.
- Nothing is disabled, and `Add to queue` stays enabled. The bin is generatable and
  downloadable in this state.

### 7.9 The viewport component

`BinViewport.vue` is display only today: props `mesh` and `label`, `OrbitControls`, a fixed
camera, and a full teardown in `onBeforeUnmount`. It has three call sites.

**Recommendation: extract the shared scene scaffolding into a composable
`web/src/composables/useThreeScene.ts`, refactor `BinViewport.vue` onto it, and build a new
`CutoutViewport.vue` on it as a sibling.**

The scaffolding that must not be duplicated is substantial: renderer and scene creation,
the hemisphere and directional lights, the 420 mm grid helper, the fixed camera and
`OrbitControls`, the `ResizeObserver` driven resize, the `requestAnimationFrame` loop, the
`rotation.x = -Math.PI / 2` that converts Z up millimetres to three's Y up world, the
`BufferGeometry` construction with `computeVertexNormals`, and the disposal path.

Cost at the three existing `BinViewport` call sites: **none**. Its props, emits and rendered
output are unchanged; only its internals move behind the composable.

Two things this forces, both of which are improvements:

- `BinViewport.vue` currently holds its two `MeshStandardMaterial`s at **module scope** and
  calls `.dispose()` on them in `onBeforeUnmount`. Today only one viewport is ever alive so
  it does not bite, but a cutout viewport that can be alive at the same time as the trace
  one turns it into a real bug: the second mount reuses disposed materials. The materials
  move to instance scope as part of this work.
- There are no component tests in `web/tests/`, so this refactor's correctness cannot be
  shown by the suite. Its verification is an explicit owner browser checkpoint.

Alternative, not chosen: extend `BinViewport.vue` with optional editing props. It is less
work and equally free at the existing call sites, but it grows a component shared by three
unrelated flows to roughly triple its size with gizmo arbitration, raycast selection and
ghost management that two of those three flows will never use. The composable keeps the
sharing at the layer that is genuinely shared.

### 7.10 The clearance control

One control per model row, since clearance is per model (5.2). It is the only control in this
tab that triggers genuinely slow work, so it is specified separately from the gizmo.

**Recommendation: a number field with stepper arrows, step 0.05 mm, committed on blur or on
Enter. Not a slider.**

Three reasons, in order of weight:

1. **Exact entry is the point.** The realistic use is a user whose printed pocket was too
   tight going from 0.4 to 0.5 precisely, then to 0.6 if that still binds. A slider makes an
   exact value awkward to hit and impossible to read back confidently. This is the opposite
   of the gizmo, where the whole interaction is judging position by eye and no exact number is
   wanted (7.7).
2. **A slider invites dragging, and dragging this value is expensive.** Every intermediate
   value a slider passes through is a distinct cache key and a fresh Minkowski sum. A field
   that commits once, on blur or Enter, produces exactly one recompute per decision the user
   actually made.
3. It matches how every other numeric dimension in this app is entered.

Committing on blur or Enter rather than per keystroke is deliberate for the same reason:
typing `0.45` would otherwise fire recomputes for `0`, `0.4` and `0.45`. A debounce alone
would not fix it, since a slow typist still commits intermediate values. Explicit commit is
both cheaper and more predictable.

Field bounds: minimum 0, maximum `maxClearanceMm(gridX, gridY)` from 5.4, so the field cannot
express a value the validator would reject. Entering 0 is legal and meaningful: it asks for an
exact subtraction, and it takes the fast path that skips both the simplify and the Minkowski
stages entirely (3.2).

The step of 0.05 mm is a user interface increment, not a derived geometric constant. It is
justified as roughly an eighth of a nozzle width, fine enough to tune a fit that is close but
not right, and coarse enough that stepping to the next sensible value takes one or two clicks.
**[Owner checkpoint]** alongside the other interface increments.

## 8. Performance

### 8.1 Where the time goes

Minkowski sum dominates everything else by orders of magnitude, at roughly 1.2 ms per input
triangle. A 20000 triangle model is about 24 seconds unsimplified. This is why the pipeline
is split so that the offset runs **once per model per clearance**, cached in the worker, and
never again while the user drags. Section 3.1 has the reasoning; the rotation invariance of a
spherical offset is what makes the caching sound rather than merely convenient.

Everything in the per carve edit stage is a boolean on already simplified geometry, which is
sub second for realistic models.

### 8.2 Simplify tolerance

The tolerance must be principled, so it is derived from the quantity it is allowed to spend:
the clearance.

`Manifold.simplify(tolerance)` documents tolerance as "the maximum distance between the
original and simplified meshes", so it is a geometric error bound in millimetres, directly
comparable to the clearance.

```
simplifyToleranceMm = clearanceMm / 10
```

The clearance is the fit budget. Allowing the simplification to consume at most one tenth of
it bounds the worst case fit degradation at ten percent of the intended gap, leaving the
guarantee substantially intact. At the 0.4 mm default this is 0.04 mm, which is below any FDM
printer's positional resolution and well below typical extrusion quantisation, so the
simplification is invisible in the printed part.

When `clearanceMm` is 0 there is no budget to spend, so no simplification happens and no
Minkowski runs at all. The user asked for an exact subtraction and gets one.

**The tolerance is therefore per model, because the clearance is.** Two models in one bin
carrying different clearances carry different tolerances, and one may be simplified while
another, at zero clearance, is not simplified at all. The derivation still holds, and it is
worth being explicit about why, because "a bin wide error budget" would be the natural thing
to assume and it is not what this is:

- **The guarantee is per model.** Each real object must fit its own pocket. There is no bin
  wide fit property, so there is nothing for a bin wide tolerance to protect. Model A's
  simplification cannot affect whether object B fits pocket B.
- **The union preserves the bound.** The cutters are unioned before subtraction, and the
  union of solids each within `t_i` of its true model is within `max(t_i)` of the union of the
  true models. Mixing tolerances degrades nothing beyond the worst individual bound, and each
  individual bound is already one tenth of that model's own clearance.
- **Nothing downstream assumed a single value.** `simplifyToleranceMm(clearanceMm)` is a pure
  function of one model's clearance and is called once per model in the import stage. The
  shared carve stage (section 2) receives finished cutter solids and never sees a tolerance.
  The subtraction, the slot restoration and the status check are all tolerance blind.

The sphere resolution is the one place this could have leaked, and it does not: as 8.3 shows,
the derived segment count comes out independent of the clearance value, so every model's
offset sphere is the same regardless of its clearance. That is a consequence of tying the
sphere's faceting error to the same proportional budget, not a coincidence.

### 8.3 Offset sphere resolution

`Manifold.sphere(radius, circularSegments)` approximates the sphere, and its faceting error is
`radius * (1 - cos(pi / n))` for `n` segments, the sagitta of one segment.

**This codebase already derives a facet count from exactly that error model, and this design
uses it rather than deriving a second one.** `circleSegments` in
`web/src/engine/trace/edit.ts` computes, for a radius and a chordal tolerance:

```
step = 2 * acos(1 - toleranceMm / radiusMm)
n    = ceil(2 * pi / step), floored at MIN_CIRCLE_SEGMENTS (12)
n    = ceil(n / 4) * 4
```

Substituting `step = 2 * pi / n` into the first line gives
`radiusMm * (1 - cos(pi / n)) = toleranceMm`, which is the same sagitta bound stated above,
solved for `n` instead of checked. **The two derivations are the same formula.** The only
thing that genuinely differs is the tolerance policy each caller wants: the trace flow spends
a fixed `CHORDAL_TOLERANCE_MM` of 0.1 mm, tied to its rectified pixel size, while the cutout
flow spends a proportional budget, one tenth of the model's own clearance (8.2). That is an
argument, not a second algorithm.

Rule 10 therefore settles it: **one home for the derivation, the tolerance passed in.**

- The derivation moves to a new module, **`web/src/engine/geometry/circleSegments.ts`**,
  exporting `circleSegments(radiusMm, toleranceMm): number` together with the multiple of
  four rounding and the `MIN_CIRCLE_SEGMENTS` floor. It goes there rather than staying in
  `trace/edit.ts` because a cutout module importing from `trace/` would assert a dependency
  that does not exist: circle faceting belongs to neither flow.
- `trace/edit.ts` keeps `CHORDAL_TOLERANCE_MM`, which is its own policy and is documented
  against the trace pipeline's accuracy, and calls the shared function with it. Its behaviour
  is unchanged, which its existing tests must show.
- `engine/cutout/cutoutBin.ts` calls the same function as
  `circleSegments(clearanceMm, simplifyToleranceMm(clearanceMm))`.

Two consequences of adopting the existing derivation, both of which are improvements over the
formula this document originally carried:

**The multiple of four rounding is load bearing here, and the fresh derivation would have
lost it.** It exists so the four axis extremes land on vertices and a primitive's bounds are
exactly its requested dimensions. For the offset sphere that is precisely what makes the
pocket measure its nominal size along each axis, which is what the section 10.2 test
`the carved pocket measures 10 mm plus twice the clearance on each axis` asserts. The bare
inequality yields `n >= 7`, and a 7 segment sphere has no vertex at any axis extreme, so that
test would have failed against a correct implementation and invited a fudge to make it pass.
That is the rule 10 argument arriving as a concrete defect avoided, not as a principle.

**The shared floor of 12 segments is more than this pipeline's own budget demands, and is
accepted.** The budget alone gives `n >= 7`; the floor raises it to 12, which the rounding
leaves at 12. So the offset sphere is finer than strictly required. The cost is real, since
Minkowski cost scales with the complexity of both operands and 12 segments is roughly twice
the triangles of 8, but the sphere is tiny either way against a model of thousands of
triangles, and forking the derivation to save it would trade a genuine duplication for a
marginal saving. It is recorded here so a later reader knows the floor was noticed and
accepted rather than overlooked.

Both the segment count and the resulting bound are still independent of the clearance value,
as 8.2 relies on: with `toleranceMm = radiusMm / 10` the ratio `toleranceMm / radiusMm` is
0.1 whatever the clearance, so `step` and therefore `n` are constant at 12.

**The honest consequence, which must be commented at the call site.** A faceted sphere is
inscribed in the true sphere, so the dilation is an inscribed approximation and the realized
clearance is slightly **under** nominal between the facet vertices. It is exact along the
three axes, because of the multiple of four rounding. The worst case shortfall is
`clearanceMm * (1 - cos(pi / 12))`, that is `clearanceMm * 0.0341`: 0.0136 mm at the 0.4 mm
default, and 0.0341 mm even at a generous 1 mm clearance. Both are below the simplify
tolerance already being spent at those clearances and far below any FDM printer's positional
resolution, so the shortfall is invisible in the printed part. This is a bounded consequence
derived from the segment count, not a fudge, and the bound is stated so a reviewer can check
it rather than take it on trust.

`manifold-3d` also exposes `getCircularSegments` and `setMinCircularAngle` as the library's
own primitives for this. They are not used, because they express a global quality setting
shared with unrelated geometry, whereas both callers here want their own error budget, and
because using them would put the facet count back in two places.

### 8.4 Keeping the preview responsive

**Tier 1, during a drag: no CSG at all.** The viewport shows the last carved bin solid plus
one translucent ghost mesh per model, transformed live by the gizmo at 60 fps. No worker
call, no manifold operation, nothing but a matrix update. The observed reference
implementation at gridfinitygenerator.com does exactly this and never carves interactively at
all, so the ghost tier is the state of the art rather than a compromise.

**Tier 2, on drag end, debounced: the real carve.** On `dragging-changed(false)`, and after
the existing 300 ms debounce, the placement goes to the worker and the actual carved solid
comes back. So unlike the reference implementation, an idle user sees the true pocket, not
just an overlap.

What the viewport shows in each state, and how the user can tell:

| State | Bin solid | Ghosts | Indicator |
| --- | --- | --- | --- |
| Idle, carve current | carved | shown, translucent | none |
| Dragging | last carved solid, **stale** | shown, following the gizmo | `Stale` chip, plus the ghosts visibly not matching the pockets |
| Carve running | last carved solid, **stale** | shown | `Recarving...` with an indeterminate progress bar |
| Carve failed | last carved solid, **stale** | shown | error alert with the message |

Staleness is never implicit. The chip is present from the first gizmo movement until a fresh
carve lands, so a displayed pocket that does not match a ghost is always accompanied by an
explicit label saying so.

### 8.5 Cancelling stale work, and its real limits

`useBinPreview` guards against a stale **result** with a `generationCounter` ticket, but it
does not cancel stale **work**. With a carve measured in seconds, several superseded carves
can queue up behind the current one.

`manifold-3d@3.5.1` exposes an `ExecutionContext` with `cancel()`, `cancelled()` and
`progress()`, attached through `Manifold.withContext(ctx)`, and its documentation explicitly
lists `minkowskiSum` and `minkowskiDifference` among the eager operations that observe it.

That is genuinely useful but it is **not** a general solution, and it would be wrong to
present it as one:

- The context lives in the worker's WASM heap. `cancel()` must be called from inside the
  worker, and the worker's JavaScript thread is **blocked** inside the synchronous eager
  operation while it runs. A Comlink message asking it to cancel is not delivered until the
  operation has already returned.
- The same argument defeats `progress()`. It is documented as safe to read from any thread,
  but there is no thread available to read it from: the only place holding the context is
  the one that is blocked. **So there is no percentage progress bar**, and the UI uses an
  indeterminate indicator. Polling it would need a second worker sharing the WASM heap, which
  is out of scope.

#### The progress indicator: what was asked for, and what was accepted

This is recorded in full because the shipped behaviour is not what was originally requested,
and a later reader should find the trade rather than assume nobody thought about it.

**The owner asked for a real percentage progress bar** for the clearance step, on the sound
reasoning that this is the first genuinely long geometry operation in the app and an
indeterminate spinner tells a user nothing about whether to wait or to give up.

**It is not achievable with the current single worker structure**, for the reason above and
not for want of a library feature. `manifold-3d@3.5.1` does expose `ExecutionContext.progress()`
and does document it as readable from another thread, so the number genuinely exists and is
genuinely updated while `minkowskiSum` runs. The obstacle is structural: the context object
lives in the worker's WASM heap, and that worker's only JavaScript thread is blocked inside
the synchronous eager operation for the entire time the number is worth reading. A Comlink
message asking it to report progress is not delivered until the operation it would describe
has already finished. No amount of polling from the main thread helps, because the reply
cannot be sent.

**A second worker would achieve it**, and it is worth being precise about which second
worker, because this design already proposes one for a different purpose. The isolation
instance in 8.7 is a *separate* manifold instance with its own heap, and it cannot see the
first instance's context, so it does not deliver progress. What delivers progress is a worker
that **shares the same WASM memory** as the one running the carve, so it can read the context
while the other thread is blocked in it. That means a shared memory build and the cross
origin isolation headers it requires, on a site deployed to GitHub Pages. It is a real option
and a substantial one, not a small refinement.

**The owner has accepted an indeterminate indicator for now**, with the option to revisit if
the wait proves annoying in practice once real timings exist (8.8). So the UI shows an
indeterminate progress bar on the affected model row, exactly as specified in 7.10 and 8.6,
and it is honest about being indeterminate rather than showing a fake percentage that
advances on a timer. A fabricated progress bar would be worse than none: it would claim
knowledge the app does not have, which is the same class of dishonesty rule 12 rejects in
geometry.

Two things partly cover the gap without a second worker, and both are already specified: the
indeterminate bar sits on the specific model row that is recomputing rather than over the
whole tab, so the user can see exactly what is busy, and everything else in the tab stays
live (8.6), so a wait is never a freeze.

What cancellation can do is real but bounded. If the carve method is `async` and yields to
the worker's message queue **between** models, a queued cancellation is delivered at that
point and the next eager operation observes it. So a multi model carve is cancellable at
model granularity. A single model carve is not cancellable once it has started.

Given that, the responsiveness strategy in priority order is:

1. The ghost tier, which removes CSG from the interactive path entirely. This is what makes
   the flow usable and it does not depend on cancellation at all.
2. The import time offset cache, which removes the Minkowski cost from the per carve path.
3. The 300 ms debounce plus the drag end trigger, which collapses a gesture into one carve.
4. Model granularity cancellation of superseded preview carves, as a refinement.

### 8.6 Changing a clearance: the one expensive control

Dragging is cheap because the offset is cached. Changing a clearance is expensive because it
invalidates that cache entry. This is the only control in the tab with that property, and it
needs its own treatment.

#### The cache

Lives in the geometry worker, at module scope, as `Map<string, Manifold>` keyed by:

```
`${modelSourceId}:${unitScale}:${clearanceMm}`
```

Model identity, unit scale and clearance together. All three parts are load bearing, and
each is in the key for the same reason: it changes the cached solid. The unit scale is there
because a scale correction (5.6) rescales the model before it is simplified and dilated, so
it invalidates the entry exactly as a clearance change does. Omitting either one has the same
silent failure mode, described at the end of section 11.

It holds the finished import stage product: scaled to millimetres, centred,
simplified, and offset, ready to be transformed and subtracted. It lives in the worker and
not on the main thread because a `Manifold` is a WASM heap object that cannot cross a thread
boundary, and because the worker is the only place that can use it.

A miss is not an error. `missingCutoutModels(ids)` reports which keys the worker lacks and the
client sends the bytes for those, which is the same path a fresh upload takes. So a clearance
change and a first upload are the same operation as far as the worker is concerned, and there
is one code path rather than two.

Eviction is explicit, through `releaseCutoutModels(keepIds)`, called when the tab resets or a
model is removed. Superseded clearance keys for a model still in the bin are released the same
way, so tuning a clearance through five values does not leave five solids in the WASM heap.
Superseded **unit scale** keys are released by the same mechanism, so accepting a rescale
proposal does not leave the pre correction solid behind.

#### What re-runs

**Only the changed model's offset is recomputed. The bin is then re-carved in full, cheaply.**

The expensive stage is per model, so a bin with four models where one clearance changed pays
for one Minkowski sum, not four. The other three cached offsets are reused untouched.

The carve stage, though, is not incremental and is not made so. `Manifold.difference` runs once
against the union of all cutters; there is no partial subtraction to update. Caching a
partially carved bin per subset of models would mean a cache entry per combination, and worse,
it would put a second derivation of "what a carved bin is" beside the one in the shared carve
module, which rule 10 forbids. Since the carve stage is the cheap one (8.1), re-running it
whole costs little and keeps a single derivation.

So the cost of a clearance change is: one Minkowski sum, plus one ordinary carve. The cost of a
drag is: one ordinary carve. The difference between them is exactly the one operation that
had to re-run.

#### What the user sees

The failure to avoid is the tab looking frozen while a multi second offset runs.

| Where | During the recompute |
| --- | --- |
| That model's row | Indeterminate progress bar on the row, and the clearance field disabled so a second change cannot queue behind the first |
| Other model rows | Untouched and fully editable. Their offsets are cached and unaffected |
| The bin solid | The previous carve, with the `Stale` chip already specified in 8.4 |
| The ghost meshes | Unchanged and still draggable. Ghosts show the raw model, not the dilated pocket, so a clearance change does not alter them |
| The readout | The footprint row keeps its previous value until the new offset lands, since the authoritative footprint includes the dilation |

The gizmo stays live throughout. A user can keep positioning models while one model's clearance
recomputes, because the two do not contend: placement is applied at carve time and the
recompute is a separate per model stage. The carve that eventually runs picks up both.

#### When it fails

Per rule 2, a failure is a user worded message and never a silent drop or a raw exception.

The offset can fail on a model that parsed and welded successfully, since a Minkowski sum can
exhaust memory or produce a bad status on a pathological input. When it does:

- the previous cache entry is still valid, because it is under a different key,
- so the field reverts to the last clearance that succeeded, and the bin keeps carving with it,
- and the row shows `Applying a clearance of C mm to the model "NAME" failed (DETAIL). The
  model is still using its previous clearance of P mm.`

Reverting rather than blocking is the right behaviour: the user keeps a working bin and a clear
statement of what did not happen, instead of a stuck field and a bin that will not generate.

### 8.7 Worker instance

**Recommendation: give the cutout preview its own worker instance.**

The existing geometry worker serialises every request. A carve taking several seconds would
sit in front of an unrelated STL download the user just clicked, making the whole app feel
stuck for a reason the user cannot see. A second instance of the same worker module isolates
long carves from short interactive work.

Cost: a second `manifold-3d` WASM instance in memory, plus the cached model solids living in
it. That is a few megabytes, on a page that already loads an ONNX runtime and OpenCV for the
trace flow.

Alternative: one worker. Simpler and uses less memory, but accepts that a long carve blocks
every other geometry request behind it. If the owner prefers this, the mitigation is the
model granularity cancellation from 8.5, which is weaker.

Note that the export paths must **not** participate in the cancel previous protocol: a
download must never be cancelled by a preview regenerating. Only `generateCutoutBinPreview`
cancels its predecessor; `generateCutoutBin` and `generateCutoutBinUnion` do not.

### 8.8 The triangle ceiling must be measured, not inherited

`MAX_TRIANGLES = 250000` is already shipped in `web/src/engine/cutout/stlReader.ts` and is
quoted in a user facing message (9.1). **It was picked without measurement**, before any
timing of the pipeline it is supposed to protect, and nothing since has justified it.

That makes it exactly what rule 12 forbids: a constant standing in for a measurement, in the
one place where the number's whole job is to predict how long real work will take. Keeping it
because it is already in the code would be inheriting a guess. So measuring it is a required
work item, not a nicety, and its result is an owner checkpoint, because the owner has been
told he will get real timings rather than another estimate.

An earlier circulated figure of "roughly five minutes at the 250000 triangle ceiling" is
**probably wrong and must not be relied on**. It multiplied the raw 1.2 ms per triangle
Minkowski cost by the import count, which ignores that `simplify` runs first (3.2). Since
simplify is fast and collapses the count sharply, the cost is driven by the **post simplify**
count, which is expected to plateau rather than grow linearly with the import count. Whether
it actually plateaus, and where, is the open question the measurement answers, and it is also
what section 11 lists as unverified.

#### Method

The measurement is end to end, in the app's own conditions, because that is the quantity the
ceiling is supposed to bound. Measure the wall clock time from handing bytes to
`putCutoutModel` to the cached solid being ready: parse, weld, validate, scale, centre,
simplify and Minkowski, with the sphere from 8.3 and the default 0.4 mm clearance.

- **Where.** In the worker, in a browser, not in the Node test suite. The Node suite is the
  wrong environment: it has different WASM performance characteristics and CI timings are not
  a stable basis for a shipped limit.
- **What to measure at each size.** Wall clock total, wall clock for the Minkowski stage
  alone, the triangle count before and after simplify, and peak memory if it can be read.
  The post simplify count is the most informative number, because it is what tests the
  plateau hypothesis directly.
- **Input sizes.** A geometric sweep spanning the plausible range rather than a few points:
  roughly 1000, 5000, 20000, 50000, 150000 and 250000 triangles.
- **Input character.** Both **clean generated solids** (a subdivided sphere is the natural
  one, since a smooth curved surface is the worst realistic case for simplification) **and at
  least two real world downloaded STLs** at different sizes. The distinction matters, since
  8.9 exists precisely because real meshes are not clean, and a ceiling calibrated only on
  generated geometry would repeat the mistake being corrected.
- **Report the raw numbers as a table**, per rule 8, not as a prose conclusion.

#### Setting the ceiling from the result

The ceiling is then the import count at which the measured end to end time crosses a wait the
owner is willing to accept, taken from the real curve and named as such in the constant's
comment together with the measurement date. If the measured cost does plateau, the binding
limit may turn out to be memory or parse time rather than Minkowski time, and the ceiling
should be set from whichever actually binds. It is legitimate for the answer to be that
250000 is fine; what is not legitimate is continuing to assert it without having looked.

If the measurement shows that simplification at one tenth of the clearance does **not** reduce
counts enough to make large models tractable, the correct response is to **lower the ceiling**,
never to loosen the tolerance past its error budget (8.2). The tolerance is a fit guarantee;
the ceiling is a convenience limit. Only one of them may be spent to buy speed.

The message in 9.1 quotes `MAX_TRIANGLES` rather than restating a number, so it follows the
constant wherever the measurement puts it.

### 8.9 A wall clock ceiling on the clearance offset

**This is the largest technical risk in the feature**, and it is the one place where the
benchmarks underpinning every other performance decision here do not apply.

Every Minkowski timing quoted in this document was taken on **clean generated solids**: well
formed triangles, no slivers, no self intersections, no near degenerate geometry. Real STLs
from the wild routinely have all of those, and still pass the watertightness check, because
being a closed manifold surface says nothing about triangle quality. `minkowskiSum` on such a
mesh can behave nothing like the linear 1.2 ms per triangle trend: it can be far slower, and
it can consume memory until the worker dies.

The failure mode without a mitigation is the worst kind. The tab shows an indeterminate
progress bar (8.5) on a model row that will never finish, the user cannot tell a slow import
from a hung one because an indeterminate bar carries no information either way, and the only
escape is reloading the page and losing the session. Nothing in the app ever reports that
anything went wrong.

#### Mitigation

Two mechanisms, because neither alone is sufficient:

1. **`ExecutionContext` cancellation**, already specified in 8.5, gives a cooperative stop.
   Its limits are exactly as described there: a single model's offset is not cancellable once
   the eager operation has begun, because the worker thread is blocked inside it.
2. **A wall clock ceiling**, which is what covers the case cancellation cannot. The import
   stage records a start time before the offset and, when the operation returns, compares
   the elapsed time against the ceiling. If it is exceeded, the result is discarded and the
   import fails with a user worded message rather than being cached.

The honest limitation must be stated plainly rather than glossed: **the ceiling is checked
after the operation returns, so it bounds what is accepted, not what is attempted.** A
Minkowski sum that takes ten minutes still takes ten minutes; the ceiling is what stops the
app from silently going on as if that were normal, and it is what turns an unexplained hang
into a stated outcome the user can act on. Interrupting a blocked synchronous WASM call from
outside is not possible in this structure, which is the same constraint that defeats progress
reporting in 8.5. Terminating the worker outright would interrupt it, at the cost of every
cached model solid and of any unrelated geometry request in flight, and is therefore not the
first response; it stays available as a later escalation if measurement shows the milder
mechanism is not enough.

**The ceiling's value comes from the measurement in 8.8, not from a guess**, which is the
same rule 12 argument and the reason the two items are specified together: it is set at a
clear multiple of the slowest measured time for a legitimate model at the ceiling, so a
normal import can never trip it, and it is documented with the measurement it came from. It
is deliberately not chosen before that data exists, because a ceiling that fires on valid
work is worse than no ceiling.

The message, per rule 2, tells the user what happened and what to do:

> `Applying a clearance to the model "NAME" took longer than SECONDS seconds and was stopped.
> The model is probably too complex or has geometry the offset cannot handle. Simplify it in
> your modelling software and import it again, or import it with a clearance of 0 mm.`

Naming the zero clearance option matters: it is a genuine escape, because zero clearance
skips both the simplify and the Minkowski stages entirely (3.2), so a model that cannot be
dilated can still be used as an exact cutter. On a failed offset the model is not added at a
broken state; it follows the same revert path as any other offset failure (8.6), so the user
is left with a working tab.

### 8.10 Worker interface

```ts
/** Ids the worker does not have cached, which the caller must send. */
missingCutoutModels(ids: string[]): Promise<string[]>;

/**
 * Import one model into the worker's cache: parse, weld, validate, centre,
 * simplify and offset by the clearance. The buffer is transferred, not copied.
 */
putCutoutModel(
  id: string,
  buffer: ArrayBuffer,
  clearanceMm: number,
): Promise<{ triangleCount: number; sizeMm: Vec3 }>;

/** Free cached model solids no longer needed, releasing their WASM memory. */
releaseCutoutModels(keepIds: string[]): Promise<void>;

/** Preview carve. Cancels any preview carve still running. */
generateCutoutBinPreview(params: CutoutBinParams): Promise<CutoutCarveResult>;

/** Export carves. Never cancelled by a preview. */
generateCutoutBin(params: CutoutBinParams): Promise<PartMeshes>;
generateCutoutBinUnion(params: CutoutBinParams): Promise<MeshData>;
```

`CutoutCarveResult` is `{ meshes: PartMeshes; warnings: string[]; footprints: ... }`. Because
the preview result is richer than `PartMeshes`, `useBinPreview` widens its generic from
`useBinPreview<P>` to `useBinPreview<P, R = PartMeshes>` so the result type flows through.
The default keeps all three existing call sites compiling and behaving identically.

Everything crossing into the worker is deep cloned with `JSON.parse(JSON.stringify(x))` to
strip Vue proxies, which structured clone rejects, exactly as `plainPockets` does today.
Mesh buffers cross with `Comlink.transfer` in both directions. Note that transferring the
upload buffer into the worker **moves** it, so the main thread must not hold a reference
afterwards; the authoritative copy is the blob in IndexedDB.

## 9. Error handling

Every message below is a complete sentence in plain technical prose, returned or thrown as a
user worded string, never a raw exception surfaced to the user.

### 9.1 Import, already implemented in `engine/cutout/`

| Condition | Message |
| --- | --- |
| Unparseable file | `This file could not be read as an STL. Check that it is really an STL file and not another format that was renamed.` |
| No triangles | `This STL file contains no triangles, so there is no shape to cut out.` |
| NaN or infinite coordinate | `This STL file contains an invalid coordinate value and may be corrupt.` |
| Over the triangle ceiling | `This STL file has N triangles, which is more than the limit of 250000. Reduce the model in your modelling software and import it again.` |
| Not watertight | `This model is not a closed solid, so it cannot be used as a cutout. Repair it in your modelling software and import it again.` |
| No vertices | `This model contains no vertices, so it has no size.` |

### 9.2 New messages

| Condition | Message | Kind |
| --- | --- | --- |
| Model wholly outside the interior | `The model "NAME" sits entirely outside the bin interior, so it carves nothing. Move it into the bin.` | warning, does not block |
| Model partly outside the interior | `The model "NAME" reaches outside the bin interior, so its pocket breaks through the bin. Move it further in, or use a larger or taller bin.` | warning, does not block |
| Model over the label slot | `The model "NAME" reaches under the label insert slot, which needs to stay solid for the insert to rest on. Move it away from the front wall.` | warning, does not block |
| Model over the fused shelf | `The model "NAME" reaches under the fused label shelf, which needs to stay solid for the label to stand on. Move it away from the front wall.` | warning, does not block |
| Cutout bin given divider walls | `Cutout models cannot be combined with divider walls. Remove the dividers to add models.` | error |
| Model bytes missing from this device | `The model "NAME" is not stored on this device, so this bin cannot be generated. Upload the model again, or remove it from the bin.` | error, blocks generation |
| Model store write failed | `Storing the cutout model failed (DETAIL). The model is loaded for this session, but the bin cannot be edited later without it.` | warning, does not block save |
| Model store unreadable | `Reading the stored cutout model failed (DETAIL).` | error |
| Carve produced an invalid solid | `Cutout bin generation produced an invalid solid: STATUS` | error |
| Preview superseded (status `Cancelled`) | not surfaced; treated as superseded and discarded | internal |
| Negative clearance entered | `The clearance must be 0 mm or more.` | error, blocks the field |
| Clearance above the bin's limit | `A clearance of C mm does not fit a bin GX by GY cells, which allows at most M mm.` | error, blocks the field |
| Clearance offset failed | `Applying a clearance of C mm to the model "NAME" failed (DETAIL). The model is still using its previous clearance of P mm.` | error on the row; the field reverts and the bin keeps generating |
| Clearance offset exceeded the wall clock ceiling (8.9) | `Applying a clearance to the model "NAME" took longer than SECONDS seconds and was stopped. The model is probably too complex or has geometry the offset cannot handle. Simplify it in your modelling software and import it again, or import it with a clearance of 0 mm.` | error on the row; the field reverts as above |
| Model probably authored in metres (5.6) | `The model "NAME" is D mm at its longest, which is too small to hold anything. STL files do not record their units, so it was probably authored in metres. Rescale it as metres, or keep it as millimetres if the size is correct.` | proposal, does not block; two buttons |
| Model probably authored in inches (5.6) | `The model "NAME" is D mm at its longest, which is larger than any bin this app can make. STL files do not record their units, so it was probably authored in inches. Rescale it as inches, or keep it as millimetres if the size is correct.` | proposal, does not block; two buttons |
| A re-imported file has a different name from the stored one (6.4) | `The file "NEW" was linked to the model previously stored as "OLD". Check the size readout if you expected a different model.` | note, does not block |

The `Cancelled` status deserves a note: manifold documents cancellation as permanent for a
`Manifold`, so a cancelled result must be discarded and never inspected further or shown. It
is not an error and must not reach the user as one, which is a live risk given the generic
`status() !== 'NoError'` throw in the carve stage. The carve stage checks for `Cancelled`
explicitly and reports supersession to its caller instead.

## 10. Test plan

Following the existing style: `web/tests/` mirrors `src/`, `environment: node`, manifold
loaded through `tests/helpers/manifold.ts`, geometry assertions on `status()`,
`boundingBox()`, `volume()`, `decompose()` and probe cube intersections, and every `Manifold`
deleted.

### 10.0 What to assert for validity, and what not to

**`genus() === 0` is the wrong validity assertion for a carved bin, and must not be used as
one.** This needs stating explicitly because it is the obvious thing to reach for, it is used
correctly elsewhere in this suite, and using it here fails in the confusing direction: it
rejects correct geometry rather than accepting broken geometry.

The reason is that a Gridfinity bin has a hollow base. A cutter that pinches a slot of that
hollow shut, or any operation that seals a pocket of air inside the solid, produces a **sealed
void**. `decompose()` returns a sealed void as a component of **negative** volume, and a
sealed void drives the whole solid's genus **negative**. The solid is still perfectly valid
and still watertight; a test asserting `genus() === 0` on it simply fails, and the natural
next move when a green suite goes red for a reason nobody understands is to weaken the
assertion or to change the geometry until the number comes back. Both are wrong.

The divider wall work established this and, now that it has landed, demonstrates the correct
pattern in shipped test code rather than merely asserting it. **Follow that pattern; do not
invent a new one.** From `web/tests/binGenerator.spec.ts`:

- **`componentVolumes(solid)`**, the local helper that maps `decompose()` to
  `{ solids, voids }` by the sign of each part's `volume()`. This is the tool for the job and
  the cutout tests use the same helper rather than a second one.
- **Validity is `status() === 'NoError'`**, and nothing else.
- **Connectedness is `componentVolumes(bin).solids` having length 1.** This is the assertion
  that catches a carve leaving a loose island of plastic rattling inside the bin, which
  `status()` will not, because a solid made of several disconnected pieces is perfectly valid
  geometry. It is the assertion this document previously meant when it wrote `genus`.
- **Sealed voids are asserted explicitly as `voids` having length 0**, where the design
  intends there to be none. That states the property directly instead of inferring it from a
  genus number, and when it fails it says what actually happened.
- **Genus, where it is still wanted, is taken on the positive volume component**, as
  `bin.decompose().filter((part) => part.volume() > 0)` then `body.genus()`, and it means one
  specific thing: no spurious handle in the plastic. That is a real property worth asserting
  for a carve that leaves a bridge of material, and it is well defined even when the whole
  solid's genus is not.

So every place this test plan needs the idea "the carve produced one sound piece of plastic",
the assertion is `status()`, `solids` having length 1, and, where a sealed void is not
intended, `voids` having length 0. Whole solid `genus()` is not used on a carved bin.

Note that the shipped suite does assert `genus() === 0` on plain and divided bins, and that
is correct there: those bins have no sealed void, and the tests that rely on it say so in
their comments. The rule is not that genus is useless, it is that it is only meaningful once
the void question has been answered, and for a carve driven by an arbitrary user supplied
model that question cannot be answered in advance.

### 10.1 Shared carve stage, `tests/gridfinity/carvedBin.spec.ts`

| Test | The mistake it catches |
| --- | --- |
| the interior fill welds to the floor plate, leaving no void at `FLOOR_TOP` | the `eps` overlap being dropped in the move, producing a coincident face gap that makes the union non manifold |
| a filled bin with no cutters is watertight and has the volume of the bin plus its interior | the fill extruding to the wrong height, for example to the lip top instead of the nominal bin top |
| a filled bin with no cutters still has its insert channel open | forgetting that the fill closes the slot and must be re-applied |
| carving one cube cutter removes exactly that cube's volume from the fill | the difference being applied before the union rather than after |
| carving with a cutter that misses the bin entirely leaves the bin unchanged | a degenerate empty difference corrupting the solid |
| `buildCarvedBinBody` deletes every cutter it is handed | a WASM memory leak, invisible in output but fatal in a long editing session |
| a cutter that reaches the label slot strip is detected by `labelStructureStrip` | the slot protection being lost in the move from `pocketBin.ts` |
| `maxCarveDepthMm` equals `heightUnits * HEIGHT_UNIT - FLOOR_TOP` | the depth limit drifting from the one the message quotes |
| a filled and carved bin is `NoError` with exactly one positive volume component | a carve leaving a loose island of plastic, which `status()` alone reports as valid |
| **the region at and below `FLOOR_TOP` is identical to the same bin with no cutters**, by trimmed volume and by first layer plan area | the defect described below: material appearing under the container floor, which every validity assertion passes clean |

#### Nothing may appear below the container floor

The last row above deserves its own explanation, because it is the one test here written in
response to a defect that actually shipped rather than one imagined in advance.

The divider wall feature shipped geometry that printed **through the base**: wall roots
reached down past the interior floor and came out as ribs across the bottom of the bin, a
large X on the first layer for a diagonal wall. Every test in the suite passed throughout.
They all asked whether the solid was *valid*, and it was, perfectly: watertight, `NoError`,
one component. Not one of them asked whether material had appeared **where it had no business
being**. The owner found it by printing.

**A cutout pocket has exactly the same failure mode.** A cutter mis-transformed in Z, a fill
that reaches too far down, or a carve that eats into the floor plate all produce a solid that
is entirely valid and entirely wrong, and the wrongness is invisible in the 3D preview
because it is underneath.

The correct assertion is **differential**, comparing the carved bin against the same bin with
no cutters, and this is what makes it work in the presence of a complication that would
otherwise defeat it. **Magnet holes and screw holes legitimately sit below the floor.** They
are cut into the base by design, so an absolute assertion like "the solid is untouched below
`FLOOR_TOP`" or "no material exists in the base region" is simply false for any bin that has
them, and an assertion that hardcoded which regions are allowed to differ would be a second
derivation of the base geometry, which rule 10 forbids. A differential comparison needs to
know none of that: both sides have the same holes, so they cancel, and only a difference
caused by the carve survives. **This must be asserted by test rather than argued in prose**,
and it is the reason the test is written this way.

The established pattern from `web/tests/binGenerator.spec.ts`, which the cutout tests reuse
rather than reinvent:

- `trimByPlane([0, 0, -1], -FLOOR_TOP)` on both bins, comparing `volume()` with
  `toBeCloseTo(..., 6)`. This covers the feet, the hollow base pocket with its rib lattice,
  and the floor plate in one figure.
- `slice(0.1)` on both, comparing `area()`, because the first layer is where the owner saw
  the ribs and a change confined to the bed surface could otherwise hide inside a volume
  comparison.

Both comparisons run **with magnet holes enabled** in the shared parameters, so the exception
is exercised rather than avoided, and a later change that started carving into the base near
a magnet hole would be caught.

### 10.2 Cutout carve, `tests/cutout/cutoutBin.spec.ts`

| Test | The mistake it catches |
| --- | --- |
| a 10 mm cube placed at the interior centre produces a watertight solid: `status()` is `NoError` and `componentVolumes(bin).solids` has length 1 | any CSG failure in the new path, and a carve that leaves a loose island of plastic, which `status()` alone calls valid. Per 10.0, **not** `genus() === 0` |
| the carved pocket measures 10 mm plus twice the clearance on each axis | the Minkowski offset being applied as a radius rather than a diameter, or skipped |
| a zero clearance carve produces a pocket of exactly the model size | the zero clearance fast path silently still offsetting |
| **a compound rotation of 90 deg about X then 90 deg about Y puts a known asymmetric solid where the three.js `ZYX` Euler matrix puts it, and not where the `XYZ` one does** | the intrinsic versus extrinsic Euler trap from 4.3, which is otherwise invisible until a user rotates about two axes |
| a rotation of 90 degrees about X of a 10x20x30 box gives a rotated footprint of 10x30 | the footprint being taken from the raw bounding box instead of the rotated mesh |
| rotate then translate places the pocket at the requested centre; translate then rotate does not | the transform order being swapped, which is silent for a centred model at the origin |
| offsetting then rotating equals rotating then offsetting for a spherical offset | the caching assumption in 3.1 being wrong, which would make every cached carve subtly incorrect |
| two overlapping models produce one merged pocket and no error | overlap being rejected by copying the pocket flow's rule |
| a model placed above the rim opens its pocket through the top face | the carve clamping the cutter to the bin top, reintroducing a through top mode by accident |
| a model sunk fully below the rim leaves the top face closed | the same, in the other direction |
| a model outside the interior returns the "carves nothing" warning and still a valid solid | the warning being thrown instead of returned, blocking a legal design |
| a model straddling a wall returns the "breaks through" warning and still a valid solid | the same |
| a model over the label slot returns the slot warning | the slot protection not being wired into the cutout flow |
| a cutout bin with divider walls is rejected with the walls message | walls silently reaching the carve and producing nonsense |
| the carve keeps the floor plate solid under a pocket that stops above it | the pocket depth limit not being enforced against the floor |
| **the region at and below `FLOOR_TOP` is identical to an uncarved bin of the same parameters, with magnet holes enabled**, by trimmed volume and by first layer plan area | material printing under the container floor, the defect the divider work shipped. Magnet and screw holes legitimately sit below the floor, so the comparison is differential and the exception is exercised rather than assumed |
| **a fully buried model leaves the stacking lip intact**, matching an uncarved bin above the nominal bin top | a cutter or a fill reaching into the lip region and quietly ruining stackability |
| **a model raised through the rim cuts the lip only where it passes through it**, and the rest of the lip profile still matches an uncarved bin | the through top case damaging more of the lip than the model actually occupies |
| a model scaled by `unitScale` 25.4 carves a pocket 25.4 times the file's own dimensions | the unit scale being stored but never applied, or applied after the simplify where its tolerance no longer means millimetres |
| the cached offset key changes with `unitScale` | the unit scale missing from the cache key, which silently reuses the pre correction dilation |
| simplify tolerance is one tenth of the clearance, and zero for zero clearance | the tolerance becoming a hardcoded literal, which rule 12 forbids |
| the sphere segment count satisfies the faceting inequality for several clearances | the segment count being hardcoded rather than derived |
| **two models in one bin with different clearances each get their own dilation, measured on each pocket separately** | a bin wide clearance surviving in the implementation, which would silently give one model the other's fit |
| a bin mixing a 0 mm and a 0.4 mm clearance model carves both correctly, the first exactly and the second dilated | the zero clearance fast path being applied bin wide rather than per model |
| `maxClearanceMm` equals half the narrowest interior dimension, and the validator message quotes that same figure | the ceiling in the message drifting from the ceiling actually enforced |
| the cached offset key changes with clearance and not with placement | the cache being keyed by model alone, so a clearance change silently reuses the old dilation, which is a wrong printed part with no visible symptom |
| recomputing one model's offset leaves the other models' cache entries intact | a clearance change invalidating the whole cache, turning a one model cost into an all model one |

#### The stacking lip interaction is unverified, so it is a test rather than an argument

Whether the stacking lip survives a cutter reaching the lip region has **not been verified**,
and it cannot be settled by reasoning from this design alone. The lip sits above the nominal
bin top; the interior fill stops at the nominal bin top (2.3); a cutter, however, is the model
wherever the user put it, and this design deliberately allows a model to be raised through the
rim so its pocket opens at the top (1, out of scope). So a cutter can reach into the lip
region by design, and what that does to the lip profile is a real question with a real
stackability consequence.

It is captured as the two test rows above rather than as an open question for the owner,
because it is a question about the geometry rather than about what the owner wants, so the
suite can answer it and no one has to guess. The two rows bracket the honest answer: a buried
model must not touch the lip at all, and a model that genuinely passes through the rim must
damage the lip only where it passes through, not more widely. If the second turns out to be
false, that is a finding to report rather than a test to relax, and it is listed among the
unverified items in section 11 until the tests exist and pass.

### 10.3 Traced pocket bin regression

`tests/trace/pocketBin.spec.ts` is **not modified**. Its 24 existing tests are the proof that
the shared carve extraction was behaviour preserving. If any of them needs a change, the
refactor was not behaviour preserving and the implementer stops and reports.

### 10.4 Plan layer, `tests/plan/planFile.spec.ts` and `tests/plan/rowDescriptor.spec.ts`

| Test | The mistake it catches |
| --- | --- |
| a version 6 plan with a cutout bin round trips through serialize and parse unchanged | any field dropped by `pickCutoutModels`, the classic silent data loss |
| every validator message in 5.4 fires on its own malformed input | a validator branch that is unreachable because an earlier check subsumes it |
| a cutout model with no `clearanceMm` loads with the 0.4 mm default | older plans failing to load after a later field is added |
| two models in one bin with different clearances round trip with both values intact | a per bin clearance creeping back in through the loader, collapsing two values into one |
| a cutout model with a `unitScale` of 25.4 round trips with that value intact, and one with no `unitScale` loads as 1 | the unit choice being asked again on every load, or an older plan's models silently changing size |
| a clearance above `maxClearanceMm` is rejected with a message naming the bin size and the real limit | a clearance no model could ever fit being accepted and failing later in the worker instead |
| a cutout bin carrying `walls` is rejected | the traced bin's walls exclusion not being mirrored |
| a version 5 plan still loads unchanged | the version bump breaking existing stored plans, which would silently empty every user's queue |
| a version 7 plan is rejected naming versions 1 to 6 | the ceiling message drifting from the constant |
| `describeProduct` on a cutout bin gives a cutout title and a cutout count caption | **the fall through trap**: `detailToken` and `synthesizedTitle` are not exhaustive over origin, so a cutout bin would read `bin.walls` and either crash or describe itself as a manual bin |
| `partsOf` carries the models through for both product kinds | the download path generating an uncarved bin, which would waste a real print |

### 10.5 Stored assets, `tests/plan/storedAssets.spec.ts`

Replaces `tests/plan/traceSources.spec.ts`. The trace assertions carry over semantically
unchanged; only the import path and the function names change.

| Test | The mistake it catches |
| --- | --- |
| the existing trace photo sweep cases, unchanged in meaning | the generalisation breaking the behaviour it generalised |
| a cutout model referenced by an entry is not swept | the sharpest trap in the feature: models deleted on the next plan persist |
| a cutout model referenced only by a batch item is not swept | a model deleted when its queue row is turned into a batch |
| a model referenced by two bins survives deleting one of them | a refcount implementation instead of set membership |
| an unreferenced model is swept from the models store and no photo is touched | the two stores being crossed, deleting photos when models are swept |
| `protectedIds` keeps an in progress upload alive with no plan row referencing it | the write ordering trap from 6.3 |

### 10.6 Not covered by the suite

`src/idb.ts`, `src/modelStore.ts` and `src/photoStore.ts` stay untested: Node has no
IndexedDB, which is exactly why the existing code puts the sweep logic in the engine behind
an injectable interface. The same reasoning applies here and the same seam is used.

The viewport, the gizmo arbitration and the ghost tier have no automated coverage, because
there are no component tests in this repo and adding a browser test harness is out of scope.
Their verification is the owner browser checkpoints in the plan.

## 11. Open questions and risks

### Top risks

1. **The Euler convention mismatch (4.3).** `three.js` `Euler` defaults to intrinsic `XYZ`
   while `Manifold.rotate` documents extrinsic `XYZ`, and these differ for any two axis
   rotation. Getting it wrong makes the ghost preview and the carved pocket disagree in a way
   that is invisible for single axis rotations and therefore likely to survive casual
   testing, then produce a wrong physical part. Mitigation: pin `rotation.order = 'ZYX'` and
   the dedicated non commutative test in 10.2.

2. **The write ordering trap (6.3).** `binQueue.persist()` sweeps stored assets on every plan
   mutation. A model blob written after the queue mutation, or held only in the tab during
   editing without protection, is deleted almost immediately. The failure is asynchronous and
   silent, and it surfaces later as a bin that cannot be regenerated. Mitigation: blob before
   mutation, a separate object store so the photo sweep cannot reach models, `protectedIds`
   for in progress uploads, and the tests in 10.5.

3. **The shared carve refactor touching working geometry.** `buildPocketBinBody` is the
   proven core of a shipped feature. Extracting the fill, subtract and re-slot stages risks
   changing the `eps` handling, the order of the union, or the point at which the slot is
   re-applied, any of which produces a subtly wrong bin rather than an obvious failure.
   Mitigation: the entire existing trace and pocket suite stays green with no test modified,
   and any test needing a change means the refactor was not behaviour preserving.

4. **Minkowski on pathological input is unmeasured (8.9).** Every timing this design rests on
   was taken on clean generated solids. Real STLs have slivers, near degenerate triangles and
   self intersections while still passing the watertightness check, and `minkowskiSum` on
   such a mesh may be far slower than the linear trend or may exhaust memory. The earlier
   plan named this its single largest technical risk and that judgement is adopted here: it
   is the risk that can make the feature unusable rather than merely wrong, and unlike the
   first three it cannot be closed by a test written in advance, only bounded. Mitigation:
   the wall clock ceiling and the cancellation in 8.9, with the ceiling's value coming from
   the measurement in 8.8, plus the zero clearance escape route named in the message.

5. **Non watertight input is rejected outright, and a meaningful fraction of real imports
   will be refused.** There is no repair step, and meshes from the wild are frequently not
   closed. This is accepted rather than mitigated, because the alternatives are worse: mesh
   repair is a substantial separate feature, and an automatic convex hull fallback is
   explicitly prohibited (section 1), because it is cheap and always succeeds and therefore
   would silently produce a wrong pocket for every concave part instead of an honest refusal.
   The user facing consequence is a clear rejection message naming what to do (9.1).

Close behind, and worth naming because its failure mode is the same kind as the first: **the
offset cache being keyed by model identity alone rather than by model, unit scale and
clearance together.**
Changing a clearance, or accepting a unit rescale, would then silently reuse the previous
dilation. Nothing looks wrong: the
preview renders, the bin is watertight, the download succeeds, and the part is simply the wrong
size when it comes off the printer. Mitigation is the explicit cache key test in 10.2 and the
fact that clearance sits beside `placement` rather than inside it (5.1), which keeps the cheap
change and the expensive one distinguishable in the data.

### Open questions for the owner

1. **Gizmo handle sizing.** Rotate `setSize(1.6)` is derived from the handle radii (arrow
   tips at 0.5, arcs at 0.5 in gizmo units) but not confirmed on screen. Needs a visual check
   and possibly adjustment within roughly 1.4 to 1.8.
2. **Interface increments.** The gizmo's 1 mm translation snap and the clearance field's
   0.05 mm step are both user interface choices, not derived constants. Confirm both, or name
   different increments.
3. **A second worker instance for cutout previews (8.7).** Recommended, at the cost of a
   second WASM instance in memory. Confirm or take the single worker with weaker isolation.
4. **Read only position and rotation rows (7.7).** Recommended so there is one input path.
   Confirm, or ask for editable fields in the first version.
5. **`Fit bin to models`.** Specified as an explicit button rather than continuous auto sizing,
   unlike the trace flow's `enableAutoSize`. Confirm that is the wanted behaviour.

**Resolved.** Clearance is per model, decided by the owner on 2026-07-20. The reasoning and
the accepted costs are recorded in 5.2; the performance consequence is worked through in 8.6.

**Resolved.** The progress indicator for the clearance step is an **indeterminate** bar,
decided by the owner on 2026-07-20 after being shown that the percentage bar he originally
asked for is not achievable with the current single worker structure. The full record,
including what would achieve it and at what cost, is in 8.5. The owner may revisit it once
the timings from 8.8 show how long the wait actually is.

**Not an open question, deliberately.** The stacking lip interaction (10.2) is unverified but
is not put to the owner, because it is a question about what the geometry does rather than
about what the owner wants. Two tests settle it.

### Things I could not verify

- The gizmo's on screen appearance, reachability of overlapping handles, and touch behaviour.
  No browser was available in this environment. Everything stated about `TransformControls`
  is read from `node_modules/three/examples/jsm/controls/TransformControls.js` at version
  0.178.0 and is cited as such; everything about how it looks and feels is not verified.
- The 1.2 ms per triangle Minkowski figure is taken from the prior benchmarking the brief
  supplied and was not re-measured. It was measured on clean generated solids only, which is
  the whole basis of risk 4.
- Whether `simplify` at one tenth of the clearance actually reduces triangle counts enough to
  make a 250000 triangle model tractable. The tolerance is principled, but the resulting
  triangle count is model dependent and unmeasured. If it proves insufficient, the honest
  response is to lower the import ceiling, not to loosen the tolerance past its error budget.
- **The triangle ceiling itself.** `MAX_TRIANGLES = 250000` is shipped, is quoted in a user
  facing message, and was picked without measurement. It is not defended anywhere in this
  document and must not be treated as settled. Section 8.8 specifies the measurement that
  replaces it, and the plan makes the result an owner checkpoint.
- **Whether the stacking lip survives a cutter reaching the lip region** (10.2). The lip sits
  above the nominal bin top, the interior fill stops at the nominal bin top, and a cutter is
  the model wherever the user put it, so a cutter can reach the lip by design. Two tests are
  specified to settle it; until they are written and green, the behaviour is unknown.
- **The unit mismatch thresholds have not been checked against a corpus** of real inch
  authored and metre authored models (5.6). They are reasoned from the bin interior size and
  the build plate, and they only decide whether to ask a question rather than changing any
  geometry, so a wrong threshold costs an unnecessary or a missing prompt and never a wrong
  part. That is why they are acceptable unmeasured, and it is the reason the correction is
  never applied automatically.
- Whether an `await` yield between models genuinely lets Comlink deliver a queued cancel
  message in this worker setup (8.5). The mechanism is sound in principle; it needs a test.
