# STL cutout bin: design

Date: 2026-07-20. Status: proposed, awaiting owner approval.

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
must do. The traced pocket bin performs these steps:

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
than more lines in `binGenerator.ts` (already 962 lines) because rule 3 says a new geometry
stage is its own module.

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

### 3.2 Import stage, once per model (and again if its clearance changes)

| # | Stage | Call | Cost |
| --- | --- | --- | --- |
| 1 | Parse | `parseStl(buffer)` | Linear in file size. Milliseconds. |
| 2 | Build mesh | `new m.Mesh({ numProp: 3, vertProperties, triVerts })` | Negligible. |
| 3 | **Weld** | `mesh.merge()` | Mandatory. Without it every valid STL is rejected as not manifold, because STL gives every triangle its own three vertices. Already handled inside `meshToManifold`. |
| 4 | Validate solid | `new m.Manifold(mesh)` then `status()` | Throws a raw `Not manifold` error on an open mesh, already translated to a user worded message by `meshToManifold`. |
| 5 | Centre | `solid.translate(-cx, -cy, -cz)` from `boundingBox()` | Deferred and free. See 4.2. |
| 6 | **Simplify** | `solid.simplify(toleranceMm)` | Proportional to triangle count. This is what makes stage 7 tractable. |
| 7 | **Offset** | `simplified.minkowskiSum(m.Manifold.sphere(clearanceMm, segments))` | Roughly 1.2 ms per input triangle. Dominates everything. |
| 8 | Cache | store under `${modelSourceId}:${clearanceMm}` | |

When `clearanceMm` is 0 there is no offset to compute and no error budget to spend, so
stages 6 and 7 are both skipped entirely and the centred solid is cached directly. That makes
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
  /** Size of the model's own bounding box in mm, before any rotation. */
  sizeMm: { x: number; y: number; z: number };
  /** Where the model sits in the bin. */
  placement: ModelPlacement;
  /**
   * How far the pocket is dilated beyond the model surface, in mm, as a true
   * 3D offset. Per model rather than per bin, because a snug locating pocket
   * and a loose drop-in pocket can reasonably share one bin.
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

### 5.2 Default clearance

```ts
/**
 * Default dilation of a cutout pocket beyond the model surface. One nozzle
 * width, matching the extrusion width the rest of the tool assumes, which is
 * the smallest gap an FDM printer can be expected to actually leave open.
 */
