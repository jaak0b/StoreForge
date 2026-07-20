# Cutout insertability sweep: design

Date: 2026-07-20. Status: proposed, awaiting owner approval.

## In plain terms

A cutout bin carves a pocket the exact shape of an imported model, dilated by a clearance.
That works for a model that is wider at the top than anywhere below it, because the object
drops straight in. It fails for a model with an undercut: a camera whose lens sticks out
past its body, a bottle wider at the shoulder than the neck, any part narrower higher up.
The exact pocket has a lip the object cannot pass on the way down, so the printed bin cannot
physically receive the thing it was carved for.

This adds a per model option that fixes it: instead of carving the exact dilated shape,
**carve everything that shape would sweep through on its way straight up and out of the bin.**
The pocket then has no overhang: any horizontal slice is at least as wide as every slice
below it, so the object always clears. An optional draft angle leans the swept walls outward
toward the top, so the pocket widens as it rises and the part is easier still to drop in and
lift out.

The user sees a checkbox on each model's card, "Sweep the pocket open upward", and a draft
angle box beside it. Turn it on and the model's pocket opens straight up; raise the angle and
the walls flare. It is per model, next to the clearance box, and it commits the same way the
clearance does: nothing recomputes while the number is mid edit, a ghost stands in until the
value is committed on blur or Enter.

## 1. Summary and scope

Per model, optionally replace the exact dilated cutter with its **vertical sweep**: the
Minkowski sum of the placed, dilated cutter with a vertical segment (draft angle 0) or a
vertical cone widening upward (draft angle greater than 0). The segment and the cone are both
convex, so the Minkowski sum is fast and exact, and both are established operations already
used elsewhere in this engine (the clearance is itself a Minkowski sum, with a sphere).

### In scope

- Two new per model fields, `sweepEnabled` and `draftAngleDeg`, stored in the plan.
- A per model checkbox and draft angle box on the model card, committing on release.
- The sweep applied at carve time on the placed cutter, reaching provably out of the bin top.
- Warnings and footprint sizing computed from the swept cutter, not the unswept one.
- A plan file version bump and field validation.

### Out of scope

- Any global "sweep all models" toggle. The fit a model needs is the model's own, exactly as
  clearance is (5.2 of the cutout spec).
- A horizontal or arbitrary insertion direction. The sweep is world vertical, matching how a
  printed bin is filled and emptied. A part that must slide in sideways is a different feature.
- Changing the clearance offset. The sweep composes on top of the existing dilated cutter; the
  clearance pipeline is untouched.

## 2. The geometry

### 2.1 The operation

A cutout cutter today is `placeCutter(solid, placement)`: the cached dilated solid, rotated
then translated into the bin (`cutoutBin.ts`). The sweep is one further operation on that
placed cutter:

- **Draft angle 0:** `placed.minkowskiSum(segment)`, where `segment` is a degenerate vertical
  solid from the origin up to `coneLengthMm` (a thin box or a two point extrusion; a true zero
  radius line is not a manifold, so the segment is modelled as an extremely thin vertical
  prism, its footial radius derived, not picked). The sum extrudes the whole placed cutter
  straight up, so every point of the model contributes an unbroken vertical column upward.
- **Draft angle greater than 0:** `placed.minkowskiSum(cone)`, where `cone` is
  `m.Manifold.cylinder(coneLengthMm, radiusLowMm, radiusHighMm, segments)` with `radiusLowMm`
  the segment radius at the bottom and `radiusHighMm = tan(draftAngleRad) * coneLengthMm` at
  the top. Because the cone widens upward, the swept walls lean outward with height by exactly
  the draft angle.

Both are convex operands, which is why the sum is fast: manifold's Minkowski cost is driven by
the complexity of the convex operand, and a segment or a single cone is trivial.

### 2.2 Cone length: derived, never a constant

The sweep must clear the bin top whatever the bin height and wherever the model sits, and the
length that guarantees it is derived from existing envelope figures, not a magic constant
(rule 12). `binEnvelope.ts::interiorBoundsMm` already gives the interior top,
`maxZ = heightUnits * HEIGHT_UNIT`. The Minkowski sum adds the cone to every point of the
cutter, so the swept solid's own top is `cutterMaxZ + coneLengthMm`. To guarantee that even
the lowest point of the cutter sweeps a column reaching past the interior top:

