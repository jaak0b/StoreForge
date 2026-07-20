# Baseplate generator: design

Date: 2026-07-20. Status: proposed, awaiting owner approval.

## 1. Summary

The app gains a second family of printable parts: Gridfinity baseplates, the trays a bin's feet drop
into. A new Baseplate tab on the add card sizes a plate in whole grid units (with an optional shortened
last column and last row so a plate fits a drawer that is not a whole number of cells deep), offers base
magnets and screw holes, and offers connectable edges. A connectable plate mates with its neighbour
through a separately printed connection clip, which is queued as its own row. Baseplates and clips flow
through the existing queue, plan file, build plate batching and STL/3MF export paths as ordinary
products. The geometry is a new `web/src/engine/baseplate/` module reimplemented from the MIT reference
profile, with every dimension traced to an existing constant, the MIT reference, or a named measured
file. The plan file version goes from 5 to 6.

Three owner decisions are already folded into this document and are noted at each site where they apply:
magnet dimensions come from our own bin constants rather than the measured reference values; the
connection clip exposes a printer-dependent tolerance; and the queue's row noun generalizes from "bins"
to "parts".

## 2. Scope

### In

- Baseplate size in whole grid units on X and Y.
- Custom size: the last column along X and the last row along Y may be shortened below the pitch.
- Base magnets, None or Full, with pocket diameter and pocket depth exposed as numeric controls.
- Screw holes, None or Full, concentric with the magnet positions, no dimension controls.
- Connectable edges (connector slots on all four outer edges, one per cell per edge).
- The connection clip as a separate product with its own printer-dependent tolerance control.
- STL and 3MF export for both new products, through the existing download and batch paths.
- Preview in the existing 3D viewport.

### Out

- **Grid unit size control.** The pitch is threaded through the geometry as a parameter defaulting to
  42 mm, so a control can be added later without touching geometry, but no UI exposes it and the
  application layer never passes it.
- **A "Show build plate" toggle.** Not built.
- **STEP export.** Not built.
- **GLB export.** Not built.
- **Skeletonized, weighted, or corner-only style variants.** Only the full profile plate is built. The
  reference site's "Full" wording implies other modes exist there; see risk R6.

## 3. Provenance and licensing

gridfinitygenerator.com is closed-source proprietary software operated by Flinck Technologies AB. It
publishes no source repository, no terms of service page, and states no license on the geometry it
exports. No source code from that site was seen, obtained, or used at any point.

What was done instead: eight binary STL files exported from that site were parsed directly and measured.
Measuring an exported mesh yields dimensional fact (a chamfer is 0.70 mm tall, a hole is 3.50 mm across),
not expression. Those facts were then used to confirm which variant of the published Gridfinity baseplate
profile the site implements, and the geometry in this document is written against the MIT-licensed
kennetek/gridfinity-rebuilt-openscad reference and against constants already present in
`web/src/engine/gridfinity/constants.ts`.

Every dimension in section 4 traces to exactly one of three sources, and the dimension table names which:

- an existing constant in this repository,
- the MIT reference implementation,
- a named measured STL file.

Contrast with laurensguijt/Label-Generator-Gridfinity, which is GPL-3.0 and remains a visual reference
only, never a source of code. The same discipline applies here, and more strictly: the reference site
gives no license at all, so nothing but measurement is taken from it.

## 4. Geometry design

### 4.0 Reconciliations across the two design halves

The geometry half and the application half each specified a parameter shape. They are reconciled here
into one definition, used by both.

**Field naming and unit range.** The geometry half proposed `gridX` / `gridY` bounded 1 to 32. The
application half proposed `unitsX` / `unitsY` bounded 1 to 20. **Resolved: `unitsX` / `unitsY`, bounded 1
to 20.** Reasons:

- The app already says "grid units" everywhere a cell count appears (the size caption, `heightUnits`, the
  `4u` filename token). `units` is the term in use; `grid` reads like a coordinate.
- 20 matches the reference site's own UI bound and matches the validator message the user will read.
- Neither bound is measured. 32 buys nothing physical: 20 by 20 is already 840 mm square, past any
  consumer build volume and past any drawer.
- One number, in one place. The bound is exported as `BASEPLATE_UNITS_MAX = 20` from the baseplate
  module; the generator, the plan validator, the numeric fields and the rendered message all bind to it.
  The generator does not hard-code its own bound, so raising the limit is a one-line change.

**Magnets.** The geometry half carried a `magnetHoles: boolean`; the application half needs user-set
diameter and depth. Resolved: one nullable `magnets` object subsumes the boolean. `params.magnets !==
null` is the boolean the generator branches on. The two-field type `BaseplateMagnets` is declared once,
in the baseplate engine module beside its bounds constants, and `web/src/engine/plan/types.ts` imports it
for `BaseplateProduct.magnets`. The type travels with its bounds so the file format and the generator can
never disagree about what a magnet is.

**Custom size.** The geometry half did not cover it; the application half requires it. Resolved in
section 4.7: it is absorbed entirely by the plate outline and clipper dimensions and costs the build
algorithm no new stage.

**Clip parameter type.** The geometry half called it `ConnectorClipParams` with `toleranceMm?` optional;
the application half called it `ClipParams`. Resolved: **`ConnectionClipParams`** with `toleranceMm`
**required**, since the application layer always has a stored value to supply. The default lives in
`CLIP_TOLERANCE_DEFAULT = 0`, used by the store and the validator, not by the generator signature.

**Clip footprint.** The application half asked for `CLIP_WIDTH_MM` and `CLIP_DEPTH_MM` constants. Because
the tolerance now shrinks the clip, the footprint is a function of the parameters, so the geometry module
exports `clipFootprintMm(params)` instead of two constants. This satisfies constraint G2 in its
"unless the footprint is derivable" form.

### 4.1 Provenance of the measurements

Eight binary STLs from gridfinitygenerator.com were parsed directly and measured by slicing, loop tracing
with least-squares circle fitting on corner arcs, and winding-number ray casting.

Validation method: an analytic point-membership model built from the derived spec was compared against
the meshes on a dense probe grid, discounting points within 0.06 mm of a model boundary (the reference
tessellates corner arcs with as few as 4 segments per quarter, sagitta up to 0.051 mm for r = 4).

| Model | Probes | Mismatches |
| --- | --- | --- |
| 1x1-default | 167,445 | 0 |
| 2x2-default | 167,445 | 0 |
| 3x2-default | 167,445 | 0 |
| 2x2-magnets-full | 383,116 | 0 |
| 2x2-screws-full | 383,116 | 0 |

### 4.2 Footprint, height, origin

Measured bounding boxes:

| File | lo | hi | size |
| --- | --- | --- | --- |
| 1x1-default | (-21, -21, 0) | (21, 21, 4.65) | 42 x 42 x 4.65 |
| 2x2-default | (-42, -42, 0) | (42, 42, 4.65) | 84 x 84 x 4.65 |
| 3x2-default | (-63, -42, 0) | (63, 42, 4.65) | 126 x 84 x 4.65 |
| 2x2-magnets-full | | | 84 x 84 x 7.65 |
| 2x2-screws-full | | | 84 x 84 x 7.65 |

Footprint formula: `n * PITCH` exactly. **Not** `n * PITCH - (PITCH - BASE_TOP_SIZE)`. A baseplate is the
tile, not the tenant: it must abut its neighbour on the pitch. This differs from `binOuterSizeMm(cells)`
and must not reuse it.

Z = 0 is the bottom face resting on the build plate. Total height is 4.65 mm without magnets or screws.
With either, the reference is 7.65 mm; **ours is 7.95 mm**, a deliberate divergence explained in
section 4.5.

Plate outline corner radius, fitted to the traced loop at z = 0.0001 and z = 4.6499: 4.0000 mm, residual
0.00000. Equals the existing `OUTER_CORNER_RADIUS = 4.0`, and equals
`BASE_TOP_RADIUS + (PITCH - BASE_TOP_SIZE) / 2 = 3.75 + 0.25`.

### 4.3 Socket profile

Measured section table from `1x1-default.stl` (cavity cross-section):

| z | extent | radius | residual |
| --- | --- | --- | --- |
| 0.0000 | 36.3002 | 1.1501 | 0.00001 |
| 0.3500 | 37.0000 | 1.5000 | 0.00000 |
| 0.7000 | 37.6998 | 1.8499 | 0.00001 |
| 1.5000 | 37.7000 | 1.8290 | 0.00728 |
| 2.5000 | 37.7000 | 1.8500 | 0.00000 |
| 3.5750 | 39.8500 | 2.9250 | 0.00000 |
| 4.6500 | 41.9998 | 3.9999 | 0.00001 |

The z = 1.5000 residual is chord shortening by a 13-point tessellation of the arc; the z = 2.5 ring reads
exactly 1.8500. The z = 0.35 and z = 3.575 rings carry only 12 distinct XY vertices (3 per plate corner)
at every plate size: they are mesh tessellation of the chamfer surfaces at the plate's outer corners, not
a design feature.

Comparison with `buildFoot` (`binGenerator.ts:115-141`), which produces sections 35.60 / 37.20 / 37.20 /
41.50 with radii 0.80 / 1.60 / 1.60 / 3.75 over heights 0.8 / 1.8 / 2.15:

| Quantity | buildFoot | socket | difference |
| --- | --- | --- | --- |
| top size | 41.50 | 42.00 | +0.50 (0.25 per side) |
| top radius | 3.75 | 4.00 | +0.25 |
| vertical-band size | 37.20 | 37.70 | +0.50 (0.25 per side) |
| vertical-band radius | 1.60 | 1.85 | +0.25 |
| bottom size | 35.60 | 36.30 | +0.70 |
| bottom radius | 0.80 | 1.15 | +0.35 |
| lower chamfer | 0.80 | 0.70 | -0.10 |
| vertical | 1.80 | 1.80 | 0 |
| upper chamfer | 2.15 | 2.15 | 0 |
| total height | 4.75 | 4.65 | -0.10 |

Verdict: the socket is our `buildFoot` profile offset outward by exactly 0.25 mm per side, with the lower
chamfer truncated from 0.80 to 0.70. The bottom-size and bottom-radius rows differ by more than 0.25
solely because of that truncation (37.70 - 2 * 0.70 = 36.30; 1.85 - 0.70 = 1.15). There is no shape
difference and no other discrepancy.

The 0.25 mm per side is the Gridfinity footprint clearance already implied by `constants.ts` as
`(PITCH - BASE_TOP_SIZE) / 2`. Confirmation from constants already in the repository: the stacking lip
seat is `LIP_LOWER_TAPER` 0.7, `LIP_SEAT_VERTICAL` 1.8, `LIP_UPPER_TAPER` 1.9, and 1.9 + 0.25 = 2.15. The
baseplate socket is the lip seat opened out by the same 0.25 mm per side.

### 4.4 Construction

At height z, define the rim inset:

```
rim(z) = (UPPER + LOWER) - z          for 0 <= z <= LOWER             (2.85 -> 2.15)
       = UPPER                        for LOWER <= z <= LOWER + VERT   (2.15)
       = UPPER - (z - LOWER - VERT)   above                            (2.15 -> 0)
```

Then:

```
solid(z) = roundedRect(W, D, R_OUT)
         - [ inset(roundedRect(W, D, R_OUT), rim(z)) INTERSECT union of cells sharpSquare(PITCH - 2*rim(z)) ]
```

Two verified facts about corners:

1. Cavity corners are rounded **only** where the cell touches the plate's outer boundary, concentric with
   the plate's outer corner arc. At z = 4.0 the corner-cell cavity arc and the plate outline arc share
   centre (38, 38), with radii 3.35 and 4.00, giving a uniform 0.65 mm rim width around the corner.
2. Internal corners are perfectly sharp. At z = 4.0 the cavity of the (+21, +21) cell starts at x = 0.65
   for every y from 0.7 to 21.0. The internal web is a plain uniform cross of width `2 * rim(z)` with no
   corner star.

The clipper's corner radius follows `R_OUT - rim(z)`: 4 - 2.85 = 1.15, 4 - 2.15 = 1.85, 4 - 0 = 4.00.
Precisely what `loftChain` already computes.

**Low-filament structure.** No floor, no lattice. The plate is nothing but the profile wall, swept around
the perimeter and along every internal grid line.

Solid cross-sectional area by dense integration:

| z | 1x1 (mm2) | 2x2 (mm2) |
| --- | --- | --- |
| 0.0000 | 429.934 | 1758.015 |
| 0.3500 | 384.324 | 1573.826 |
| 0.7000 | 328.226 | 1386.474 |
| 1.5000 | 328.217 | 1386.443 |
| 2.5000 | 328.217 | 1386.443 |
| 3.0000 | 259.298 | 1065.214 |
| 3.5750 | 172.940 | 711.707 |
| 4.0000 | 107.077 | 398.257 |
| 4.5500 | 18.816 | 34.794 |
| 4.6499 | 0.009 | 0.034 |

