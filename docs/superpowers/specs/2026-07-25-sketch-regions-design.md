# Sketch region extraction: CAD-style enclosed-area picking

Date: 2026-07-25. Status: owner approved the feature and the shaded-region UI in conversation;
algorithm choices per expert consultation. Written record.

## Problem

Profile extraction only walks entities chained end to end through shared points, so overlapping
geometry yields nothing: a line crossing a circle cannot produce the flat-sided-bottle outline.
Real CAD sketchers compute curve intersections and let the user pick any enclosed region.

## Decision summary

New engine module `web/src/engine/sketch/regions.ts` implementing an arrangement of the sketch's
non-construction curves and enumeration of its faces; the UI shades every bounded face with a
light translucent fill (CAD blue), the user picks one (auto-pick when exactly one), and the
picked face becomes the tool outline with holes from its inner cycles. `profile.ts` becomes a
thin caller; its flattening helpers move to the shared location rather than being duplicated
(convention 10).

## Algorithms (established, named; convention 12)

1. **Intersections:** analytic closed forms per pair: line/line, line/circle-or-arc (quadratic),
   circle/circle (radical line). O(n^2) pairwise is sufficient at sketch scale (tens of curves);
   Bentley-Ottmann deliberately not needed, stated in code.
2. **Vertex welding:** epsilon vertex clustering via union-find (the tolerance model used by
   CGAL Arrangement_2 style snap approaches). Epsilon is one shared constant with a reasoned
   derivation documented in code (1e-6 mm: far below any manufacturable feature, far above
   accumulated double-precision error at sketch scale). Not a tuned fudge.
3. **Splitting and flattening:** curves split at exact analytic intersection parameters, then
   each sub-curve flattened at the shared OUTLINE_TOLERANCE_MM; the arrangement is built on
   polyline edges that remember their source entity id for UI hit-testing. Exact-arc traversal
   is rejected: the outline is flattened at 0.2 mm regardless, so exact split points are kept
   and nothing further is gained.
4. **Face extraction:** doubly connected edge list with face traversal by most-counterclockwise
   outgoing edge, including the full inner-cycle grouping step (cycles with negative signed
   area grouped into containing faces via the leftmost-vertex ray-crossing containment test),
   per de Berg, Cheong, van Kreveld, Overmars, Computational Geometry, chapter 2. Inner cycles
   of the picked face become outline holes directly.
5. **Tangency defense:** a near-zero discriminant is treated as exactly one tangent point
   (threshold expressed in the shared epsilon); post-split edges shorter than the epsilon are
   dropped, so tangent contact cannot produce zero-length edges or broken turn decisions.
   Tangent cases are tested explicitly.

## UI

- The canvas shades every bounded face translucently whenever the solver state is not
  conflicting; hovering a face raises its opacity; clicking selects it (selected face visibly
  distinct). With exactly one bounded face it is preselected.
- "Use this shape" consumes the selected face (outer cycle plus holes); with no face selected
  and several available, the finish action asks the user to pick a region first (user-worded
  message, no exception).
- Region shading lives in its own SVG layer under the geometry so entity/point/glyph hit
  targets keep priority. Construction entities never contribute edges.

## Out of scope

Splines and ellipses (V1 scope holds); multi-region union pockets (one region per tool for
now, matching one outline per tool in the plan schema).

## Testing

Engine tests per the expert's list: line through circle (two faces, both extractable), two
overlapping circles (three faces), circle tangent to line and circle tangent to circle
(tangency defense), island in region (hole via inner cycle), construction-only geometry
(no faces, user-worded error), plus reuse of every existing profile.ts failure wording where
it still applies. Store/UI: face pick state, auto-pick single face, finish-with-no-pick message.
