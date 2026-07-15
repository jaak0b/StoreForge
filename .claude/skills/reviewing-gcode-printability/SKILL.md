---
name: reviewing-gcode-printability
description: Use when adding or changing anything in a coupon G-code generator (a new printed region, raster fill, perimeter, travel/retract logic, line widths, speeds, or layer plan) in web/src/engine/*/gcodeGenerator.ts, before committing the change.
---

# Reviewing G-code Printability

## Overview

A G-code generator change that passes every unit test can still fail on the printer.
Tests check coordinates and E-math; they do not know that a thin line needs something
to anchor into or that a dry nozzle oozes. Before committing, walk the printed result
through this checklist as a physical object, then verify with the numeric recipe.

Every item below comes from a real failed print or slicer-preview defect in this repo.

## Region checklist

For EVERY printed region (existing or new), answer all seven. "Not applicable" is an
answer; silence is not.

| # | Check | Failure it prevents |
|---|-------|---------------------|
| 1 | Does every region boundary that other geometry anchors into have continuous perimeter loops (not a raster sawtooth edge)? | Comb lines pulled out of the rail; print failed |
| 2 | Is every raster inset behind its perimeter loops (outer boundary AND hole/window boundaries)? | Infill printed over the perimeters to the part edge |
| 3 | Do adjacent fill regions share exact boundaries (butt joints), with no unfilled sliver and no double-fill overlap? | 0.84 mm slit gaps at the band corner seams |
| 4 | For a bead width well below the nozzle diameter, was printability confirmed on a real print rather than assumed either way? (0.30 mm on a 0.4 nozzle prints fine on layer 1; it was once misdiagnosed as a failure cause when ooze travels were the real culprit.) | Wrong diagnosis wastes a redesign; the real defect ships |
| 5 | Does anything on layer 1 have enough contact area and low enough speed to stick? | First-layer threads dragged by the nozzle |
| 6 | Where does the nozzle END this region and START the next: is every travel longer than ~5 mm that crosses open (unprinted) area retract-bracketed, including the hop after a layer change and the hop from perimeters to raster start? | Ooze strings across the measured combs; 87-106 mm dry drags |
| 7 | Did you RENDER the generated toolpath to an image and look at it: overall size sane (as small as possible, ideally within a 120 mm bed), every printed bead continuous through corners and joins (no zero-E gap inside a path), nothing poking outside the coupon outline? | A 215 mm coupon, 5 mm extrusion gaps at every corner, and primes outside the outline all shipped past a fully green numeric gate; the owner saw all three in one slicer preview |

## Verification recipe (after the checklist, before the commit)

1. Run the unit suite: `cd web && npx vitest run`.
2. Regenerate the sample coupon with vite-node (default profile + spec) and confirm
   warnings are as expected.
3. Numerically scan the sample for the travel rule: parse G0/G1 positions and retract
   state; assert zero unretracted G0 moves > 5 mm crossing the open window (a Python
   or vite-node scratch script; see the regression test "never travels far across the
   open window" in web/tests/engine/em/gcodeGenerator.spec.ts for the reference logic).
4. If a boundary or fill region changed, numerically confirm coverage: extrusion
   segments exist across the old gap zone, and raster extremes stay inside the
   perimeter inset bounds.
5. State in the commit/report which checklist rows the change touched.

New failure mode found on a real print or in a slicer preview? Add it as a checklist
row in this file (with the failure it caused) as part of the fix commit.

## Red flags

- "The tests pass" as the only verification of a geometry change
- A rasterBase call whose rectangle equals the region outline (no inset)
- A new region emitted without deciding where its perimeters are
- A travel you never traced ("the emitter handles it")
- A bead width chosen by formula without comparing it to the nozzle diameter
