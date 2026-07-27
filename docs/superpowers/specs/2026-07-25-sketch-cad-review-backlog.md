# Sketch workspace: senior CAD designer review, backlog

Date: 2026-07-25. Source: consulted CAD-application expert review of the shipped sketch
workspace. Items marked BUILT are being implemented the same night under the owner's standing
directive; everything else awaits owner triage.

## Defects in shipped features (BUILT tonight)

- Dimension entry field: blur cancels the draft even when the text parses; blur should commit
  a parseable value, Escape stays cancel. New dimensions should default to the measured current
  value instead of a placeholder (Enter without editing = lock at current size), which also
  stops the solver yanking geometry to a placeholder value mid-entry.
- Mirror tool hint promises "then the two points to keep symmetric" but the tool only places
  the line; hint corrected to the real workflow.
- Escape during a multi-click tool (three-point arc, mirror) should clear the pending clicks,
  not only end chains.
- Conflict rows name raw constraint ids; hovering a conflict row should highlight the offending
  constraint's glyph/entities on canvas.

## Quick wins (BUILT tonight, expert's build-next top 3)

- Rectangle tool: two clicks, auto horizontal/vertical constraints on the four lines.
- Slot tool: two clicks plus a width, the canonical elongated tool pocket shape.
- Dimension ergonomics: measured-value defaults, commit-on-blur, and type-length-while-drawing
  for line and circle (numeric input while the tool is active applies to the segment being
  drawn).
- Auto horizontal/vertical inference: lines drawn within about 2 degrees of an axis get the
  constraint automatically, with a pre-commit visual hint glyph so the user sees it coming
  (and can suppress with a modifier key).
- Live length/angle readout beside the rubber-band cursor while drawing.

## Awaiting owner triage

- Novice-first presentation: replace "Degrees of freedom: N" phrasing with plain language
  ("Shape fully defined" / "N measurements still free"), demote the constraint vocabulary
  visually so the trace-then-dimension path leads.
- Underlay positioning: drag and rotate the reference photo, not only scale; draw the
  calibration line's measured span before commit; calibration click flow hardening.
- Entity dragging: drag whole lines/circles, not only points; marquee selection with Shift
  semantics.
- Sketch fillet (corner pick, radius). Note: the pocket pipeline already offsets outlines;
  clarify overlap with the outline-offset stage before building (convention 10).
- Template shapes: parametric starter sketches (hex key L, wrench silhouette, cylinder+flat).
- Trim tool: low priority, region picking already yields trim's outcome.
- Offset curves in-sketch: skip, pipeline offsets already.
- DXF import: real hobbyist demand (Inkscape exports); an importer module, separate decision.
- Rectangle and slot corners do not snap onto existing sketch points (unlike line/circle/arc);
  a compound profile built from these tools relies on region extraction to join adjacent
  shapes rather than shared corner points.