Wall widths at a cell-centre row (2x2-default, ray along X at y = -21):

| z | perimeter band | internal web |
| --- | --- | --- |
| 0.0000 | 2.8499 | 5.6998 |
| 0.3500 | 2.5000 | 5.0000 |
| 0.7000 to 2.5000 | 2.1500 | 4.3000 |
| 3.0000 | 1.6500 | 3.3000 |
| 3.5750 | 1.0750 | 2.1500 |
| 4.0000 | 0.6500 | 1.3000 |
| 4.5000 | 0.1500 | 0.3000 |
| 4.6499 | 0.0001 | 0.0002 |

Cells are open straight through the bottom; floor thickness is 0 mm. The perimeter band is `rim(z)`; the
internal web is `2 * rim(z)` because two adjacent cells each contribute their rim.

The top rim has zero thickness: at z = 4.65 the socket top square is exactly `PITCH` and the plate outline
is exactly `n * PITCH`, so every rim tapers to a knife edge. This is standard Gridfinity baseplate, not an
artefact; the reference has it too. See risk R1.

Outer edge profile: vertical from z = 0 to z = 4.65 at `n * PITCH`, with a 4.0 mm corner radius. All 45
degree faces are on the inside.

### 4.5 Magnets, screws, boss, and the deliberate divergence from the reference

With magnets and/or screws the plate grows. The extra height is a vertical riser under the socket: the
socket's bottom section (rim 2.85) extruded straight down from the riser top to z = 0. The socket profile
above is unchanged, shifted up by the riser.

Confirmed on the reference by z-level clustering (3.35 / 3.70 / 5.50 / 6.575 / 7.65 = 3.0 + 0.35 / 0.70 /
2.50 / 3.575 / 4.65) and by the constant 2.85 band from z = 0 to z = 3.0.

Measured from `2x2-magnets-full.stl`:

| Quantity | Measured on the reference |
| --- | --- |
| magnet pocket diameter | 6.2000 |
| magnet pocket depth | 2.1000 (z 0.9000 to 3.0000) |
| floor beneath the pocket | 0.9000 |
| XY offset from cell centre | +/- 13.5000 on both axes |
| holes per cell | 4 |
| riser height | 3.0000 |

The pocket is closed at the bottom and opens upward into the socket floor: the magnet is inserted from
inside the socket and the bin's foot bears on it. The 0.9 mm floor prints as the first layers, so there is
no bridging.

Measured from `2x2-screws-full.stl`: diameter 3.5000 constant at z = 0.0, 1.0, 2.0, 2.9999; extent z
0.0000 to 3.0000, open at both ends; no countersink; XY identical to the magnet positions. Concentric
with the magnet holes: in `2x2-magnets-screws-connectable.stl` the two combine into a counterbore, 3.5
through z 0.0 to 0.9 then 6.2 from 0.9 to 3.0.

#### Owner decision: our magnet dimensions, not the reference's

The reference's measured 6.2 / 2.1 / 13.5 are recorded above as measured fact and are **not adopted**. The
plate uses this repository's existing bin constants:

| Constant | Value | Reference measured |
| --- | --- | --- |
| `MAGNET_HOLE_DIAMETER` | 6.5 | 6.2 |
| `MAGNET_HOLE_DEPTH` | 2.4 | 2.1 |
| offset from cell centre, `PITCH/2 - MAGNET_HOLE_FROM_CELL_EDGE` | 13.0 | 13.5 |

Reasoning: a baseplate whose magnets sit 0.5 mm off from the magnets in our own bins would not hold. The
plate and the bin are two halves of one magnetic joint, and the joint is defined by our bins, which are
already in the wild. `MAGNET_HOLE_FROM_CELL_EDGE` stays 8.0 and existing bin geometry is untouched.

Consequences, all deliberate and traceable:

- The riser height is `MAGNET_HOLE_DEPTH + BASEPLATE_MAGNET_FLOOR = 2.4 + 0.9 = 3.3`, not the reference's
  3.0.
- A plate with magnets or screws is `4.65 + 3.3 = 7.95` mm tall, not the reference's 7.65.
- The boss's straight cavity edges run to `13.0 - bossRadius` from the cell centre rather than the
  reference's 9.0.
- The magnet dimension defaults offered in the UI are 6.5 and 2.4, not 6.2 and 2.1.

Because the magnet pocket diameter and depth are user-editable fields, the riser is derived per plate
rather than being a fixed constant:

```
baseplateRiserMm(magnets) =
    0                                                     when there are neither magnets nor screw holes
    (magnets?.heightMm ?? MAGNET_HOLE_DEPTH) + BASEPLATE_MAGNET_FLOOR   otherwise
```

A screws-only plate therefore uses `MAGNET_HOLE_DEPTH + 0.9 = 3.3`, matching a default magnet plate, so a
user can drill or press magnets into a screws-only plate later.

**The boss.** The riser is not a slab: each magnet gets a boss welded into the cell corner. Traced exactly
from the cavity loop at z = 0.5, cell (-21, -21), 80 points. On the reference, straight cavity edges run
only to +/- 9.0000 from the cell centre; beyond that the corner is solid. The boss's reflex corner is a
fillet of radius 4.5000 centred exactly on the magnet centre (13.5, 13.5); sampled arc points sit at
4.5000 from that centre, for example (10.6943, 9.9818) at 4.5000 and (12.4987, 9.1128) at 4.5000.
9.0 = 13.5 - 4.5: the straight edges are the axis-parallel tangents to that circle.

So the boss footprint is the Minkowski sum of a disk of radius `bossRadius` at the magnet centre with the
outward quadrant, clipped to the cell: a corner block with one filleted inner corner. That Minkowski
definition is the normative one; the reference's "12 by 12 mm block" is descriptive only.

Wall around the hole on the reference: 4.5 - 3.1 = 1.4000 mm. Only one magnet configuration was captured,
so the scaling law is unproven (risk R4). Define `BASEPLATE_BOSS_WALL = 1.4` (measured) and derive:

```
bossRadius = magnetDiameter / 2 + BASEPLATE_BOSS_WALL
```

At our default that is `6.5 / 2 + 1.4 = 4.65`, and the straight cavity edges end at `13.0 - 4.65 = 8.35`
from the cell centre. Clearance check at the default: the boss reaches `13.0 + 4.65 = 17.65` from the cell
centre, and the socket cavity at the riser band reaches `21 - 2.85 = 18.15`, so the boss stops 0.50 mm
short of the socket wall. At the maximum magnet diameter of 8.2 the boss radius is 5.5 and it reaches
18.50, which is past 18.15, so the boss merges into the socket wall. That is a union, not a failure, and
produces a thicker corner; nothing is invalid, but a geometry test asserts the plate is still manifold
across the full diameter range.

### 4.6 Connectable

`2x2-connectable.stl` differs from `2x2-default.stl` in 316 added and 60 removed triangles, resolving into
four connected groups, one per outer edge (the 60 removed are re-tessellation of the untouched wall).

The feature is **subtractive**: a slot cut into the perimeter wall. There are no tabs. One slot per cell
per edge, centred on the cell centre, 20.0000 mm long (x = -31.0000 to -11.0000 and 11.0000 to 31.0000 on
a 2x2 whose cell centres are at +/- 21).

Let u be depth measured inward from the plate's outer face. The undisturbed wall inner face is at
u = 2.1500 for z in [0.70, 2.50]. The slot removes material from u = s(z) to the inner face, where the
retained outer skin s(z) is:

| z range | retained skin s(z) | evidence |
| --- | --- | --- |
| 0.0000 to 0.7000 | wall intact | slot floor at z = 0.7000 (vertex ring at z = 0.7) |
| 0.7000 to 1.1000 | 1.0000 | wall section reads solid [41.000, 42.000] |
| 1.1000 to 1.5000 | 1.0000 rising to 1.3000, straight, slope 0.75 | 40.995 / 40.920 / 40.845 / 40.770 / 40.700 at z = 1.107 / 1.207 / 1.307 / 1.407 / 1.507 |
| 1.5000 to 2.0000 | 1.3000 | solid [40.700, 42.000] |
| above 2.0000 | 0, wall removed through its full thickness | void at every z from 2.007 to 4.607 |

The slot floor at z = 0.7000 coincides exactly with the socket profile's lower-chamfer breakpoint.

Butt two plates and the retained skins form a central rib standing on the joint: 20 mm long, 1.3 mm tall
(z 0.70 to 2.00), 2.0000 mm thick at its root, flaring to 2.6000 mm at its head over the z 1.1 to 1.5
ramp. The overhang faces downward at 53.13 degrees from horizontal, so it prints without support. The
pocket around it is `2 * 2.1500 = 4.3000` mm wide, fully open above z = 2.00.

### 4.7 Custom size

The custom span is absorbed entirely by the plate outline and the clipper. The build algorithm gains no
new stage.

```
baseplateSpanMm(units, customMm, pitchMm = PITCH) = (units - 1) * pitchMm + (customMm ?? pitchMm)
```

The plate is centred on the origin, so its bounding box is [-W/2, W/2] by [-D/2, D/2]. Cell i has centre
`x_i = -W/2 + pitchMm * i + pitchMm / 2`, laid out on the full-pitch lattice from the low edge. The last
cell's centre may therefore sit outside the plate by `(pitch - span) / 2`.

Why nothing else changes: the cell cavity union (stage 3) is unchanged, full-pitch squares on the lattice.
The clipper (stage 2) is built from the outline dimensions, so it is already inset by `rim(z)` from the
shortened edge. The single intersection at stage 4 truncates the last column exactly the way it truncates
a corner, and the shortened edge gets the full rim profile automatically. If `customXMm` is smaller than
`rim(z)` the last column contributes no cavity at that height and the plate simply ends in a solid strip,
which is correct.

Magnets, bosses and screw holes in a shortened column or row: a magnet is emitted only when its full boss
circle (centre plus `bossRadius`) lies inside the plate outline; otherwise that magnet, its boss and its
screw hole are all omitted. This is a design rule, not a measurement: the reference site's behaviour with
custom size combined with magnets was not captured. See open question Q1.

### 4.8 Connection clip

`connector.stl` is 76 triangles with every vertex at z = 0 or z = 19.6: a prism 19.6000 mm long over a
20-gon cross-section. Bounding box 4.3000 x 3.6738 x 19.6000.

Profile with v measured up from the bottom face and x from the centreline (chained loop at z = 10,
symmetric about x = 0):

| Feature | Geometry |
| --- | --- |
| bottom face | v = 0, x from +/- 1.0500 to +/- 2.1500 |
| groove mouth | x = +/- 1.0500, v 0 to 0.2500 |
| groove ramp | straight, (+/- 1.0500, 0.2500) to (+/- 1.4500, 0.7830), slope dx/dv = 0.75 |
| groove flank | x = +/- 1.4500, v 0.7830 to 1.3500 |
| groove roof | v = 1.3500, x -1.4500 to 1.4500 |
| body flank | x = +/- 2.1500, v 0 to 1.6500 |
| roof | 45 degrees from (+/- 2.1500, 1.6500) toward a theoretical apex at (0, 3.8000) |
| crest fillet | r = 0.3000, tangent at (+/- 0.2121, 3.5879); 0.3 / sqrt(2) = 0.2121 exactly |

Measured crest 3.6738 against a theoretical 3.6757, the difference being the arc's chord. The ramp is
exactly straight: interpolating (1.0500, 0.2500) to (1.4500, 0.7830) at the sampled x = 1.2541 predicts
v = 0.5219, and 0.5219 is measured.

**Assembly.** Two plates butt outer face to outer face; their aligned slots form one 4.30 mm wide pocket
with the central rib down the middle. The clip is pushed down into the pocket from above, its lips flexing
over the rib's 2.60 mm head and snapping under the shoulder. It is retained against lift-out, and the
pocket walls locate it laterally.

Nominal clearances at tolerance 0, derived by seating the clip's bottom face on the slot floor at
z = 0.70:

| Interface | Plate | Clip | Clearance |
| --- | --- | --- | --- |
| pocket width / body width | 4.3000 | 4.3000 | 0 |
| rib root / groove mouth | 2.0000 | 2.1000 | 0.1000 (0.05 per side) |
| rib head / groove interior | 2.6000 | 2.9000 | 0.3000 (0.15 per side) |
| rib height / groove depth | 1.3000 | 1.3500 | 0.0500 |
| leg pocket / leg width | 1.1500 | 1.1000 | 0.0500 per leg |
| slot length / clip length | 20.0000 | 19.6000 | 0.4000 (0.2 per end) |
| snap interference (lip over head) | | | 0.2500 per side, taken up by flexure |

The clip's roof and the socket's upper chamfer are both 45 degrees. The clip's theoretical apex lands at
z = 4.5000 against the plate's socket apex at z = 4.6500, so the clip sits 0.15 mm below the socket
surface (0.106 mm measured normal to the face) everywhere along its roof and never fouls a seated bin.