export const DEFAULT_CUTOUT_CLEARANCE_MM = 0.4;
```

Its home is `engine/cutout/cutoutBin.ts` and both the store default and the plan loader
default read it from there.

### 5.3 Plan file version bump

`PLAN_FILE_VERSION` goes from 5 to **6**. A version 6 file may contain `origin: 'cutout'`
bins; versions 1 through 5 cannot and are read exactly as they are today. No conversion is
needed in either direction for existing data, because the change is purely additive: no
existing field changes meaning.

`parsePlanFile` already rejects a file whose version exceeds `PLAN_FILE_VERSION` with
`The file has plan version N, but this app reads versions 1 to M.` That message stays and
now names 6, which is the correct behaviour when an older build meets a newer plan.

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
| `sizeMm` missing a finite x, y or z | `${subject}: cutout model ${id}: sizeMm needs finite x, y and z` |
| `placement` not an object | `${subject}: cutout model ${id}: placement must be an object` |
| any placement field not finite | `${subject}: cutout model ${id}: placement ${field} must be a number` |
| `clearanceMm` not finite or negative | `${subject}: cutout model ${id}: clearanceMm must be a number of at least 0` |

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

`clearanceMm` and `sizeMm` are accepted as absent and defaulted on pick
(`DEFAULT_CUTOUT_CLEARANCE_MM`, and zeroes recomputed on next generation), following the
precedent set by `minHoleWidthMm` and `filledHoleIndices`, so a plan written by an early
build still loads.

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
preview.

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
position X, Y and Z in mm, rotation X, Y and Z in degrees, the rotated footprint as
width by depth in mm, the resting height above the interior floor, and the triangle count.

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

### 8.3 Offset sphere resolution

`Manifold.sphere(radius, circularSegments)` approximates the sphere, and its faceting error is
`radius * (1 - cos(pi / n))` for `n` segments. Tying that error to the same budget as the
simplification keeps one consistent error model rather than introducing a second free
parameter:

```
choose the smallest n such that clearanceMm * (1 - cos(pi / n)) <= simplifyToleranceMm
```

With `simplifyToleranceMm = clearanceMm / 10` this reduces to `1 - cos(pi / n) <= 0.1`, that
is `n >= 7`, independent of the clearance value. The implementation computes it from the
formula rather than hardcoding the result, so the relationship stays visible and stays
correct if the tolerance rule changes. `manifold-3d` also exposes `getCircularSegments` and
`setMinCircularAngle` as the library's own primitives for this; the derived value is used
because it ties the sphere's error to this pipeline's specific budget rather than to a global
quality setting shared with unrelated geometry.

Keeping the sphere coarse matters twice over: Minkowski cost scales with the complexity of
both operands.

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

### 8.6 Worker instance

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

### 8.7 Worker interface

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

The `Cancelled` status deserves a note: manifold documents cancellation as permanent for a
`Manifold`, so a cancelled result must be discarded and never inspected further or shown. It
is not an error and must not reach the user as one, which is a live risk given the generic
`status() !== 'NoError'` throw in the carve stage. The carve stage checks for `Cancelled`
explicitly and reports supersession to its caller instead.

## 10. Test plan

Following the existing style: `web/tests/` mirrors `src/`, `environment: node`, manifold
loaded through `tests/helpers/manifold.ts`, geometry assertions on `status()`, `genus()`,
`boundingBox()`, `volume()` and probe cube intersections, and every `Manifold` deleted.

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

### 10.2 Cutout carve, `tests/cutout/cutoutBin.spec.ts`

| Test | The mistake it catches |
| --- | --- |
| a 10 mm cube placed at the interior centre produces a watertight solid | any CSG failure in the new path |
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
| simplify tolerance is one tenth of the clearance, and zero for zero clearance | the tolerance becoming a hardcoded literal, which rule 12 forbids |
| the sphere segment count satisfies the faceting inequality for several clearances | the segment count being hardcoded rather than derived |

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

### Top three risks

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

### Open questions for the owner

1. **Gizmo handle sizing.** Rotate `setSize(1.6)` is derived from the handle radii (arrow
   tips at 0.5, arcs at 0.5 in gizmo units) but not confirmed on screen. Needs a visual check
   and possibly adjustment within roughly 1.4 to 1.8.
2. **Translation snap of 1 mm.** A user interface choice, not a derived constant. Confirm, or
   name a different increment.
3. **A second worker instance for cutout previews (8.6).** Recommended, at the cost of a
   second WASM instance in memory. Confirm or take the single worker with weaker isolation.
4. **Read only position and rotation rows (7.7).** Recommended so there is one input path.
   Confirm, or ask for editable fields in the first version.
5. **`Fit bin to models`.** Specified as an explicit button rather than continuous auto sizing,
   unlike the trace flow's `enableAutoSize`. Confirm that is the wanted behaviour.
6. **Per model clearance versus one clearance per bin.** Specified per model. Confirm.

### Things I could not verify

- The gizmo's on screen appearance, reachability of overlapping handles, and touch behaviour.
  No browser was available in this environment. Everything stated about `TransformControls`
  is read from `node_modules/three/examples/jsm/controls/TransformControls.js` at version
  0.178.0 and is cited as such; everything about how it looks and feels is not verified.
- The 1.2 ms per triangle Minkowski figure is taken from the prior benchmarking the brief
  supplied and was not re-measured.
- Whether `simplify` at one tenth of the clearance actually reduces triangle counts enough to
  make a 250000 triangle model tractable. The tolerance is principled, but the resulting
  triangle count is model dependent and unmeasured. If it proves insufficient, the honest
  response is to lower the import ceiling, not to loosen the tolerance past its error budget.
- Whether an `await` yield between models genuinely lets Comlink deliver a queued cancel
  message in this worker setup (8.5). The mechanism is sound in principle; it needs a test.