```
coneLengthMm = (interiorTopZ - placedCutterMinZ) + eps
```

`placedCutterMinZ` is the placed cutter's `boundingBox().min[2]`, and `interiorTopZ` comes
straight from `interiorBoundsMm`. `eps` is the same weld overlap the interior fill already
uses, so the sweep provably pokes through the top rather than landing flush on it. This is
exact for any placement and any bin height, and it is derived entirely from values the
codebase already produces. No fixed sweep height is introduced.

### 2.3 Cone facet count: the shared derivation

The cone's circular top is faceted, and its segment count comes from
`geometry/circleSegments.ts::circleSegments(radiusHighMm, toleranceMm)`, the same derivation
the clearance sphere uses, never a hand picked number. The tolerance is the model's own
`simplifyToleranceMm(clearanceMm)` (clearance / 4), so the cone's faceting error is bounded by
the same budget the rest of that model's fit already spends. A draft angle 0 sweep uses the
segment, which has no circular cross section to facet, so no segment count is needed there.

**Resolved by the owner (2026-07-20):** when `clearanceMm` is 0 there is no clearance derived
tolerance, so the cone's facet count is derived from the draft cone's own dimensions through
the shared `circleSegments` derivation, exactly as any other curved surface in the app derives
its facets: the tolerance is the same clearance / 4 rule evaluated on the cone's own top
radius, `simplifyToleranceMm(radiusHighMm)`. No fallback constant enters; the ratio is the one
the clearance sphere already spends (a sphere of radius r faceted against a tolerance of
r / 4), applied to the cone's radius instead.

## 3. Pipeline placement and cache implications

### 3.1 The sweep is not rotation invariant, so it cannot be cached in prepare

This is the load bearing decision. The clearance offset is cached in the worker
(`CutoutModelCache`) precisely because a sphere is isotropic: offsetting then rotating equals
rotating then offsetting, so the dilation is computed once in the model's own frame and reused
for every placement. **The vertical sweep has no such property.** A cone points along world Z,
so sweeping then rotating is not the same solid as rotating then sweeping. The sweep depends
on the model's placed orientation and must therefore run **after** the placement rotation, on
the placed cutter, at carve time. It cannot live in the cached `prepareCutoutModel` step, and
it must not touch `cutoutModelKey`.

Concretely, the sweep is applied in `buildCutoutBinBody`, where each model is already turned
into a placed cutter, before `validateCutoutPlacement` and before the footprints are measured,
so validation and footprints see the swept solid. `placeCutter` (or a thin wrapper beside it)
gains the manifold instance, the bin height and the model's sweep fields, and returns the
swept placed cutter when `sweepEnabled` is set.

### 3.2 What this costs, and what to benchmark

Because the sweep runs at carve time, it runs on **every carve**, including every drag end,
not once per import. The operand is cheap (a segment or one cone) but the other operand is the
placed, dilated cutter, roughly 8k to 25k triangles after the clearance offset. A Minkowski
sum of a cutter that size with a convex operand is the new per carve cost for a swept model,
added on top of the difference that carves it.

No figure is asserted here. The implementation must **benchmark the cone Minkowski of a
representative placed cutter (target the 25k triangle end) in the browser worker** and record
it beside the existing clearance timings, exactly as `CutoutPrepareTimings` records the offset
cost today. If it proves too slow to run on every drag end, the escape hatch is already
visible in the geometry: the sweep is invariant under translation (Minkowski commutes with
translation) and depends only on the model, its clearance, its unit scale, its rotation and
its draft angle. A swept cutter could therefore be cached under a key that adds rotation and
draft angle to the existing three, recomputed only when the model is rotated or its angle
changes, and merely translated for a pure drag. That optimization is **not** in the initial
scope; it is recorded so the benchmark has a known next step if it fails, rather than being
reached for speculatively.