#### Owner decision: the clip's tolerance is exposed

`toleranceMm` is a real, user-facing parameter, valid 0 to 0.5, default 0. It is applied **per mating
face, to the clip only, and never to the slot**. Positive values shrink the clip.

Reasoning: snap fits are printer dependent. A user whose clip prints too tight to push in has no other
recourse, since the slot is already in a printed plate they cannot change. Shrinking the clip is the only
correction that does not require reprinting the plate.

Applied concretely: at tolerance t, the clip's body half width becomes `2.1500 - t`, the groove mouth half
width becomes `1.0500 + t`, the groove interior half width becomes `1.4500 + t`, the groove depth becomes
`1.3500 + t`, and the length becomes `19.6000 - 2t`. Every change makes the clip smaller or its groove
larger. The measured plate slot profile is never touched, so a clip printed at any tolerance still fits
the same plate.

### 4.9 Dimension table

`gf` = `web/src/engine/gridfinity/constants.ts`; `bp` = new `web/src/engine/baseplate/constants.ts`.

| Constant | Value | Source | Home |
| --- | --- | --- | --- |
| `PITCH` | 42.0 | existing | gf |
| `BASE_TOP_SIZE` | 41.5 | existing | gf |
| `BASE_TOP_RADIUS` | 3.75 | existing | gf |
| `OUTER_CORNER_RADIUS` | 4.0 | existing; confirmed by fit to 1x1-default.stl, residual 0.00000 | gf |
| `CORNER_SEGMENTS` | 12 | existing | gf |
| `BASEPLATE_LOWER_CHAMFER` | 0.70 | measured 1x1-default.stl; equals existing `LIP_LOWER_TAPER`; MIT baseplate profile | gf |
| `BASEPLATE_VERTICAL` | 1.80 | measured; equals existing `LIP_SEAT_VERTICAL` | gf |
| `BASEPLATE_UPPER_CHAMFER` | 2.15 | measured; equals existing `FOOT_UPPER_CHAMFER` | gf |
| `BASEPLATE_HEIGHT` | 4.65 | derived, sum of the three; matches measured bbox | gf |
| `BASEPLATE_SOCKET_CLEARANCE` | 0.25 | measured (socket top 42.000 against `BASE_TOP_SIZE` 41.5, per side); equals `(PITCH - BASE_TOP_SIZE) / 2` at standard pitch | gf |
| `MAGNET_HOLE_DIAMETER` | 6.5 | existing (reference measured 6.2, **not adopted**) | gf |
| `MAGNET_HOLE_DEPTH` | 2.4 | existing (reference measured 2.1, **not adopted**) | gf |
| `MAGNET_HOLE_FROM_CELL_EDGE` | 8.0 | existing, giving 13.0 from cell centre (reference measured 13.5, **not adopted**) | gf |
| `BASEPLATE_MAGNET_FLOOR` | 0.90 | measured 2x2-magnets-full.stl | bp |
| `BASEPLATE_RISER_HEIGHT` | 3.3 | derived, `MAGNET_HOLE_DEPTH + BASEPLATE_MAGNET_FLOOR` (reference measured 3.0000); the default used when screws are on and magnets are off, and the base case of `baseplateRiserMm` | bp |
| `BASEPLATE_BOSS_WALL` | 1.40 | measured (boss fillet 4.5000 minus reference magnet radius 3.1) | bp |
| `BASEPLATE_SCREW_DIAMETER` | 3.50 | measured 2x2-screws-full.stl | bp |
| `CONNECTOR_SLOT_LENGTH` | 20.00 | measured 2x2-connectable.stl | bp |
| `CONNECTOR_SLOT_FLOOR` | 0.70 | derived, equals `BASEPLATE_LOWER_CHAMFER`; measured 0.7000 | bp |
| `CONNECTOR_RIB_ROOT_SKIN` | 1.00 | measured | bp |
| `CONNECTOR_RIB_HEAD_SKIN` | 1.30 | measured | bp |
| `CONNECTOR_RIB_RAMP_BOTTOM` | 1.10 | measured | bp |
| `CONNECTOR_RIB_RAMP_TOP` | 1.50 | measured | bp |
| `CONNECTOR_RIB_TOP` | 2.00 | measured | bp |
| `CONNECTOR_RAMP_SLOPE` | 0.75 | measured on both mating parts independently | bp |
| `CONNECTOR_LENGTH` | 19.60 | measured connector.stl | bp |
| `CONNECTOR_GROOVE_MOUTH_HALF` | 1.05 | measured | bp |
| `CONNECTOR_GROOVE_HALF` | 1.45 | measured | bp |
| `CONNECTOR_GROOVE_MOUTH_HEIGHT` | 0.25 | measured | bp |
| `CONNECTOR_GROOVE_DEPTH` | 1.35 | measured | bp |
| `CONNECTOR_FLANK_HEIGHT` | 1.65 | measured | bp |
| `CONNECTOR_CREST_RADIUS` | 0.30 | measured (tangent 0.2121 = 0.3 / sqrt(2) exactly) | bp |

`CONNECTOR_HALF_WIDTH` is **derived, not stored**: it equals `BASEPLATE_UPPER_CHAMFER` (2.15) because the
pocket is the wall's vertical-band thickness. Storing 2.15 twice would be the duplicate that rule 10
forbids.

Bounds and defaults exported for the application layer (constraint G3):

| Constant | Value | Note |
| --- | --- | --- |
| `BASEPLATE_UNITS_MAX` | 20 | reconciled bound, section 4.0 |
| `CUSTOM_SPAN_MIN` | 1 | mm |
| `MAGNET_DIAMETER_MIN` | 2 | mm |
| `MAGNET_DIAMETER_MAX` | 8.2 | mm |
| `MAGNET_DIAMETER_DEFAULT` | `MAGNET_HOLE_DIAMETER` (6.5) | re-exported, not a copied literal |
| `MAGNET_HEIGHT_MIN` | 1 | mm |
| `MAGNET_HEIGHT_MAX` | 4 | mm |
| `MAGNET_HEIGHT_DEFAULT` | `MAGNET_HOLE_DEPTH` (2.4) | re-exported, not a copied literal |
| `CLIP_TOLERANCE_MIN` | 0 | mm |
| `CLIP_TOLERANCE_MAX` | 0.5 | mm |
| `CLIP_TOLERANCE_DEFAULT` | 0 | mm |

The two magnet defaults are re-exports of the bin constants rather than new numbers, which is what makes
owner decision 1 structural rather than a coincidence of equal values: the default plate magnet is by
definition the bin's magnet.

### 4.10 Build algorithm

New module `web/src/engine/baseplate/`, a sibling of `gridfinity/` (rule 3). It imports dimensions from
`gridfinity/constants.ts` and shape primitives from `gridfinity/`.

**Prerequisite refactor (pure move, no behaviour change).** `hullBetween`, `insetPolygon` and `loftChain`
are module-private in `binGenerator.ts`. Extract them, together with the already-exported
`roundedRectPolygon`, into `web/src/engine/gridfinity/shapes.ts`; `binGenerator.ts` imports them back. One
home shared by bin and baseplate rather than a parallel copy.

**Prerequisite extension to `loftChain`.** Add two optional trailing parameters, `cornerRadius =
OUTER_CORNER_RADIUS` and `segments = CORNER_SEGMENTS`. Existing call sites are unchanged. This lets the
same helper emit both the rounded clipper and the sharp cell squares instead of a second lofting function.

| # | Stage | Helper |
| --- | --- | --- |
| 1 | Plate outline: `roundedRectPolygon(W, D, OUTER_CORNER_RADIUS)` extruded to `riserHeight + BASEPLATE_HEIGHT`, where W and D come from `baseplateSpanMm` | `roundedRectPolygon` + `Manifold.extrude` |
| 2 | Socket clipper: `loftChain(m, W, D, [{2.85, -eps}, {2.85, riser}, {2.15, riser+0.70}, {2.15, riser+2.50}, {0, riser+4.65}, {-eps, riser+4.65+eps}])`. Corner radii fall out as `OUTER_CORNER_RADIUS - inset`, giving 1.15 / 1.85 / 4.00, exactly the measured table. `insetPolygon` is deliberately **not** used: `loftChain` already produces the offset sections analytically, and routing them through a Clipper offset would only add tessellation error | `loftChain` (extended) |
| 3 | Cell cavities: for each cell, `loftChain(m, pitch, pitch, sameSections, 0, 0)` (corner radius 0, segments 0, giving four sharp corners) translated to the cell centre. Union them | `loftChain` (extended), `hullBetween` |
| 4 | Cavity: `union(cellCavities) INTERSECT clipper`. One intersection for the whole plate. This single operation is what produces rounded corners at the plate boundary and sharp ones internally, and it is also what truncates a custom-size last column | `Manifold.intersect` |
| 5 | Subtract: `plate = outline - cavity` | `Manifold.subtract` |
| 6 | Magnet bosses (when magnets or screws are on): per magnet, `union(cylinder(riser, bossR), box(strip_x), box(strip_y))` (the Minkowski sum of the disk with the outward quadrant) clipped to its cell, unioned into the plate. Only the 4 corner magnets of each cell, and only those whose boss circle lies inside the outline | `Manifold.cylinder`, `Manifold.cube` |
| 7 | Screw holes (when enabled): cylinder of diameter `BASEPLATE_SCREW_DIAMETER`, z from -eps to riser+eps, at every emitted magnet position | `Manifold.cylinder` |
| 8 | Magnet pockets (when enabled): cylinder of diameter `magnets.diameterMm`, z from `riser - magnets.heightMm` to `riser + eps`, at every emitted magnet position | `Manifold.cylinder` |
| 9 | Connector slots (when enabled): per outer edge, per cell along it, a prism of the (u, z) slot profile `CONNECTOR_SLOT_LENGTH` long centred on the cell, subtracted. Built with `prismFromProfile` (already exported from `binGenerator.ts:436`) and rotated to the edge | `prismFromProfile` |

Every stage is convex-hull or CSG on watertight solids, so manifold status is preserved throughout. The
eps extensions exist only outside the retained volume and never alter a measured dimension.

**Pitch threading.** `pitchMm` is a `BaseplateParams` field defaulting to `PITCH`, passed down and never
read from the constant at a call site. Two things must **not** be keyed to pitch, because bins do not
resize when a plate's pitch changes:

- the socket profile, which is keyed to `BASE_TOP_SIZE + 2 * BASEPLATE_SOCKET_CLEARANCE`;
- the magnet positions, keyed to the bin's own `PITCH / 2 - MAGNET_HOLE_FROM_CELL_EDGE`.

At pitch 42 the socket top is 42.000 and the rim vanishes at the top, reproducing the reference exactly.
At a larger pitch a real top rim appears, which is physically correct. See risk R2.

### 4.11 Reconciled types

```ts
/** Magnet pocket dimensions. Declared once, beside its bounds; the plan layer imports it. */
export interface BaseplateMagnets {
  /** Magnet pocket diameter in mm, MAGNET_DIAMETER_MIN to MAGNET_DIAMETER_MAX. */
  diameterMm: number;
  /** Magnet pocket depth in mm, MAGNET_HEIGHT_MIN to MAGNET_HEIGHT_MAX. */
  heightMm: number;
}

export interface BaseplateParams {
  /** Cells along X, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsX: number;
  /** Cells along Y, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsY: number;
  /** Length of the last column along X in mm, or null when it keeps the full pitch. */
  customXMm: number | null;
  /** Depth of the last row along Y in mm, or null when it keeps the full pitch. */
  customYMm: number | null;
  /**
   * Grid pitch in mm: centre-to-centre cell spacing and the plate's footprint per cell.
   * Defaults to PITCH, valid 41.5 to 60. Not exposed in the UI; threaded so a control can be
   * added without touching geometry.
   */
  pitchMm?: number;
  /** Magnet pockets in every cell corner, opening into the socket floor, or null for none. */
  magnets: BaseplateMagnets | null;
  /** Through screw holes concentric with the magnet positions. */
  screwHoles: boolean;
  /** Connector slots on all four outer edges, one per cell per edge. */
  connectable: boolean;
}

export interface ConnectionClipParams {
  /**
   * Extra clearance in mm applied per mating face, added to the nominal fit measured from
   * connector.stl. 0 reproduces the nominal fit; valid CLIP_TOLERANCE_MIN to CLIP_TOLERANCE_MAX.
   * Positive values shrink the clip; the plate's slot is never altered.
   */
  toleranceMm: number;
}
```

`ConnectionClipParams` is separate from `BaseplateParams` because the clip is a separately printed part
with its own export path, exactly as the label insert is separate from the bin.

Exported functions:

```ts
export function baseplateSpanMm(units: number, customMm: number | null, pitchMm?: number): number;
export function baseplateRiserMm(magnets: BaseplateMagnets | null, screwHoles: boolean): number;
export function clipFootprintMm(params: ConnectionClipParams): { widthMm: number; depthMm: number };
export function generateBaseplate(m: ManifoldToplevel, params: BaseplateParams): Manifold;
export function generateConnectionClip(m: ManifoldToplevel, params: ConnectionClipParams): Manifold;
```

