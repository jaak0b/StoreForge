# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A web app that manages a **print plan of Gridfinity storage bins**. The user queues bins (size in grid
units, label text, hardware icon), previews them in 3D, downloads STL per bin or composes a full build
plate as a 3MF for Orca Slicer (label on a second filament for toolchanger printing), and after a print
session checks off the bins that came out fine; failed bins stay queued. The plan lives in localStorage
with JSON file export/import. A screw-list importer turns a parts list ("m3x20 fhcs, m5x12 bhcs") into
correctly sized, labeled queue entries.

## The app: a Vue 3 web app

Plain web app under `web/` (Vue 3 + TypeScript + Vite + Vuetify + Pinia). **Web is the only target**;
deploys to GitHub Pages. All geometry generation runs in a **Web Worker** using **manifold-3d** (WASM CSG,
guaranteed watertight output), so the page never freezes; the WASM lives only in the worker chunk.

Commands (run inside `web/`):

```bash
npm install
npm run dev       # Vite dev server
npm run build     # vue-tsc typecheck + production build to web/dist
npm test          # Vitest unit tests (manifold WASM loads in node)
```

Structure:

- **`web/src/engine/`**: framework-agnostic modules (no Vue, no Pinia, no DOM). Functions take the loaded
  `ManifoldToplevel` (and opentype `Font` where needed) as parameters so WASM stays out of the main bundle
  and tests can inject it.
  - `gridfinity/`: bin geometry (constants ported from MIT-licensed kennetek/gridfinity-rebuilt-openscad:
    42 mm pitch, 41.5 mm footprint, 7 mm height unit, 0.8/1.8/2.15 mm stacking foot), label shelf,
    `generateLabeledBin -> { body, label }` (separate meshes so 3MF can color the label), STL writer.
  - `label/`: opentype.js text to polygons (adaptive Bezier flattening), SVG path parser, extrusion,
    icon set (`icons.ts`: original side-view fastener silhouettes, viewBox 0 0 100 100).
  - `plan/`: BinEntry model, plan file serialize/validate/merge, screw-list parsing and bin sizing.
  - `plate/` and `threeMf/`: build plate arranging and 3MF writing (fflate zip, Orca per-part extruder
    metadata in `Metadata/model_settings.config`, 1-based slots: body 1, label 2).
- **`web/src/worker/`**: Comlink worker owning the manifold WASM; `web/src/workerClient.ts` is the only
  thing the UI calls for geometry.
- **`web/src/components/`**: pages (QueuePage is home, BinDesignerPage edits one entry, PlatePage,
  ScrewListImportPage) over Pinia stores in `web/src/stores/` (`app` navigation, `binQueue`
  localStorage-persisted plan).
- **`web/tests/`**: Vitest tests (engine-level where possible; helpers load the WASM and font from disk).

Durable gotchas:
- The linked design reference laurensguijt/Label-Generator-Gridfinity is **GPL-3.0**: visual reference
  only, never port its code. Geometry constants come from MIT-licensed kennetek/gridfinity-rebuilt-openscad.
- Icons must be single filled silhouettes (EvenOdd holes allowed, no strokes); stroke-based icon sets
  (Lucide/Tabler) do not extrude.
- Text extrusion uses NonZero fill (TrueType convention; EvenOdd cancels overlapping contours like
  Roboto's "8"); icons use EvenOdd. opentype.js 2.0's string shaper throws on Roboto's GSUB table, so
  glyph paths are assembled per character with kerning.

## Conventions

Numbered for unambiguous reference; do not cite rule numbers in shipped source or UI text.

1. **Geometry integrity.** Gridfinity dimensions come from the published spec/reference implementation,
   named in comments where ported. No hand-tuned fudge factors to make one print look right. Generated
   solids must be watertight (manifold status checked, genus-tested where meaningful); a change to
   geometry code must keep the geometry test suite meaningful and green.

2. **No silently swallowed errors.** A `catch` must surface the error, rethrow, or return a value the
   caller can act on. User-fixable problems (bad import file, unparseable screw shorthand, bins not
   fitting a plate) are returned as user-worded messages, never dropped or thrown as raw exceptions.

3. **Keep the engine framework-agnostic and modular.** Code in `web/src/engine/` must not import Vue or
   Pinia or touch the DOM. New geometry stages, export formats, or importers are their own modules.

4. **Limited AI attribution in git/GitHub.** A `Co-Authored-By: Claude <...>` trailer IS allowed on
   commits. Beyond that trailer, no AI attribution anywhere. Commit messages: a single short sentence.

5. **Commit approval.** The owner granted standing approval to commit at will on `master` (2026-07-16).
   Pushes still require explicit approval.

6. **Never use the em-dash character**, and never a hyphen as a substitute for it. Rewrite with a colon,
   parentheses, a comma, or two sentences. Hyphens only where grammar requires (compound modifiers).

7. **UI text is plain technical prose; terminology is the 3D printing community's.** Complete grammatical
   sentences, neutral register, no clipped fragments. Slicer/firmware terms as the ecosystem names them
   (Orca Slicer, filament, build plate, stacking lip, magnet holes); one term per concept.

8. **Diagnostic readouts show raw values** as labeled rows, not prose sentences.

9. **Never downscale or corrupt exported geometry.** Meshes go to STL/3MF exactly as generated; scaling
   or decimation is allowed only for on-screen preview.

10. **Extend the concept's existing home; never bolt a duplicate beside a symptom.** A figure the codebase
    already derives (pitch, interior size, label sizing) is computed in exactly one engine module; a second
    computation of it anywhere is a defect. Cross-cutting changes land in every consumer, not one flow.

11. **Subagent discipline.** Give every subagent a correct, specific title; never run more than 1 Fable
    agent at a time (hard budget limit). Sonnet is fine for parallel design/research work.

12. **Measurement integrity: established methods only, never a fudge.** Every change to the measurement
    pipeline (sheet/corner detection, perspective rectification and mm scale, segmentation
    post-processing, contour extraction/simplification, outline offsetting and fitting math) must be an
    established, published algorithm or a standard library primitive (OpenCV.js, manifold-3d), chosen
    because it is the correct model for the problem, and named as such (e.g. "Otsu threshold",
    "Douglas-Peucker simplification", "Circle Hough Transform"). NEVER introduce a hand-tuned constant,
    empirical offset, axis "nudge", or bias correction fitted to make one particular scan's numbers look
    right: that overfits the sample and lies on the next one.

**Verification bar.** `npm run build` plus `npm test` green inside `web/` (CI runs the same on push).
Manual browser checks only when the owner asks; exported 3MF must be verified in Orca Slicer by the owner
before the export format is considered proven.