**Resolved by the owner (2026-07-20): the benchmark failed the drag budget** (a 12.8k
triangle non-convex cutter cost 15 to 52 seconds per sweep, against about 0.3 seconds for the
rest of the carve), **so the escape hatch above is built.** The worker holds an in-memory
swept-solid cache beside the prepared-model cache (`CutoutSweptCache` in
`worker/cutoutModels.ts`; nothing is persisted, a reload starts empty), keyed by
`cutoutSweptKey`: the prepared model's key plus the placement rotation and the draft angle.
To make the cached solid serve every translation, the carve pipeline is rotate, sweep,
translate, then **trim the cutter at the swept reach** (the nominal top plus the lip height
plus the weld overlap, `sweptReachZ`): every sweep length at or above the placement's minimum
yields the identical trimmed cutter, so the cache stores the bed-anchored standard length and
a pure drag, downward included, is a hit. Eviction follows the prepared-model cache's
explicit pattern: each carve keeps only the keys it names, and releasing a prepared model
drops the swept solids derived from it.

### 3.3 The cache key is unchanged

Since the sweep never enters the prepared solid, `cutoutModelKey` stays
`modelSourceId:unitScale:clearanceMm`. Turning the sweep on or off, or changing the draft
angle, invalidates no cache entry and re runs no import. It triggers a re carve only, which is
why its commit is cheaper than a clearance commit even though it shares the release pattern.

## 4. UI

The model card in `components/cutout/ModelList.vue` gains, directly under the existing
clearance field and only when the model is present (not in the missing or busy state):

- A checkbox, "Sweep the pocket open upward", bound to `sweepEnabled`. Toggling it commits
  immediately (a boolean has no mid edit state) and triggers a re carve.
- A draft angle number field, "Draft angle (degrees)", shown only when the checkbox is on,
  built exactly like the clearance field: `type="number"`, `min="0"`, a `max` below 90, a
  step, `hide-details`, disabled while the model is busy, editing a draft value and committing
  on `@blur` and `@keyup.enter`. It reuses the clearance card's recompute on release pattern
  verbatim: the store holds a `draftAngleDraft` in `ModelEditorState` beside `clearanceDraft`,
  the field binds to the draft, and only the committed value re carves. A ghost preview stands
  in meanwhile, the same as for clearance.

Store additions mirror the existing clearance plumbing in `stores/cutout.ts`:
`setDraftAngle(id, deg)` writes the committed value and keeps the draft in step,
`setDraftAngleDraft(id, deg)` writes only the field, `setSweepEnabled(id, on)` writes the
flag, and `ModelEditorState.draftAngleDraft` is seeded in `freshState`. `ModelList.vue` emits
a `commitSweep` event alongside `commitClearance`, wired to a re carve.

The UI text is plain technical prose (rule 7): "Sweep the pocket open upward", "Draft angle
(degrees)", and when the sweep changes a footprint warning, the existing warning sentences
already quote the model name and need no new wording beyond naming the swept pocket.

## 5. Plan file changes

Two fields on `CutoutModel` in `engine/plan/types.ts`, siblings of `clearanceMm` since like it
they change the carve but, unlike it, not the cached solid:

```ts
/**
 * Whether this model's pocket is swept straight up and out of the bin instead
 * of carved to the exact dilated shape, so a model with an undercut can still
 * drop in. Applied after placement rotation, so it is not part of the cached
 * import and does not key the prepared solid.
 */
sweepEnabled: boolean;
/**
 * How far the swept pocket walls lean outward toward the top, in degrees. 0 is
 * a straight vertical sweep; larger angles flare the walls for easier insertion
 * and removal. Ignored when sweepEnabled is false.
 */
draftAngleDeg: number;
```

`PLAN_FILE_VERSION` goes from 6 to **7**. The change is purely additive: no existing field
changes meaning, and versions 1 to 6 are read exactly as today. `parsePlanFile`'s version
ceiling message now names 7.

`pickCutoutModels` defaults both fields when absent, following the precedent set by
`unitScale` and `clearanceMm`: `sweepEnabled` defaults to **false** in the loader (a fresh
upload defaults to on, see section 8) and `draftAngleDeg` defaults to `0`. A version 6 plan therefore loads
with the sweep off, reproducing exactly the bins it described.

