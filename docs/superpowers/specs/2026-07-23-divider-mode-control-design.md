# Divider mode control (Manual Bin and Screw Entry)

Date: 2026-07-23. Approved by owner from a visual mockup.

## Problem

The divider wall system (free-angle wall editor plus "evenly spaced walls" fields with an
Apply button) is hidden inside the More options expander on the Manual Bin tab, and the
relationship between the two systems (Apply replaces the drawn walls) is unclear.

## Design

A three-state segmented control labeled "Dividers" with the options None, Grid, and
Custom, placed in the always-visible part of the form, directly above the More options
expander, on both the Manual Bin tab and the Screw Entry tab.

- **None** (default): no divider UI is shown; the form is as compact as today.
- **Grid**: shows only the two count fields (dividers along X and dividers along Y) and a
  computed compartment count readout. Counts take effect immediately; there is no Apply
  button. Grid mode is the even spacing.
- **Custom**: shows the full wall editor (toolbar and canvas). Switching from Grid to
  Custom seeds the wall list from the current counts, so the "apply replaces walls"
  interaction disappears.

The mode is part of the entry's editing state, not a new persisted concept: the plan
format already stores walls; None means no walls, Grid means walls generated from counts,
Custom means the stored wall list. Loading an entry infers the mode from its walls where
that matters, or the editor simply opens in the mode matching the data (no walls: None;
otherwise Custom).

More options keeps only quantity, magnet holes, and notes.

## Constraints

- Reuse the existing wall editor component and the existing even-spacing wall generation
  logic (single source, per convention 10); the control and its state live in one shared
  place consumed by both tabs, not duplicated per tab.
- No engine changes expected; this is UI-layer reorganization.
- UI text follows the existing conventions (complete sentences, no em-dash character).