### 4.12 Geometry test plan

New file `web/tests/baseplate.spec.ts`, in the style of `binGenerator.spec.ts` (`loadManifold()`, assert
`status()`, `genus()`, `boundingBox()`, probe-cube intersection volumes, always `.delete()`).

1. **Integrity.** For each of 1x1, 2x2, 3x2 and each of the eight on/off combinations of magnets, screws
   and connectable, `status() === 'NoError'`. This is the assertion that catches the knife-edge pinch
   (R1) regressing into a broken mesh.
2. **Bounding box.** An `unitsX` by `unitsY` plate is exactly `[unitsX*pitch, unitsY*pitch, 4.65]`, and
   `[.., .., 4.65 + riser]` with magnets or screws, where riser is 3.3 at the defaults. Catches any drift
   back to `binOuterSizeMm`.
3. **Genus.** A plain `unitsX` by `unitsY` plate has `genus() === unitsX*unitsY - 1`. Each through-cell
   adds a handle to the frame. Catches an accidental floor, a merged cell, or a cavity that fails to
   break through.
4. **Socket profile mating probe.** Place `buildFoot(m)` at the flush seating depth (foot top at plate
   z = 4.40, translate z by -0.35) in each cell. Assert `intersect(foot, plate).volume() === 0` when the
   foot is lifted 0.05 mm (z = -0.30), and `> 0` when pushed 0.10 mm deeper (z = -0.45). Two-sided: it
   fails if the socket is too tight or too loose, and it is stated in terms of `buildFoot`'s own output so
   the two can never drift apart. Would have caught a wrong clearance, a wrong chamfer, or a mirrored
   profile.
5. **Section widths.** Intersect the plate with a thin slab at z in {0.001, 0.70, 2.50, 4.60} and assert
   the cavity's clear extent at a cell centre equals 36.30 / 37.70 / 37.70 / 41.90 within 1e-3. Direct
   regression on the measured table.
6. **Internal-corner sharpness.** A 0.2 mm probe cube at the internal-corner point of a 2x2 at z = 4.0
   (offset just inside the sharp corner) intersects the plate with volume 0; a cube just outside
   intersects with full volume. Catches a rounded internal corner, which no bounding-box test would see.
7. **Magnet pockets.** A probe cylinder at each of the `4 * unitsX * unitsY` magnet positions, of diameter
   `magnets.diameterMm - 0.2` spanning the pocket, has zero intersection with the plate; a ring probe just
   outside diameter `magnets.diameterMm + 0.2` is fully solid. Same pattern as
   `binGenerator.spec.ts:185-199`.
8. **Magnet positions.** Assert `PITCH/2 - MAGNET_HOLE_FROM_CELL_EDGE` (13.0) from the cell centre, so a
   plate magnet can never drift from a bin magnet. This is the test that enforces owner decision 1.
9. **Pocket floor.** A probe cube under a magnet pocket (z 0 to the floor) is fully solid with magnets
   alone and fully void with screws enabled.
10. **Connector slot.** With connectable on, the outer wall at a cell centre is void for z in [2.1, 2.4],
    and solid at the same point with connectable off.
11. **Rib thickness.** The rib is 1.00 thick at z = 0.9 and 1.30 at z = 1.8, measured by probe-slab
    intersection volume.
12. **Clip.** `status() === 'NoError'`, bounding box exactly `[4.30, 3.6738, 19.60]` within 1e-3 at
    tolerance 0, `genus() === 0`.
13. **Assembly probe.** Build two 1x1 connectable plates translated to abut, union them, and assert
    `intersect(clip.placedInSlot(), platePair).volume() === 0` at tolerance 0 with the clip lifted 0.02 mm.
    Also assert the clip is **not** free of the rib: intersect the clip's groove volume with the rib and
    assert it is non-empty, so a clip that no longer engages fails. The only test that proves the two
    parts actually mate.
14. **Custom size (added in reconciliation).** A 4 by 2 plate with `customXMm = 30` has bounding box
    exactly `[156.0, 84.0, 4.65]`, is manifold, and its last column's cavity is truncated: a probe at the
    shortened edge finds the full rim profile rather than an open cavity.
15. **Magnet omission on a shortened cell (added in reconciliation).** On a plate whose custom span is too
    short to contain a boss circle, no magnet pocket, boss or screw hole is emitted outside the outline,
    and the plate remains manifold.
16. **Clip tolerance (added for owner decision 2).** At `toleranceMm = 0.3`, the clip's bounding box
    width is `4.30 - 0.6 = 3.70` and its length is `19.60 - 0.6 = 19.00`; the plate slot generated for the
    same plate is byte-identical to the tolerance-0 case, proving the tolerance never leaks into the
    plate. Also assert the assembly probe from test 13 still shows groove-to-rib engagement at
    `CLIP_TOLERANCE_MAX`, so the maximum tolerance still produces a clip that grips.
17. **Manifold across the magnet range.** A 2x2 plate at `MAGNET_DIAMETER_MAX` (where the boss merges into
    the socket wall, section 4.5) is still `status() === 'NoError'`.

## 5. Application-layer design

### 5.1 Corrections to the original brief, verified against source

- `PLAN_FILE_VERSION` is already 5 at `web/src/engine/plan/types.ts:357` (version 5 introduced free
  divider walls, replacing `dividerCountX`/`dividerCountY`). The bump is 5 to 6. The current-shape read
  path already covers 3, 4 and 5; the legacy flat path covers 1 and 2.
- `previewBinParams` at `web/src/engine/plan/geometry.ts:98` is exported but has **no** production call
  site (only `web/tests/plan/geometry.spec.ts:53`). It still needs a new branch to compile, since it
  switches with `assertNever`, but it is not on the baseplate preview path. It returns null for the new
  kinds.
- `MoreOptions.vue` is hard-wired to `useBinDesigner` through `storeToRefs` (`MoreOptions.vue:39`) and
  renders `DividerEditor`, the magnet-holes switch and the label-line field. The baseplate panel must
  **not** reuse it.

Everything else checked out: there is no router (`App.vue:131` renders `MainPage` unconditionally),
`TAB_OF_KIND` is at `AddBinCard.vue:21`, the Comlink api object is at `geometry.worker.ts:67`, the
`useBinPreview` ticket and debounce are at `useBinPreview.ts:28` and `:52`, `partsOf` is at
`geometry.ts:50`, `fileStem` is at `binDownloads.ts:89`.

### 5.2 Data model

Added to `web/src/engine/plan/types.ts` after `InsertProduct` (around line 214).

`BaseplateMagnets` is **imported** from the baseplate engine module rather than redeclared here (section
4.0), with a doc comment explaining that null on the product means the plate has none, so a plate without
magnets carries no dimensions at all rather than dead ones.

```ts
interface BaseplateProduct {
  kind: 'baseplate';
  /** Cells along X, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsX: number;
  /** Cells along Y, integer 1 to BASEPLATE_UNITS_MAX. */
  unitsY: number;
  /**
   * Length of the last column along X in mm, or null when it keeps the full pitch.
   * Above 0 and at most the pitch. Total width is (unitsX - 1) * pitch + (customXMm ?? pitch).
   */
  customXMm: number | null;
  /** Depth of the last row along Y, same range and meaning. */
  customYMm: number | null;
  magnets: BaseplateMagnets | null;
  screwHoles: boolean;
  connectable: boolean;
}
```

Doc comment on the product: a queue row that orders a Gridfinity baseplate, the tray a bin's feet drop
into. Sized in whole grid units, except that the last column and the last row may be shortened so the
plate fits a drawer that is not a whole number of cells deep. Only those two may shrink: every interior
cell keeps the full pitch, because a bin has to seat in each of them.

```ts
interface ConnectionClipProduct {
  kind: 'clip';
  /**
   * Extra clearance in mm applied per mating face to the clip only, never to the plate's slot.
   * Valid CLIP_TOLERANCE_MIN to CLIP_TOLERANCE_MAX; CLIP_TOLERANCE_DEFAULT (0) is the nominal fit.
   * Raise it when the clip prints too tight to push into the joint.
   */
  toleranceMm: number;
}
```

**Owner decision 2 applied:** `ConnectionClipProduct` is not field-free. It carries `toleranceMm`. The
clip's geometry does not depend on any baseplate option: it has its own independent tolerance parameter,
which is the whole of its configurability.

`Product` becomes `BinProduct | BinWithInsertProduct | InsertProduct | BaseplateProduct |
ConnectionClipProduct`.

Design points:

- `customXMm` is `number | null`, not a plain number, because storing 42 when the user has not asked for a
  custom size makes "full pitch" and "custom size that happens to equal the pitch" indistinguishable in
  the file, and freezes today's 42 mm into every stored plan. Null means "the pitch, whatever the pitch
  is", the only representation that survives the pitch becoming configurable.
- Same argument for magnets: `BaseplateMagnets | null` beats a `magnetMode` flag plus always-present
  dimensions.
- No `origin` field on either product. `BinProduct` derives its origin from `bin.origin` and
  `InsertProduct` carries one because two different tabs produce the same kind, but kind `'baseplate'`
  implies origin `'baseplate'` and kind `'clip'` implies origin `'clip'`, so `originOf` returns the
  literal. This removes a stored field, a validator, and a whole class of "kind and origin disagree"
  invalid file.

`ProductOrigin` becomes `'manual' | 'screw' | 'traced' | 'baseplate' | 'clip'`. Its doc comment updates to
say origin names the tab that owns the product's edit, and that baseplate and clip are both edited on the
Baseplate tab, which `TAB_OF_KIND` collapses.

Three exhaustive switches gain branches (all already end in `assertNever`, so the compiler finds them):
`insertOf` (`types.ts:232`) gets `case 'baseplate': case 'clip': return null`; `binOf` (`types.ts:246`)
the same; `originOf` (`types.ts:266`) returns the literals. `binOf` returning null is what keeps
`traceSources.referencedTraceSourceIds` (`traceSources.ts:29`) correct with **zero** change: a baseplate
has no bin, so it references no trace photo.

### 5.3 Plan file version

`PLAN_FILE_VERSION` goes 5 to 6; `PlanFile.version` becomes 6 and its doc comment updates.

The bump is genuinely required, not ceremonial: a build shipping version 5 that reads a file containing a
baseplate hits `validateProduct`'s final return and rejects the **entire** plan. The version number is
what lets that reader say "this file is newer than I understand" instead.

How versions 1 to 5 are read: **no new legacy path is written.** The guard at `planFile.ts:1088-1098`
compares against `PLAN_FILE_VERSION`, so raising the constant widens the accepted range automatically, and
the error string it produces also updates automatically. `const legacy = version === 1 || version === 2`
at `planFile.ts:1107` is untouched. Versions 3, 4, 5 and 6 all go through `validateEntry` and `pickEntry`
unchanged; a version 3, 4 or 5 file simply contains no baseplate rows, so the new validator branches are
never reached. `legacyProductOf` (`planFile.ts:880`) needs **no** baseplate branch, since no version 1 or
2 file can contain one. Only the explanatory comment at `planFile.ts:1102-1106` changes.

### 5.4 Recommendation on a shared queue-item interface

Do not extract one. It is speculative and would not remove any duplication that exists.

`QueueEntry` (`types.ts:287`) is exactly the row-level interface already, holding `id`, `quantity`,
`createdAt`, `notes` and `product`. A baseplate row needs none of those fields to differ. The `Product`
union members share no fields either: `BinProduct` and `BinWithInsertProduct` share `bin`, but that
commonality is already factored into the `Bin` type; `BaseplateProduct` shares nothing with any of them,
because a baseplate has no height units, no walls, no label and no stacking lip. An interface over "things
a queue row can order" would have exactly one member (`kind`), which the discriminated union already
provides and which TypeScript already exhaustiveness-checks through `assertNever`.

There is one real duplication in the new type, and it is much smaller: `unitsX` / `customXMm` and `unitsY`
/ `customYMm` are the same two-field concept twice. Do **not** extract even that into an `AxisExtent`
interface: it would nest the plan JSON one level deeper for a two-field saving, and flat scalar fields are
the shape every other product in this file uses. The pair is instead unified at the **derivation** site,
which is where rule 10 actually bites: one function `baseplateSpanMm(units, customMm, pitchMm)`, called
once per axis by the geometry generator, the store getter and `partFootprint`. That is the single source
that matters, and it is one function rather than one interface.

### 5.5 Validation

All in `web/src/engine/plan/planFile.ts`. New import: `import { PITCH } from '../gridfinity/constants'`.
`planFile.ts` already imports from `../gridfinity/dividerModel` at line 17, so reaching into geometry
constants is established. Interpolating `PITCH` into the message and the bound means the validator and the
generator agree on one number and no `42` literal appears in `planFile.ts`.