`validateCutoutModels` gains two checks in its existing check order and message style:

| Condition | Message |
| --- | --- |
| `sweepEnabled` present and not a boolean | `${subject}: cutout model ${id}: sweepEnabled must be true or false` |
| `draftAngleDeg` not finite, negative, or 90 or more | `${subject}: cutout model ${id}: draftAngleDeg must be a number from 0 up to but not including 90` |

The upper bound is 90 exclusive because `tan(90 degrees)` is unbounded: the cone radius, and
so the pocket, would be infinite. The bound is a property of the geometry, not a tuned figure.

## 6. Warnings and footprint interaction

Every judgement the carve makes about a model must be made about the **swept** cutter, because
the swept solid is what is actually subtracted:

- `validateCutoutPlacement` intersects each cutter with the interior fill and projects it
  against the label structure strip. Applying the sweep before this call means the "carves
  nothing", "reaches under the label" checks all see the enlarged solid. A sweep that flares a
  pocket out under the label strip must warn, and it does, because the projection it tests is
  the swept projection.
- The footprints returned in `CutoutCarve.footprints`, and the authoritative post dilation
  sizes the readout shows, are `sizeOf(cutter)` on the swept cutter, so they report the pocket
  the bin actually has, which at draft angle greater than 0 is widest at the top.
- The editor side `fitBinToModels` in `binEnvelope.ts` sizes a bin from mesh bounds plus
  clearance and does not currently know about the sweep. A draft angle grows the top footprint
  by `tan(angle) * height`, which can be large, so the live fit suggestion must add the draft
  expansion to each placed model's extent, or defer to the worker's authoritative footprint.
  This is the one cross cutting spot the sweep touches beyond the carve itself, and it is
  flagged so the fit stays honest rather than under sizing a swept bin.

## 7. Test plan

Engine tests (`web/tests/cutout/`), where the WASM loads in node:

1. **Undercut clears.** A synthetic solid narrower at the bottom than the top (an inverted T
   in section), carved with the sweep on, produces a pocket whose every horizontal slice is at
   least as wide as the slice below it: assert monotonic non decreasing cross section width up
   the pocket. With the sweep off, assert the pocket is not monotonic (the undercut survives),
   proving the test discriminates.
2. **Sweep reaches the top.** For a model placed low and a tall bin, assert the swept pocket
   opens at the interior top (the carved bin is open above the model), from the derived cone
   length, and that raising the bin height keeps it open with no per height constant.
3. **Draft angle flares outward.** For an angle greater than 0, assert the pocket's top
   footprint exceeds its footprint at the model's own top by approximately
   `tan(angle) * height`, within the facet tolerance.
4. **Rotation dependence.** Rotate a known asymmetric model 90 degrees about X, sweep it, and
   assert the swept solid differs from sweeping first then rotating, confirming the sweep runs
   after placement and is not rotation invariant. This is the geometric fact the pipeline
   placement rests on.
5. **Watertight and valid.** Every carved swept bin has manifold `status() === 'NoError'`, per
   the geometry integrity bar (rule 1).
6. **Cache untouched.** Changing `draftAngleDeg` or `sweepEnabled` produces no new
   `cutoutModelKey` and no import miss, only a re carve.

Plan tests (`web/tests/plan/`): round trip a bin with both fields set; a version 6 plan loads
with the sweep off; each new validator message fires on its bad input and the good input
passes. Follow the `writing-unittests` skill for tests that would catch a real regression.

The verification bar is unchanged: `npm run build` and `npm test` green inside `web/`, and the
swept 3MF verified in Orca Slicer by the owner before the format is considered proven.

## 8. Default state, resolved

**Resolved by the owner (2026-07-20): a newly imported model starts with the sweep ON, at a
draft angle of 0 degrees.** Every new pocket is insertable by default, which is the safer
physical outcome. The plan loader still defaults an absent field to **off**, because a pre
version 7 plan predates the choice and its bins were designed with exact pockets: loading it
must reproduce exactly the bins it described. The single home for the new-model default is
`DEFAULT_CUTOUT_SWEEP_ENABLED` in `engine/cutout/cutoutBin.ts`.
