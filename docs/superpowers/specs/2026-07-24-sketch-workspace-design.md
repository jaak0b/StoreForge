# Sketch workspace for tool outlines

Date: 2026-07-24. Status: approved by owner in conversation; this document is the written record.

## Problem

Tool bins currently get their pocket outlines from a photo trace or from an uploaded STL. Some
objects cannot be photographed usefully (tall objects such as bottles cast shadows and distort),
and many users cannot produce an STL. They need a way to construct a precise 2D outline directly
in the app.

## Decision summary

A parametric 2D sketch workspace, in the spirit of the Fusion 360 sketcher, built on the FreeCAD
PlaneGCS constraint solver compiled to WASM (npm package `@salusoft89/planegcs`, LGPL-2.1). A
finished sketch produces the same millimeter outline a photo trace produces and enters the
existing tool pipeline unchanged (placement, outline offset, draft angle, pocket carve, cavity
edits, plate, export). No new bin type. The tool datatype gains an origin discriminator
(photo trace vs sketch), mirroring the established `Bin.origin` pattern, and sketched tools store
their editable `Sketch` so they can be reopened and changed later.

### Solver choice rationale

Researched options: JSketcher (copyright-assignment license, unusable), SolveSpace/libslvs
(GPLv3, dead JS port), hobby solvers (unmaintained), hand-rolled least-squares solver (viable
but we would own convergence bugs and diagnostics). PlaneGCS is the only maintained,
industrial-grade solver with a usable license. LGPL-2.1 obligations are met by shipping the
`.wasm` as a separate replaceable asset (the app already loads all WASM as separate worker
assets) and adding an attribution notice.

## Architecture

### New engine module `web/src/engine/sketch/` (framework-agnostic, convention 3)

- **`model.ts`**: the `Sketch` datatype. Entities: point, line, arc, circle, all in mm, each
  with a construction flag. Constraints: coincident, horizontal, vertical, parallel,
  perpendicular, tangent, symmetric, and dimensions (length, distance, radius/diameter, angle).
  Entities and constraints are discriminated unions handled with exhaustive switches and
  `assertNever` (convention 13). The `Sketch` carries its own small schema version so the sketch
  format can evolve without a full plan version bump each time.
- **`solve.ts`**: adapter mapping a `Sketch` onto PlaneGCS primitives and constraints, running
  the solver, and writing solved coordinates back. Reports solver status to the UI: fully
  constrained, under-constrained (with degrees of freedom), or conflicting (with the offending
  constraints). Dragging a point is expressed as the solver's standard driven-point workflow.
- **`profile.ts`**: extracts the closed outer loop from the solved entities (chained line/arc
  endpoints; a non-construction circle stands alone), flattens arcs at the same tolerance the
  trace pipeline already uses, and returns the same mm outline type traced tools carry.
  Failures are user-worded messages (convention 2): open chain, self-intersecting outline,
  construction-only sketch, multiple disjoint loops.

### Solver placement

PlaneGCS runs in its own small worker (`sketch.worker.ts` beside the existing manifold and
vision workers) so sketch editing never blocks on a running carve and the WASM stays out of the
main bundle. A `sketchClient.ts` mirrors the existing worker client pattern.

### Data model integration

- The traced-tool datatype gains an origin discriminator: photo trace vs sketch. A sketched
  tool embeds its `Sketch`; its outline feeds every downstream stage untouched.
- Plan file: new plan version with validators, following the existing migration pattern.
- Accepted cost: plans that embed sketches are larger than outline-only plans. Worth it,
  because without the stored sketch a saved tool would no longer be editable.

## Editor UI

A sketch workspace inside the tool trace flow. The input step becomes a toggle: upload a photo
or draw the shape. Drawing opens the sketch canvas.

- **Canvas**: SVG, mm coordinate system with grid, pan and zoom following the existing trace
  canvas conventions. The canvas is preview only; all geometry lives in the engine.
- **Tools**: select and drag, line chain, arc (three-point and tangent continuation), circle
  (center plus diameter, the one-click bottle case), construction toggle, mirror line for the
  symmetric constraint.
- **Dimensions**: click one or two entities, type a value (length, distance, radius, diameter,
  angle). Dimension labels render on the canvas and are click-to-edit. The solver runs after
  every edit. Under-constrained geometry is drawn in a distinct color from fully constrained
  geometry; conflicts surface the solver's diagnostics as labeled rows (convention 8).
- **Photo underlay**: optional image upload with an opacity slider, calibrated by drawing one
  reference line over the photo and typing its real length. Display only; never enters
  geometry.
- **Finish**: "Use this shape" validates through `profile.ts` and drops the user into the
  normal tool placement and depth step. Pocket depth is the existing per-placement value.

## V1 scope

Lines and arcs, dimensions and core constraints, full-circle primitive, reference photo
underlay, symmetry and construction lines. Splines and ellipses are out of scope.

## Testing

Engine-level Vitest coverage: model validation and (de)serialization round-trips, solve.ts
against known sketches (dimensioned rectangle, tangent arc chain, symmetric profile,
over-constrained conflict), profile extraction including every user-worded failure, and the
plan version migration. Worker smoke test loading the PlaneGCS WASM in node, following the
existing vision smoke test pattern.