New helper beside `isPositiveInteger` (`planFile.ts:41`):

```ts
function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
```

`validateMagnets(raw, subject)` returns null if `raw === null` (valid, meaning no magnets); returns
`` `${subject}: magnets must be an object or null` `` if it is not an object or is an array; returns
`` `${subject}: magnet diameterMm must be a number from ${MAGNET_DIAMETER_MIN} to ${MAGNET_DIAMETER_MAX}` ``
and
`` `${subject}: magnet heightMm must be a number from ${MAGNET_HEIGHT_MIN} to ${MAGNET_HEIGHT_MAX}` ``
on range failures. `pickMagnets` returns null or `{ diameterMm, heightMm }`.

The four bounds are **not** literals: they are exported from the geometry layer (section 4.9) and the UI's
slider min and max bind to the same four constants. One source, so the form cannot offer a value the file
format rejects.

`validateBaseplate(raw, subject)` checks in order: `unitsX` integer 1 to `BASEPLATE_UNITS_MAX`, `unitsY`
the same, `customXMm` null or in `[CUSTOM_SPAN_MIN, PITCH]`, `customYMm` the same, then `validateMagnets`,
then `screwHoles` boolean, then `connectable` boolean.

`validateClip(raw, subject)` checks `toleranceMm` is a number in
`[CLIP_TOLERANCE_MIN, CLIP_TOLERANCE_MAX]`.

Rendered messages, verbatim:

| Failure | Message |
| --- | --- |
| `unitsX` not an integer 1 to 20 | `entry 7f3a: unitsX must be an integer from 1 to 20` |
| `unitsY` not an integer 1 to 20 | `entry 7f3a: unitsY must be an integer from 1 to 20` |
| `customXMm` out of range or wrong type | `entry 7f3a: customXMm must be a number from 1 to 42, or null for a full grid cell` |
| `customYMm` out of range or wrong type | `entry 7f3a: customYMm must be a number from 1 to 42, or null for a full grid cell` |
| `magnets` neither object nor null | `entry 7f3a: magnets must be an object or null` |
| `magnets.diameterMm` bad | `entry 7f3a: magnet diameterMm must be a number from 2 to 8.2` |
| `magnets.heightMm` bad | `entry 7f3a: magnet heightMm must be a number from 1 to 4` |
| `screwHoles` not boolean | `entry 7f3a: screwHoles must be true or false` |
| `connectable` not boolean | `entry 7f3a: connectable must be true or false` |
| `toleranceMm` bad (clip) | `entry 7f3a: toleranceMm must be a number from 0 to 0.5` |
| unknown kind | `entry 7f3a: product kind must be bin, binWithInsert, insert, baseplate or clip` |

These reach the user through the existing wrapper at `planFile.ts:1114`: "The plan is invalid: entry 7f3a:
unitsX must be an integer from 1 to 20."

Note that `customXMm` is required to be **present** (as a number or an explicit null), unlike the
tolerated-absent fields such as `labelSlot` and `fused`. Those are absent-tolerant because older files
predate them. No older file contains a baseplate at all, so requiring the field costs nothing and catches
a truncated write. The same reasoning makes `toleranceMm` required on a clip.

**Wiring.** In `validateProduct` (`planFile.ts:582`), before the final return, add the baseplate branch and
the clip branch. In `pickProduct` (`planFile.ts:626`), before the insert fallthrough, add the baseplate
field-by-field copy and the clip copy:

```ts
if (raw.kind === 'clip') return { kind: 'clip', toleranceMm: raw.toleranceMm };
```

`pickBaseplate` copies field by field, matching the established copy-only-known-fields discipline: an
unknown extra key in an imported file is dropped, not carried into localStorage.

`serializePlanFile`, `mergeEntries` and `mergeBatches` (`planFile.ts:1150-1182`) need **no** change: they
are product-agnostic and key on `id` only.

### 5.6 Store design

Recommendation: a new `useBaseplateDesigner` store, not an extension of `useBinDesigner`.

`useBinDesigner` (`stores/binDesigner.ts`) is 167 lines, of which roughly 120 are bin- and
divider-specific: `heightUnits`, `walls`, `selectedWallIndex`, `snapEnabled`, the label triplet, `fused`,
`hasLabel`, `binParams`, `selectedWall`, and ten thin wrappers over `dividerModel`. A baseplate shares
none of it. Folding baseplate fields in would mean `$reset` clearing state the active tab does not own,
`binParams` computing over fields a baseplate never sets, and the Baseplate tab importing a store whose
actions are all divider-wall mutations. Separate store, same idiom.

`web/src/stores/baseplateDesigner.ts` state:

```ts
{
  unitsX: 2,
  unitsY: 2,
  /**
   * Whether the last column and row are shortened. Form-only: when off, the product stores null
   * spans, so "full pitch" is never persisted as the literal pitch.
   */
  customSize: false,
  customXMm: PITCH,
  customYMm: PITCH,
  magnetMode: 'none' as HoleMode,
  magnetDiameterMm: MAGNET_DIAMETER_DEFAULT,  // 6.5, owner decision 1
  magnetHeightMm: MAGNET_HEIGHT_DEFAULT,      // 2.4, owner decision 1
  screwHoleMode: 'none' as HoleMode,
  connectable: false,
  notes: '',
}

type HoleMode = 'none' | 'full';
```

Getters: `spanX` returns `customSize ? customXMm : null` (the single collapse); `spanY` the same;
`magnets` returns `magnetMode === 'full' ? { diameterMm, heightMm } : null` (the single collapse);
`product` returns the full `BaseplateProduct` built from those; `params` returns
`baseplateParamsOf(this.product)`; `widthMm` returns `baseplateSpanMm(unitsX, spanX)`; `depthMm` returns
`baseplateSpanMm(unitsY, spanY)`.

**Deliberate deviation from `useBinDesigner`.** `ManualBinTab.vue:127` builds its product in a local
`designedProduct()` function while `binDesigner` exposes `binParams` separately, which splits the mapping
in two: the tab decides what the product is and the store decides what the geometry is, and the two can
drift (they already almost do around `fused`). Here `product` lives on the store and `params` derives
**from** `product` through `baseplateParamsOf`, the same function `partsOf` uses. That makes the preview
provably show what the queue row will export, without the tab restating anything. Exactly one place a form
value becomes a stored field, and exactly one place a stored field becomes a geometry parameter.
`baseplateParamsOf(product)` lives in `web/src/engine/plan/geometry.ts` beside `toSlottedBinParams`, since
that module is documented as the single mapping from the plan layer's `Product` to the geometry layer's
parameter shapes.

The clip is **not** in this store. Its two fields (quantity and tolerance) are component-local refs in the
tab, for the reasons in section 5.7.

**Existing store actions need no change.** `binQueue` `add` / `update` / `duplicate` / `remove` /
`createBatch` / `renameBatch` / `confirmBatchItem` / `confirmAll` / `failBatchItem` / `exportJson` /
`importJson` / `persist` / `sweepStoredPhotos` all take or move a `Product` opaquely; `duplicate` deep
copies through JSON, which a baseplate survives since it is plain scalars; `sweepStoredPhotos` is safe
because `binOf` returns null. `app.editEntry(entryId, kind: ProductOrigin)` needs no change to its body:
the `ProductOrigin` widening flows through the existing signature. `app.focusAddCard`, `stopEditing`,
`binDesigner` and `toolTrace` are all unchanged. That a queue holding a genuinely different product type
needs zero queue-store changes is the payoff of the existing product-opaque design, and is worth stating
as evidence the extension is landing in the right place.

### 5.7 UI

**`AddBinCard.vue` edits.** `type TabName = 'manual' | 'screw' | 'trace' | 'baseplate'` (line 18);
`TAB_OF_KIND` becomes `{ manual: 'manual', screw: 'screw', traced: 'trace', baseplate: 'baseplate', clip:
'baseplate' }` (line 21), since both baseplate rows and clip rows are edited on the Baseplate tab. Because
`TAB_OF_KIND` is typed `Record<ProductOrigin, TabName>`, widening `ProductOrigin` in `types.ts` makes this
file **fail to compile** until both new origins are mapped: the intended safety net. The template gains a
`v-tab value="baseplate"` after the Tool bin tab (line 46) and a `v-window-item value="baseplate"` holding
`<BaseplateTab />` after line 63. `tabDisabled` (line 36) needs **no** change: with `clip` mapped to
`'baseplate'`, editing a clip row disables Manual, Screw and Tool bin and leaves Baseplate enabled,
exactly right. The Ctrl+N watcher (line 28) needs no change; it already falls back to `'manual'`.

**New component `web/src/components/BaseplateTab.vue`.** Two-column `v-row` / `v-col cols="12" md="6"`
matching `ManualBinTab.vue:203-319`, including the `smAndDown` deferred-preview card, so the two tabs feel
identical.

Left column, top to bottom:

1. Caption "Baseplate size (grid units of 42 mm)", then a `d-flex ga-2` row of two `v-text-field
   type="number" min="1" max="20" step="1"` labelled Width and Depth, separated by a multiplication sign,
   mirroring `ManualBinTab.vue:211-242`.
2. A `v-switch` labelled "Custom size" (`color="primary" density="compact" hide-details`), matching the
   magnet-holes switch at `MoreOptions.vue:81`.
3. A `v-expand-transition` wrapping the two custom-span fields, `v-if="store.customSize"`, the disclosure
   idiom already used for More options at `MoreOptions.vue:52`. Two `v-text-field type="number" step="0.1"`
   labelled "Last column width (mm)" and "Last row depth (mm)", each with `:min="1"` and `:max="PITCH"`
   and a hint. Below them a diagnostic readout (rule 8) as labelled rows, not prose, showing "Total width
   156.0 mm" and "Total depth 84.0 mm", bound to `store.widthMm` and `store.depthMm`. This also replaces
   the reference site's absolute Custom X range with a relative field plus a total readout, which is
   easier to reason about and keeps the field's own bounds independent of `unitsX`.
4. Caption "Base magnets", then a `v-btn-toggle mandatory density="comfortable" variant="outlined"` with
   `v-btn value="none"` None and `v-btn value="full"` Full bound to `store.magnetMode`, the segmented
   pattern from `LayoutWorkspace.vue:382`.
5. A `v-expand-transition` wrapping the two magnet dimensions, `v-if="store.magnetMode === 'full'"`. Each
   is a `v-slider` with `thumb-label="always"` and `:min` / `:max` / `:step` bound to the shared
   constants, plus an append slot holding a narrow `v-text-field` for exact entry: "Magnet diameter (mm)"
   2 to 8.2 step 0.1, default 6.5; "Magnet height (mm)" 1 to 4 step 0.1, default 2.4. Sliders rather than
   bare number fields because both are continuous fit parameters where the user wants to feel the range;
   the paired field keeps exact entry available.
6. Caption "Screw holes", then the same `v-btn-toggle` None / Full bound to `store.screwHoleMode`, with no
   sub-controls, since the reference exposes no screw dimensions and neither do we.
7. A `v-switch` labelled "Connectable" with the hint "The plate's edges get the mating features a
   connection clip bridges." and `persistent-hint`.
8. `v-text-field type="number" min="1"` labelled Quantity and a `v-textarea` labelled Notes (`rows="2"
   auto-grow`), shown inline rather than behind a disclosure.
9. `v-alert type="error"` bound to the preview `errorMessage`, then the action row: an "Add to queue" /
   "Save changes" primary button plus a "Cancel edit" outlined button when editing, and the Editing "..."
   info alert, copied structurally from `ManualBinTab.vue:270-295`.
10. The connection clip section.

Right column: `v-card variant="outlined" class="preview-card"` holding `<BinViewport :mesh="meshes?.body
?? null" :label="null" />` with the same paused-on-small-screens fallback. `BinViewport` is documented as
bin-agnostic and its `label` prop is optional, so it takes a baseplate unchanged.

#### Connection clip offering

Recommendation: its own product kind, offered as a small card at the bottom of the Baseplate tab's option
column. Not a fourth tab, not an automatic prompt.

Reasoning: a clip is meaningless outside baseplate context, so a top-level tab would advertise a part most
users never need and would stretch the tab bar to five on a card that already fights for width on md. An
automatic prompt when Connectable flips on is worse: it either adds queue rows the user did not ask for (a
side effect the user has to notice and undo), or it is a modal interrupting a form the owner specifically
asked to be all on one screen. A section keeps the clip one click away, right under the switch that makes
it relevant, while leaving the user in control of whether a row is created.

Concretely, below the action buttons, a `v-card variant="tonal" class="mt-4" density="compact"` titled
"Connection clips" with the caption "A connection clip bridges two connectable baseplates. It prints as
its own part, so it is queued as a separate row." Then:

