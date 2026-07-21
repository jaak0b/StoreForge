# Cavity edit tools for cutout bins (design)

Date: 2026-07-21. Status: approved in conversation, pending owner review of this document.

## Goal

Let the user manually clean up the carved cavity of a cutout bin with three viewport brush tools:
Add (restore material), Remove (carve more), Flatten (shave a region flat at a picked height).
Edits are part of the bin recipe: deterministic, watertight, surviving reload and export.

## Owner decisions (from conversation)

- Edits apply to the carved cavity in the bin, not to the imported STL models.
- Interaction is a brush painted directly on the bin surface in the viewport (CSG underneath),
  not gizmo-placed primitives.
- Edits are anchored in bin coordinates. Moving or deleting a model later leaves edits where they
  were painted; lining things up again is the user's responsibility (same stance as printability).
- Multi-step undo and redo, walking the edit list one step at a time.
- A single "Clear all edits" button (with confirmation) removes every manual edit.

## Data model

`CutoutBin` (web/src/engine/plan/types.ts) gains `edits: CavityEdit[]` (ordered, applied in list
order). Discriminated union on `kind`, every branch ends in `assertNever`:

```ts
type CavityEdit =
  | { kind: 'add';     points: Vec3Mm[]; radiusMm: number }
  | { kind: 'remove';  points: Vec3Mm[]; radiusMm: number }
  | { kind: 'flatten'; centerMm: Vec3Mm; radiusMm: number; planeZMm: number }
```

Coordinates are bin-local mm, same frame as `ModelPlacement`. Plan file version goes 8 to 9;
loading a version 8 file defaults `edits` to `[]`. Validation: finite numbers, `radiusMm` within
[0.2, 50], `points` non-empty for strokes; violations produce the existing user-worded plan
validation messages.

## Engine: new module web/src/engine/cutout/cavityEdits.ts

Framework-agnostic, `ManifoldToplevel` injected, like every other engine module.

- Stroke solid: for each consecutive point pair, the convex hull of two spheres (an exact capsule,
  standard CSG construction via Manifold's convex hull); union the segments. A single point is one
  sphere. Sphere circular resolution follows the existing preview facet convention in the cutout
  engine.
- Flatten solid: a cylinder of radius `radiusMm` centered on `centerMm`, spanning from `planeZMm`
  up to the bin top.
- `applyCavityEdits(m, body, binSolid, edits)`: folds edits in order. `remove` and `flatten`
  subtract their solid from the body. `add` unions the stroke solid intersected with `binSolid`
  (the un-carved solid bin body), so Add can only restore material the bin originally had and can
  never grow material outside the bin envelope. `remove`/`flatten` are unrestricted: cutting
  through a wall or the base is allowed and is the user's responsibility, consistent with the
  models-through-walls policy.
- Runs after the model carve inside the cutout build, before the label stage. Result is
  status-checked; an edit that empties the bin entirely is rejected with a user-worded message and
  the edit is not committed.

Stroke polylines are simplified before solid construction with Douglas-Peucker (3D), tolerance
`radiusMm / 4`, bounding solid cost on long mouse paths without changing the painted shape beyond
brush fidelity.

## Worker

- The generate request for a cutout bin carries `edits` alongside the model list.
- Incremental memo: the worker keeps the last carved-and-edited body keyed by (recipe key of
  models and bin, hash of the edit-list prefix). Appending one stroke reuses the memoized body and
  applies only the new edit; undo or any other prefix mismatch falls back to a full rebuild.
  Single-entry memo, same lifetime discipline as the existing swept-solid memo (PinRegistry).
- Edit solids are cheap relative to model preparation, so they are not persisted to IndexedDB;
  only the recipe (plan JSON) persists.

## UI (CutoutTab.vue, CutoutViewport.vue, stores/cutout.ts)

- Toolbar in the cutout tab: Add, Remove, Flatten tool toggle buttons; brush radius as a mm number
  box with steppers (consistent with the clearance box); Undo, Redo, and "Clear all edits" (opens
  a confirm dialog) buttons.
- While a tool is active the transform gizmos are detached and left-drag paints; right-drag and
  wheel keep orbiting the camera. Esc or clicking the active tool button leaves paint mode and
  restores the gizmo.
- Cursor: a translucent sphere (circle for Flatten, with a height indicator) raycast onto the
  displayed bin mesh (three.js Raycaster), sized to the brush radius, so the affected region is
  visible before clicking.
- Add and Remove: pointer down starts a stroke; sampled hit points build the polyline; a ghost
  capsule chain renders on the main thread during the drag (no CSG); pointer up commits the
  stroke to the store, which triggers a worker recarve, same commit pattern as gizmo drag end.
- Flatten: single click; the hit point supplies `centerMm` and `planeZMm`.
- Undo and redo live in the store's editor state: undo pops the last edit onto a redo stack; a
  new stroke clears the redo stack. Clear-all empties the edit list (after confirmation) and
  clears both stacks.

## Errors

- Edit result not manifold or empty: user-worded message shown in the tab, edit rejected, previous
  body kept. No silent drops, no raw exceptions to the UI.

## Testing (Vitest, engine level)

- Capsule stroke solid is watertight; multi-segment stroke is one connected solid.
- `add` increases carved-bin volume, `remove` decreases it, and add never exceeds the un-carved
  bin volume (envelope clamp).
- Flatten yields a flat region: after flatten, no surface of the cavity within the brush circle
  lies above `planeZMm`.
- Edit that empties the bin is rejected with a message.
- Order dependence: add-then-remove differs from remove-then-add on an overlapping pair.
- Plan round-trip: version 9 serialize/validate/merge with edits; version 8 file loads with
  `edits: []`.

## Out of scope

- Vertex-level sculpting, mesh repair, smoothing brushes.
- Gizmo-placed primitive shapes (possible later "precision mode").
- Anchoring edits to models.
