# Multi-source tool bins: trace sessions, per-tool source data, source list UI

Date: 2026-07-25. Status: approved by owner in conversation (data model and scope); UI structure
per expert consultation. This document is the written record.

## Problem

The sketch workspace made a tool's origin per-tool (`ToolSource`), but photo trace data stayed
bin-level from the single-photo era: `paper`, `traceSourceId`, and the stored photo blob are saved
with the bin regardless of whether any tool still uses them, while the photo-specific re-edit data
(`clicks`, `brushStrokes`) sits on every `TracedTool` including sketched ones. Consequence the
owner hit: a sketch-only bin silently saves and restores a photo it never used. The owner also
wants the capability this structure blocks: one bin combining tools traced from several
photographed sheets with any number of sketched and primitive tools.

## Decision summary

Reshape the data model around **trace sessions** and make each `ToolSource` variant fully own its
re-edit data. Interim fixes are forbidden (convention 10); this is the final structure. Plan file
version 11 is unshipped, so it is reshaped in place; no intermediate migration exists.

### Data model

- A tool bin carries `traceSessions: TraceSession[]` where
  `TraceSession = { id: string; traceSourceId: string; paper: { corners; kind } }`. Zero or more.
- `ToolSource` becomes a three-variant union, each variant self-contained:
  - `{ kind: 'photo'; sessionId: string; clicks: SamPoint[]; brushStrokes?: BrushStroke[] }`
  - `{ kind: 'sketch'; sketch: Sketch }`
  - `{ kind: 'primitive' }` (basic shapes, previously mislabeled as photo)
- `clicks` and `brushStrokes` leave `TracedTool`; they exist only inside the photo variant.
- Persistence rule: a session (and its photo blob in the photo store) is saved iff at least one
  tool references its `sessionId`; orphaned sessions and their stored photos are dropped on save.
  A sketch-only bin therefore carries zero photo data by construction.
- Plan file: v11 reshaped. v10 plans migrate: bin-level `paper`/`traceSourceId` become one
  session; every tool with clicks becomes a photo tool referencing it; primitive-shaped tools
  (empty clicks) become `primitive`; validation messages follow the planFile.ts convention.

### Store and worker

- The `toolTrace` store's single-photo state (`photoUrl`, `corners`, `calibration`,
  `embedReady`, ...) becomes the **active session** state. Session activation is one atomic store
  action that clears all of it first, then loads the session's photo, applies its saved corners,
  rectifies and embeds. `embedReady` is keyed by session id so a re-trace can never run against a
  stale sheet's calibration (expert-flagged failure mode; wrong millimeters otherwise).

### UI (expert-consulted structure)

- The input stage becomes a **source list**: one card per existing trace session (sheet) and per
  sketched tool, plus two actions, "Add a photo sheet" and "Draw a shape". Clicking a sheet card
  activates that session and opens the trace workspace; a sketch card opens the sketch workspace.
- First-run shortcut: with no sessions and no sketches, the stage shows only the two large
  actions (today's screen without the toggle); the list appears once a source exists. The common
  single-sheet or single-sketch flow stays as short as today.
- Breadcrumb: first chip renamed to "Sources"; second stays "Trace and lay out". The trace and
  sketch workspaces are modal work on one source entered from a card, with a "Back to sources"
  action, not a third chip.
- Tool rail: re-trace resolves the tool's `sessionId`, atomically activates that session, then
  opens trace mode. Edit-sketch opens the sketch workspace directly. The `traceInput` toggle and
  `sketchCancelStage` mechanism in TraceTab.vue are removed; workspaces return to whichever stage
  opened them.
- Mobile: source cards stack full width in one column at 375 px; workspaces stay full-bleed; no
  persistent rail.
- UI text plain technical prose; no em-dash characters; exhaustive `ToolSource` switches with
  `assertNever` everywhere, including the new `primitive` member.

## Out of scope

Cross-bin session sharing, sheet thumbnails beyond what the photo store already yields cheaply,
and any change to the pocket/export pipeline (tools still resolve to outlines exactly as today).

## Testing

Engine: session reference-counting on save (orphan dropped, referenced kept), v10 to v11
migration (tools gain photo sources referencing the migrated session; primitives detected), plan
round-trip with multi-session bins, ToolSource validation for all three variants. Store: atomic
session activation clears prior calibration and re-keys embedReady; re-trace against the correct
session. UI behavior beyond build/typecheck is covered by the owner's browser check.