- A `v-slider` labelled "Clip tolerance (mm)", `thumb-label="always"`, `:min="CLIP_TOLERANCE_MIN"`
  `:max="CLIP_TOLERANCE_MAX"` `step="0.05"`, with an appended narrow `v-text-field` for exact entry, bound
  to the component-local `clipToleranceMm`. Persistent hint: "The clearance is added to the clip only, so
  a clip printed with a larger tolerance still fits a plate you have already printed. Raise it when the
  clip is too tight to push into the joint." (Owner decision 2. This is the one control the clip has, and
  it is the reason the clip is a configurable product rather than a fixed part.)
- A `d-flex align-center ga-2` row holding a `v-text-field v-model.number="clipQuantity" type="number"
  min="1" step="1" label="Quantity" density="comfortable" hide-details style="max-width: 140px"` and a
  `v-btn variant="outlined" @click="addClips"` reading "Add clips to queue".

`addClips()` calls `queue.add({ kind: 'clip', toleranceMm: clipToleranceMm }, clipQuantity)` and leaves
the baseplate form untouched, so the user can add clips before or after queueing the plate itself.

Visibility: the card is always rendered, but when `store.connectable` is false its caption gains a second
sentence, "Turn on Connectable so the plates have edges for the clip to grip." The card is never hidden,
because a user coming back to add clips for plates queued earlier should not have to toggle a switch on an
unrelated new design to find it.

`clipQuantity` and `clipToleranceMm` are component-local refs, not store state: neither is part of any
baseplate design and neither needs to survive a tab switch. Editing a clip row routes here
(`TAB_OF_KIND.clip === 'baseplate'`); the tab detects `app.editingKind === 'clip'` and in that mode
collapses to just the clip card, with the quantity and the tolerance prefilled from the stored product and
the button reading "Save changes", hiding the baseplate form. This is the one place the tab has two modes;
it is a dozen lines of `v-if` and is far cheaper than a fifth tab.

#### Why not `MoreOptions.vue`

It binds `labelText2`, `magnetHoles`, `notes` and `moreOptionsOpen` straight off `useBinDesigner` (line
39) and renders `DividerEditor` and the bin magnet-holes switch. None of that applies to a baseplate, and
threading a fourth set of hide-flags through a component that already carries `perBinFields`,
`hideDividers`, `dividerNotice` and `insertOnly` would make it a component with more hiding logic than
content. The two fields the baseplate genuinely shares with it, Quantity and Notes, are one
`v-text-field` and one `v-textarea` with no logic. Restating two plain fields is not the duplication rule
10 targets; it targets derived values computed twice, and neither of these derives anything. Additionally
the owner decided all options go on one screen, so a collapsed disclosure would be the wrong container
regardless. If a fourth consumer ever needs the same pair, the right move at that point is to extract a
`QuantityAndNotes.vue` presentational component with `v-model` props and no store import, and adopt it in
all consumers including `MoreOptions`. Noted as a follow-up, not done now, because two consumers is not
yet evidence of a shared concern.

#### Panel sketch

```
+= Add to queue =============================================================+
| [ Manual bin ] [ Screw entry ] [ Tool bin ] [ Baseplate ]                  |
+----------------------------------------------------------------------------+
|                                        |                                   |
|  Baseplate size (grid units of 42 mm)  |   +---------------------------+   |
|  +---------+     +---------+           |   |                           |   |
|  | Width   |  x  | Depth   |           |   |                           |   |
|  |    4    |     |    2    |           |   |      +-+-+-+-+            |   |
|  +---------+     +---------+           |   |     /_/_/_/_/|            |   |
|                                        |   |    /_/_/_/_/||            |   |
|  [x] Custom size                       |   |    |_|_|_|_|/             |   |
|  +--------------------------------+    |   |                           |   |
|  | Last column width (mm)  [30.0] |    |   |    3D preview             |   |
|  | Last row depth (mm)     [42.0] |    |   |    (BinViewport)          |   |
|  |                                |    |   |                           |   |
|  |   Total width      156.0 mm    |    |   |                           |   |
|  |   Total depth       84.0 mm    |    |   +---------------------------+   |
|  +--------------------------------+    |                                   |
|                                        |                                   |
|  Base magnets                          |                                   |
|  +--------+--------+                   |                                   |
|  |  None  |  FULL  |                   |                                   |
|  +--------+--------+                   |                                   |
|  +--------------------------------+    |                                   |
|  | Magnet diameter (mm)           |    |                                   |
|  |  2 |---------O--------| 8.2    |    |                                   |
|  |                        [ 6.5 ] |    |                                   |
|  | Magnet height (mm)             |    |                                   |
|  |  1 |----O-------------| 4      |    |                                   |
|  |                        [ 2.4 ] |    |                                   |
|  +--------------------------------+    |                                   |
|                                        |                                   |
|  Screw holes                           |                                   |
|  +--------+--------+                   |                                   |
|  |  NONE  |  Full  |                   |                                   |
|  +--------+--------+                   |                                   |
|                                        |                                   |
|  [x] Connectable                       |                                   |
|      The plate's edges get the mating  |                                   |
|      features a connection clip        |                                   |
|      bridges.                          |                                   |
|                                        |                                   |
|  +-----------+  +------------------+   |                                   |
|  | Quantity  |  | Notes            |   |                                   |
|  |     1     |  |                  |   |                                   |
|  +-----------+  +------------------+   |                                   |
|                                        |                                   |
|  +====================+  +-----------+ |                                   |
|  |    Add to queue    |  |  Cancel   | |                                   |
|  +====================+  +-----------+ |                                   |
|                                        |                                   |
|  +----------------------------------+  |                                   |
|  | Connection clips                 |  |                                   |
|  | A connection clip bridges two    |  |                                   |
|  | connectable baseplates. It       |  |                                   |
|  | prints as its own part, so it is |  |                                   |
|  | queued as a separate row.        |  |                                   |
|  |                                  |  |                                   |
|  | Clip tolerance (mm)              |  |                                   |
|  |  0 |--O---------------| 0.5      |  |                                   |
|  |                       [ 0.00 ]   |  |                                   |
|  | The clearance is added to the    |  |                                   |
|  | clip only, so a clip printed     |  |                                   |
|  | with a larger tolerance still    |  |                                   |
|  | fits a plate you have already    |  |                                   |
|  | printed. Raise it when the clip  |  |                                   |
|  | is too tight to push into the    |  |                                   |
|  | joint.                           |  |                                   |
|  |                                  |  |                                   |
|  | +----------+  +----------------+ |  |                                   |
|  | | Quantity |  | Add clips to   | |  |                                   |
|  | |    2     |  | queue          | |  |                                   |
|  | +----------+  +----------------+ |  |                                   |
|  +----------------------------------+  |                                   |
+----------------------------------------------------------------------------+
```

### 5.8 Preview

Recommendation: adapt at the call site; do **not** change `useBinPreview`'s signature.

The composable is already generic over the parameter type `P` (`useBinPreview.ts:13`); the only mismatch
is the fixed `PartMeshes` return. Widening it to `PartMeshes | MeshData` would push a discrimination into
every consumer's template (each would need to know whether `meshes.value` has a `.body`), and
`BinViewport` takes `mesh` and `label` as separate props anyway, so a `PartMeshes` is the shape the
viewport actually wants. Produce one at the call site with a single `.then`:

```ts
function generatePreview(params: BaseplateParams): Promise<PartMeshes> {
  // A baseplate is one solid and has no second-filament part.
  return generateBaseplate(params).then((body) => ({ body, label: null }));
}
```

Then `const { meshes, errorMessage } = useBinPreview(() => store.params, generatePreview)`. No debounce or
ticket logic is restated and the composable is untouched.

Cost if the signature were changed instead, enumerated: three call sites, all needing edits and none
gaining anything. `web/src/components/ManualBinTab.vue:199` (`generatePreview` over a `PreviewSpec`,
consumed at `:302-303` as `meshes?.body` / `meshes?.label`), `web/src/components/ScrewEntryTab.vue:478`
(`generatePreview` over `previewProduct`), `web/src/components/trace/LayoutWorkspace.vue:174`. All three
would have to narrow the result before reaching `BinViewport`. Three files changed to avoid one `.then` is
the wrong trade.

**One change is recommended inside the composable,** on rule 2 and rule 7 grounds: the hardcoded fallback
at `useBinPreview.ts:40` reads "Bin generation failed.", which is factually wrong on a baseplate preview
and would be shown verbatim to the user. Widen it to "Generating the preview failed." One line, correct
for all four consumers, no call site changes.

### 5.9 Worker and client

`geometry.worker.ts`: import `generateBaseplate` and `generateConnectionClip` plus their parameter types
beside line 15; append two methods to the api object after line 95, each doing `const m = await
loadManifold(); return transferMesh(generateX(m, params))`. Neither loads the font: a baseplate and a clip
carry no text, so pulling `loadFont()` in would be a gratuitous dependency on the label pipeline.
`GeometryWorkerApi` is inferred from `typeof api` (line 98), so it widens with no edit.

`workerClient.ts`: extend the imports and append two forwarding functions after line 58, each returning
`getWorker().generateX(params)` with a doc comment. No `withResolvedBinInsert` or
`withResolvedInsertContent` wrapping: those exist to resolve custom label icon paths out of localStorage
before the worker call, and neither product has a label. `BaseplateParams` is all scalars plus one flat
nested object, so nothing needs the deep-copy treatment `plainPockets` gives pocket data; the one nested
object is detached by `baseplateParamsOf` (section 5.10).

### 5.10 Export

**`web/src/engine/plan/geometry.ts`.** The `PrintablePart` union at line 14 gains
`{ part: 'baseplate'; baseplate: BaseplateParams }` and `{ part: 'clip'; clip: ConnectionClipParams }`.

New function `baseplateParamsOf(product: BaseplateProduct): BaseplateParams` beside `toSlottedBinParams`,
copying the fields and spreading `magnets` so the returned object is detached, with the doc comment: the
single place a stored baseplate becomes geometry; the preview, the STL path and the 3MF path all go
through here so what the user sees and what gets exported agree; a null custom span means the axis's last
cell keeps the full pitch, which the generator resolves from its own pitch parameter rather than a stored
42.

`partsOf` (line 50) gains `case 'baseplate'` and `case 'clip'`, each returning a single-element array:

```ts
case 'baseplate': return [{ part: 'baseplate', baseplate: baseplateParamsOf(product) }];
case 'clip':      return [{ part: 'clip', clip: { toleranceMm: product.toleranceMm } }];
```

**Exactly one part each.** A baseplate is a single solid and a clip is a single solid; neither ever expands
into two parts the way `binWithInsert` does, so neither ever takes the multi-part merge path in
`downloadProductStl` (`binDownloads.ts:139`).

`previewBinParams` (line 98) gains `case 'baseplate': case 'clip': return null` to satisfy `assertNever`.
It has no production caller, so this is compile-satisfying only, and its doc comment should say the new
kinds are previewed through their own generator.

**`partKey` and dedupe (owner decision 2).** `partKey` is `JSON.stringify(part)`, so
`{ part: 'clip', clip: { toleranceMm: 0 } }` and `{ ..., toleranceMm: 0.2 }` are distinct keys.
`arrangeUniqueParts` therefore generates and lays out both, while two clip rows at the same tolerance
still collapse to one generation. This is correct behaviour and needs no code change, but it is worth
stating: exposing the tolerance means a batch can legitimately contain two clips that look identical and
are not.

**`web/src/binDownloads.ts`.** Four functions gain branches, all already dispatching on `part.part`, so
each is a two-line insert.

- `generatePartMeshes` returns `generateBaseplate(part.baseplate).then((body) => ({ body, label: null }))`
  and the clip equivalent, with a comment that a baseplate and a clip are single solids with no
  second-filament part, so the label mesh is null and the 3MF writer emits them single-filament.
- `generatePartUnion` returns `generateBaseplate(part.baseplate)` and `generateConnectionClip(part.clip)`
  directly. There is deliberately **no** separate `generateBaseplateUnion`: the union variants exist for
  parts whose preview form is two meshes, and a baseplate's is one. One worker method serves both paths,
  which is one fewer thing that can disagree.
- `partFootprint` returns
  `{ widthMm: baseplateSpanMm(part.baseplate.unitsX, part.baseplate.customXMm), depthMm: baseplateSpanMm(part.baseplate.unitsY, part.baseplate.customYMm) }`
  for a baseplate, and `clipFootprintMm(part.clip)` for a clip. `baseplateSpanMm` and `clipFootprintMm`
  are imported from the geometry module, never recomputed here. This is the sharpest rule-10 constraint
  the application layer places on the geometry layer: `partFootprint` is what the plate arranger uses to
  lay parts out, so if it derives the plate's outer size independently of the generator, a plate can
  silently overlap its neighbour in a batch export.
- `partName` returns `` `Baseplate ${unitsX}x${unitsY}${custom}` `` where `custom` is ", custom size" when
  either span is non-null; and for a clip, "Connection clip" at tolerance 0 or
  `` `Connection clip, ${toleranceMm} mm tolerance` `` otherwise.
- `fileStem` returns `` `gridfinity_baseplate_${unitsX}x${unitsY}${custom}` `` where `custom` is
  "_custom"; and for a clip, `gridfinity_connection_clip` at tolerance 0 or
  `gridfinity_connection_clip_tol0p2` style otherwise (the decimal point written as `p` so the stem stays
  a single dotless token).

**Filename convention: follow ours, not the reference site's.** The reference writes `baseplate-4-2`.
Every file this app produces is `gridfinity_<thing>_<size>`, with underscores and an `x` between
dimensions (`gridfinity_bin_2x1x6`, `gridfinity_label_insert_4u`). Rule 7 asks for one term per concept,
and a downloads folder where our baseplates sort next to our bins is worth more than matching a site the
user is not using. Resulting names: `gridfinity_baseplate_4x2.stl`, `gridfinity_baseplate_4x2_custom.3mf`,
`gridfinity_connection_clip.stl`, `gridfinity_connection_clip_tol0p2.stl`.

The `_custom` and `_tol` suffixes matter for the same reason: two plates with the same unit counts and
different custom spans are different parts, as are two clips at different tolerances, and a filename that
cannot tell them apart silently overwrites the earlier download.

**3MF path.** `downloadProduct3mf` (`binDownloads.ts:155`) needs **no** change. It calls
`generatePartMeshes`, which now returns `{ body, label: null }` for a baseplate, and pushes
`label: meshes.label` into the `PlateItem`. `PlateItem.label` is already `MeshData | null`
(`threeMf/writer.ts:31`, documented as "null for a plain bin") and `writePlate3mf` already emits a
single-filament object for a null label. A baseplate 3MF is therefore body-on-extruder-1 only, single
filament, with no new writer code. `downloadBatch` (`binDownloads.ts:183`) likewise needs no change: a
baseplate can be mixed into a batch with bins in any of the three formats, and the 3mf-two path simply
produces one object with no second-extruder part.

### 5.11 Queue display

`web/src/components/MainPage.vue` needs **no** template change for row rendering: it renders every row
through `describeProduct` (`MainPage.vue:27`) and the descriptor already carries `title`, `titleLine2`,
`titlePlaceholder`, `iconName` and `caption`. `BatchBox.vue:24` gets the same treatment for free. All the
work is in `web/src/engine/plan/rowDescriptor.ts`, documented as the single source of both strings.

`captionOf` (line 84) gains a baseplate case building `joinCaption(['baseplate', `${unitsX}x${unitsY}`
using the existing multiplication-sign separator matching `sizeToken` at line 47, then 'magnets' when
`magnets !== null`, 'screw holes' when `screwHoles`, 'connectable' when `connectable`])`, and a clip case
returning 'connection clip' plus a 'tolerance 0.2 mm' token when the tolerance is non-zero. The size token
shows two dimensions rather than three because a baseplate has no height units to state. `joinCaption`
(line 79) already drops empty tokens, so a plain plate reads "baseplate / 4x2" and a fully optioned one
reads "baseplate / 4x2 / magnets / screw holes / connectable" with the existing middot separator.

Custom size is deliberately **not** in the caption: it does not change what the part is, and the caption
line clips with an ellipsis on narrow rows, so the three feature flags are the better spend. It appears in
the title instead.

`describeProduct` (line 101) gains a baseplate branch **before** the label-content fallthrough at line 112,
which would otherwise crash on a product with neither insert nor content, returning
`{ title: custom ? 'Baseplate, custom size' : 'Baseplate', titleLine2: '', titlePlaceholder: false,
iconName: null, caption }`, and a clip branch returning title 'Connection clip'. `titlePlaceholder: false`
is correct and load-bearing: true renders italic and dimmed (`MainPage.vue:334-337`), meaning "this row
has no label yet", and a baseplate is not missing anything.

Example rows as rendered:

| Title | Caption | Quantity |
| --- | --- | --- |
| Baseplate | baseplate / 4x2 / magnets / connectable | 1 |
| Baseplate, custom size | baseplate / 4x2 / screw holes | 1 |
| Connection clip | connection clip | 6 |
| Connection clip | connection clip / tolerance 0.2 mm | 4 |

**Edit routing needs no change.** `editRow` (`MainPage.vue:91`) already calls `app.editEntry(entry.id,
originOf(entry.product))`; with `originOf` returning 'baseplate' or 'clip' and `TAB_OF_KIND` mapping both
to the Baseplate tab, clicking a baseplate row opens the Baseplate tab, scrolls to top, and the tab's
watch on `app.editingEntryId` loads it, mirroring `ManualBinTab.vue:105-109`. That watcher's guard becomes
`app.editingKind === 'baseplate' || app.editingKind === null`, with a parallel guard for 'clip' selecting
the clip-only mode.

### 5.12 The row noun: "bins" becomes "parts" (owner decision 3)

The queue no longer holds only bins, so the noun generalizes now, in this feature, not as a follow-up.
This changes wording on the existing bin flows too, which is intended: a queue of four bins reading "4
parts queued" is accurate, whereas a queue of four baseplates reading "4 bins" is not.

Required changes:

| Location | Current | Replacement |
| --- | --- | --- |
| `MainPage.vue:139` | `{{ n }} {{ n === 1 ? 'bin' : 'bins' }} queued` | `{{ n }} {{ n === 1 ? 'part' : 'parts' }} queued`, rendering "7 parts queued" |
| `MainPage.vue:249` | `&middot; {{ selectedBinTotal }} bins` | `&middot; {{ selectedPartTotal }} parts` |
| `MainPage.vue:252-253` | `Create build plate ({{ selectedBinTotal }} {{ selectedBinTotal === 1 ? 'bin' : 'bins' }})` | `Create build plate ({{ selectedPartTotal }} {{ selectedPartTotal === 1 ? 'part' : 'parts' }})` |
| `MainPage.vue:76` | `const selectedBinTotal = computed(...)` | rename to `selectedPartTotal`; mechanical, and required by the two rows above |
| `MainPage.vue:223` | subtitle "One mesh, label merged into the bin." | derived per kind, see below |
| `MainPage.vue:229` | subtitle "Body and label slots for toolchanger printing." | derived per kind, see below |

Line 249 is included with 252 although the owner named only 252: it is the same count in the same bar, and
changing one and not the other would put "4 bins" and "4 parts" side by side.

**Download menu subtitles.** Both hardcoded strings are false on a baseplate row, so they are derived
rather than patched with an inline `v-if` in the template. Add `downloadSubtitles(product): { stl: string;
threeMf: string }` to `rowDescriptor.ts`, the module already documented as the single source of the row's
user-facing strings:

| Kind | STL subtitle | 3MF subtitle |
| --- | --- | --- |
| bin, binWithInsert | One mesh, label merged into the bin. | Body and label slots for toolchanger printing. |
| insert | One mesh, label merged into the insert. | Body and label slots for toolchanger printing. |
| baseplate | One mesh. | Single filament; a baseplate has no label. |
| clip | One mesh. | Single filament; a connection clip has no label. |

The insert row is corrected in passing: it read "merged into the bin" for a part that is not a bin.

**Same-screen consistency, recommended in the same change** (the owner may strike any of these; each is
the same noun on the same screen):

| Location | Current | Replacement |
| --- | --- | --- |
| `MainPage.vue:128` | "Add bins to the queue, select rows to create a build plate batch, then confirm what printed." | "Add parts to the queue, select rows to create a build plate batch, then confirm what printed." |
| `MainPage.vue:150` | empty state title "No bins queued" | "Nothing queued yet" |
| `MainPage.vue:151` | empty state text "Add a bin with the card above." | "Add a part with the card above." |
| `MainPage.vue:217` | tooltip "Download bin" | "Download part" |
| `BatchBox.vue:69` | "STL (all bins merged)" | "STL (all parts merged)" |
| `BatchBox.vue:75` | "One filament, the labels merged into their bins." | "One filament, each label merged into its part." |

"Bin" stays wherever it genuinely means a bin: the Manual bin tab, the Tool bin tab, bin-specific field
labels, and the bin geometry itself.

### 5.13 Application test plan

New file `web/tests/plan/baseplate.spec.ts` plus additions to three existing specs. `vitest.config.ts`
uses environment node and includes `tests/**/*.spec.ts`, so plan-layer tests need no browser and no WASM.
Each test is chosen because it fails on a specific realistic mistake, not to cover a line.

**Round trip** (catches a `pickBaseplate` field omission):

1. `serializePlanFile` a plan holding a baseplate with **every** option on and non-default (`unitsX` 4,
   `unitsY` 2, `customXMm` 30.5, `customYMm` 42, magnets `diameterMm` 8.2 `heightMm` 1, `screwHoles` true,
   `connectable` true), parse it back, `toEqual` the original product. A field forgotten in `pickProduct`
   is dropped silently on load, and this is the only thing that catches it.
2. The same for the all-off plate (`customXMm` null, `customYMm` null, `magnets` null, `screwHoles` false,
   `connectable` false), asserting the nulls survive as null and do not come back as undefined. Undefined
   would serialize away entirely on the next `persist()`, so this is the mutation that quietly corrupts a
   stored plan over two sessions.
3. Round trip a clip entry at `toleranceMm` 0 **and** a second at 0.35, asserting both survive exactly. A
   clip whose tolerance is dropped on load prints at the nominal fit and does not fit the printer it was
   tuned for, which is silent and only discovered at the print.
4. Parse a plan whose entries are a bin, a `binWithInsert`, an insert, a baseplate and a clip, and assert
   all five come back with the right kinds in the right order. Catches a branch inserted before the wrong
   `if` in `pickProduct`.

**Version compatibility** (catches the legacy path being disturbed):

5. A version-4 file (product shape with `dividerCountX`/`dividerCountY`, no walls) still parses, its
   dividers still convert through `evenDividerWalls`, and the returned `plan.version` is 6. The existing
   suite has this for 4-to-5 and it must keep passing after the bump; asserting the emitted version is 6
   is what catches a forgotten constant.
6. A version-5 file with walls parses unchanged.
7. A version-1 file with status 'printed' entries still drops them.
8. A file declaring version 7 is rejected with "The file has plan version 7, but this app reads versions 1
   to 6." Catches the guard being hardcoded rather than derived from the constant.

**Validation** (one case per message, asserting the exact string):

9. Table-driven over bad fields, each asserting `validateEntry` returns the exact message: `unitsX` 0,
   `unitsX` 21, `unitsX` 2.5, `unitsY` 0, `customXMm` 0, `customXMm` 43, `customXMm` 'wide', `magnets` 5,
   `magnets.diameterMm` 1.9, `magnets.diameterMm` 8.3, `magnets.heightMm` 0.5, `magnets.heightMm` 4.1,
   `screwHoles` 'yes', `connectable` null, clip `toleranceMm` -0.1, clip `toleranceMm` 0.6, clip
   `toleranceMm` '0.2'. Asserting the exact string, not just non-null, is what enforces rule 2's
   user-worded requirement in CI: a message rewritten into jargon fails the test.
10. Boundary acceptance: `unitsX` 1, `unitsX` 20, `customXMm` 42, `magnets.diameterMm` 2,
    `diameterMm` 8.2, `heightMm` 1, `heightMm` 4, clip `toleranceMm` 0, clip `toleranceMm` 0.5 all
    validate. Inclusive bounds are exactly what an off-by-one in `isNumberInRange` breaks, and the
    defaults sit near the edges.
11. `{ kind: 'plate' }` returns the product-kind message.
12. An extra unknown key on a baseplate validates **and** is dropped by `pickProduct`, guarding the
    copy-only-known-fields discipline.

**Merge semantics:**

13. `mergeEntries` with an imported baseplate sharing an existing bin entry's id replaces it and the
    result is the baseplate, confirming merge really is product-agnostic.
14. `mergeEntries` appends a clip entry with a new id in file order.

**Row descriptor** (`web/tests/plan/rowDescriptor.spec.ts`):

15. Title and caption for a plain plate, a fully optioned plate, a custom-size plate, a clip at tolerance
    0 and a clip at tolerance 0.2. Assert exact strings including `iconName` null and `titlePlaceholder`
    false, since true there would render every baseplate row in italic grey. The two clip cases assert the
    tolerance token appears only when non-zero, so two clip rows that print differently are
    distinguishable in the queue.

**Geometry mapping** (`web/tests/plan/geometry.spec.ts`):

16. `partsOf` on a baseplate returns exactly one part with `part === 'baseplate'` and its params deep
    equal `baseplateParamsOf(product)`, catching the params being restated in `partsOf` instead of
    delegated.
17. `partsOf` on a clip returns exactly one part with `part === 'clip'` whose `clip.toleranceMm` equals
    the product's, including a non-zero value.
18. `baseplateParamsOf` returns a **detached** magnets object: mutating `params.magnets.diameterMm` does
    not change the product. The store's preview getter runs on every keystroke over a reactive product, so
    an aliased object is a real bug here.
19. `previewBinParams` returns null for both new kinds.

**Store level** (`web/tests/stores/baseplateDesigner.spec.ts`, new directory):

20. `spanX` and `spanY` return null when `customSize` is false **even after** the user has typed a custom
    value and toggled off. This is the single most likely real regression, since a naive product getter
    reads `state.customXMm` directly and persists a custom span the user turned off.
21. `magnets` returns null when `magnetMode === 'none'` even with a non-default diameter and height set.
22. `product` output passes `validateProduct` for the default form state and for the fully optioned state,
    tying the form to the file format so a form default outside the validator's range is caught at build
    time rather than by a user's rejected import. The default magnet dimensions (6.5 and 2.4) are inside
    the validator's bounds, and this test is what proves owner decision 1 did not push a default out of
    range.

**Export dedupe:**

23. `partKey` on two clip parts at different tolerances differs, and on two at the same tolerance matches,
    so a batch containing both a nominal and a loosened clip arranges two distinct parts.

## 6. Staging plan

Every stage ends green on `npm run build` (which runs `vue-tsc`) plus `npm test` inside `web/`. That is the
standing verification bar; the per-stage bars below are in addition to it.

### Stage 0: shared shape primitives (prerequisite refactor)

Extract `hullBetween`, `insetPolygon`, `loftChain` and the already-exported `roundedRectPolygon` from
`binGenerator.ts` into `web/src/engine/gridfinity/shapes.ts`, and add the two optional trailing parameters
to `loftChain` (`cornerRadius`, `segments`). Pure move plus a backward-compatible signature widening.

**Verification bar:** the full existing bin geometry suite stays green with no test edits. Any test change
in this stage is evidence the move was not behaviour-preserving. See risk R8.

### Stage 1: data model and plan file

`types.ts` (new product members, `Product`, `ProductOrigin`, `insertOf` / `binOf` / `originOf` branches,
`PLAN_FILE_VERSION` to 6, `PlanFile.version`), `planFile.ts` (`validateMagnets`, `validateBaseplate`,
`validateClip`, `pickBaseplate`, wiring, the version comment), `rowDescriptor.ts` branches and
`downloadSubtitles`, `geometry.ts` (`PrintablePart` members, `baseplateParamsOf`, `partsOf` and
`previewBinParams` branches). No UI, no geometry.

Depends on stage 2 only for the **shape** of `BaseplateParams` and `ConnectionClipParams` and the exported
constants. If those are not ready they can be declared as a temporary local type in `geometry.ts` and
moved in stage 2 with no other change.

Note that this stage alone makes `AddBinCard.vue` fail to compile (the `Record<ProductOrigin, TabName>`
widening). Fold stage 4's two-line map edit forward into stage 1 rather than using a placeholder, so every
stage's tree is honest.

**Verification bar:** tests 1 to 19 and 23 from section 5.13 pass. The version-4 and version-1 legacy
tests in the existing suite pass unchanged apart from the asserted output version.

### Stage 2: geometry

Lands `web/src/engine/baseplate/` with `generateBaseplate`, `generateConnectionClip`, `baseplateSpanMm`,
`baseplateRiserMm`, `clipFootprintMm`, `BASEPLATE_UNITS_MAX`, the magnet bounds and defaults,
`CUSTOM_SPAN_MIN`, the clip tolerance bounds, and the measured constants of section 4.9. Plus the
`geometry.worker.ts` and `workerClient.ts` additions. Once this lands, stage 1's temporary type
declarations are deleted.

**Verification bar:** the whole of section 4.12 passes, in particular test 1 (manifold across all 24
size/option combinations), test 4 (the two-sided mating probe against `buildFoot`), test 8 (magnet
position 13.0, which is owner decision 1 in assertion form) and test 13 (clip-to-rib engagement). Also,
**measure preview generation time** for a 20 by 20 plate with all options on and record it as a labeled
readout, since stage 4's preview design depends on that number (see the open question in section 7).

### Stage 3: export

`binDownloads.ts` branches in `generatePartMeshes`, `generatePartUnion`, `partFootprint`, `partName` and
`fileStem`.

**Verification bar:** a test asserting `partFootprint` on a custom-size plate equals `baseplateSpanMm` on
both axes, and a test asserting the clip filename stems differ across tolerances. Plus an owner check that
a downloaded baseplate 3MF opens in Orca Slicer as a single-filament object. 3MF export is not proven
until the owner confirms it in Orca.

### Stage 4: UI

`stores/baseplateDesigner.ts`, `components/BaseplateTab.vue`, the `AddBinCard.vue` wiring, the
`useBinPreview` error-string widening, and the section 5.12 row-noun changes including the derived
download-menu subtitles.

**Verification bar:** store tests 20 to 22. Plus an owner browser check that the tab previews, queues,
re-opens for edit, and that the queue reads "N parts queued".

### Stage 5: connection clip UI

The clip card (quantity, tolerance slider, add button) and its edit mode inside `BaseplateTab.vue`.

Split from stage 4 because the clip's edit mode is the one genuinely fiddly piece and should not be
entangled with getting the baseplate form itself right. If the geometry clip work slips, stages 1 to 4
still ship a complete baseplate feature and only the clip card waits.

**Verification bar:** an owner check that a clip row queues, re-opens into clip-only mode with its
tolerance prefilled, and downloads under a tolerance-distinct filename.

### Application-layer constraints on the geometry layer

Each is a place the application layer would duplicate a derived value unless geometry exports it.

- **G1** `baseplateSpanMm(units: number, customMm: number | null, pitchMm?: number): number` **must** be
  exported. `partFootprint` in `binDownloads.ts` feeds the plate arranger, and the store's diagnostic
  readout shows the same number. If either computes `(units - 1) * 42 + (custom ?? 42)` locally, three
  copies of the size formula exist and a batch export can overlap parts. The single most important item on
  this list.
- **G2** `clipFootprintMm(params)` must be exported (this supersedes the earlier proposal of
  `CLIP_WIDTH_MM` and `CLIP_DEPTH_MM` constants, which stopped being adequate once the tolerance became a
  parameter).
- **G3** The option bounds must be exported constants, not literals in the generator:
  `BASEPLATE_UNITS_MAX` 20, `MAGNET_DIAMETER_MIN`/`MAX`/`DEFAULT` 2 / 8.2 / 6.5,
  `MAGNET_HEIGHT_MIN`/`MAX`/`DEFAULT` 1 / 4 / 2.4, `CUSTOM_SPAN_MIN` 1,
  `CLIP_TOLERANCE_MIN`/`MAX`/`DEFAULT` 0 / 0.5 / 0. The validator, the sliders and the store defaults all
  bind to them. If the generator's real physical limit differs from the reference site's UI limit, the
  generator's number wins and the UI follows.
- **G4** `BaseplateParams` must accept a `pitchMm` parameter defaulting to 42, and `baseplateSpanMm` must
  take it too. The application layer never passes it today; the default is what makes `customXMm: null`
  mean "the pitch" rather than "42".

## 7. Risks and remaining open questions

R3 (magnet dimension divergence between the plate and our bins) is **resolved** by owner decision 1 and is
no longer carried here. The reference's 6.2 / 2.1 / 13.5 are recorded in section 4.5 as measured facts
that are deliberately not adopted.

### Geometry risks

- **R1 Zero-thickness top rim** (measured, by design). Every socket rim tapers to a knife edge at
  z = 4.65, and at each internal grid crossing two knife edges cross, pinching the solid to a point.
  Topologically the link of that vertex is still a disk, so it is manifold, but it is numerically fragile
  and manifold-3d may emit degenerate triangles there. Mitigation: build the cavity so it overshoots (cell
  squares continue past the pitch above z = 4.65, and the clipper past the outline) so the boolean cuts
  cleanly through rather than landing on the boundary. Test 1 is the guard. If it proves unstable in
  practice, the decision to deviate from the reference belongs to the owner.
- **R2 Pitch generalisation is a genuine fork.** At pitch 42, "socket top = pitch" and "socket top = bin
  footprint + 2 * 0.25" both give 42.000, and the measurement cannot distinguish them. The recommendation
  is to key to the bin footprint (bins do not resize), but this is a design choice, not a measurement, and
  should be confirmed before any pitch control ships.
- **R4 Boss scaling unverified.** Only one magnet configuration was exported, so it is unknown whether the
  4.5 mm boss fillet is fixed or is `magnetRadius + 1.4`. The derived form is recommended and is what this
  document specifies; it is untested either way. Owner decision 1 makes this slightly more consequential,
  since our 6.5 mm magnet already puts the boss radius at 4.65 rather than the measured 4.5, so the
  derived form is now load-bearing rather than merely equivalent.
- **R5 Slot count for non-2x2 plates is inferred.** Only a 2x2 connectable was captured (two slots per
  edge, one per cell). "One slot per cell per edge" is the obvious generalisation but is not measured for
  1x1 or 3x2.
- **R6 "Full" implies other modes.** The reference UI labelled both magnets and screws "Full", suggesting
  at least a corners-only variant that was not captured. If the owner wants that mode it needs its own
  export before it can be specified. It is out of scope here.
- **R7 Clip length clearance.** 19.60 in a 20.00 slot at tolerance 0 is 0.20 per end. Reported as
  measured; whether it is intentional end clearance or a rounded 19.6 is not determinable from one sample.
- **R8 Refactor blast radius.** Moving `hullBetween` / `insetPolygon` / `loftChain` out of
  `binGenerator.ts` and adding two optional parameters to `loftChain` touches the bin generator. It is
  behaviour-preserving, but the full bin geometry suite must stay green to prove it, and that verification
  belongs in the same change (stage 0).

Note that the reference's own tolerance behaviour was only captured at 0, so **how** the reference applies
its tolerance is unknown. Clip-only application is specified here as the safe choice: it is the only
application that cannot invalidate an already-printed plate. This was formerly folded into R5 and is now a
stated design decision rather than a risk, because owner decision 2 makes the parameter ours rather than a
reproduction.

### Application-layer risks

- **The version bump is one-way for the user.** After stage 1 ships, `persist()` writes version 6 on the
  next mutation, and an older deployed build (or a stale tab open in another window) will refuse the whole
  plan with "reads versions 1 to 5". GitHub Pages serves one build, so this is a narrow window, but a user
  with the app open in two tabs across the deploy can hit it. Acceptable and inherent to any format bump;
  worth a line in the release note rather than a code change.
- **`customXMm` on a plate whose `unitsX` later changes.** The stored custom span always applies to the
  **last** column, so editing `unitsX` from 4 to 5 silently moves the shortened column. That is the
  reference site's behaviour and is probably what the user means, but it is a place where the queue row's
  caption does not reveal that the plate is 4 full cells plus a 30 mm stub. The title's ", custom size"
  marker is the mitigation; if it proves insufficient, the caption should carry the total mm.
- **`MoreOptions.vue` duplication.** Two plain fields restated is accepted. If a fifth tab appears,
  extract `QuantityAndNotes.vue` at that point rather than letting a third copy land.

### Open questions

- **Q1 Custom size combined with magnets.** Section 4.7 specifies that a magnet is emitted only when its
  full boss circle lies inside the plate outline. This is a design rule, not a measurement: the reference
  site's behaviour with custom size plus magnets was not captured. The alternative (emit the magnet and
  let it be clipped by the outline, producing an open pocket in the plate's side wall) is worse, but the
  owner may prefer a third option, such as refusing to shorten a column below the width a magnet boss
  needs.
- **Q2 Is a 20 by 20 baseplate previewable?** That is 840 mm square, roughly 400 sockets, generated as CSG
  in manifold. If it takes tens of seconds, the 300 ms debounce will queue work behind every keystroke.
  `useBinPreview`'s ticket discards the stale **result** but does not cancel the stale **work**, so the
  worker can fall arbitrarily behind on a large plate. Mitigation if measured slow: raise the debounce for
  this tab, or gate the preview behind a button above a unit-count threshold, the way `smAndDown` gates it
  today. This needs a measurement in stage 2 before stage 4 is designed around it.
- **Q3 Clip print orientation.** `connector.stl` is a prism with its 19.6 mm length along Z, so the
  reference exports it standing on a 4.30 by 3.67 mm footprint. This document specifies generating it
  exactly as measured, because that is what the measurements validate and because layer orientation
  matters for a snap fit's flexure. A 19.6 mm tall part on a 4.3 by 3.67 mm footprint is tippy and a batch
  of them may not print well. Laying it down (length along X, flat bottom face on the build plate) would
  put a roughly 2.9 mm wide bridge over the groove roof. The owner should decide; `partFootprint` follows
  whatever the generator emits, through `clipFootprintMm`, so the choice is confined to the generator.
- **Q4 Should a baseplate be selectable into a build plate batch?** Nothing prevents it and `createBatch`
  works unchanged. Owner decision 3 removes the wording objection (the counts now read "parts"), so the
  remaining question is only whether mixing a 336 mm plate with bins in one arrangement is useful or
  merely a way to fail the fit check. Recommendation: allow it and let the existing "does not fit"
  user-worded message do its job.
