import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import {
  arcFromThreePoints,
  cloneSketch,
  emptySketch,
  type Sketch,
  type SketchConstraint,
  type SketchDimension,
  type SketchEntity,
} from '../engine/sketch/model';
import type { DragTarget, SketchSolveResult } from '../engine/sketch/solve';
import type { MmPoint, TracedOutline } from '../engine/trace/types';
import { assertNever } from '../engine/plan/types';
import { solveSketchInWorker } from '../sketchClient';
import {
  extractRegions,
  polygonCentroid,
  regionToOutline,
  WELD_EPSILON_MM,
  type RegionFace,
} from '../engine/sketch/regions';
import { inferHVConstraint } from '../engine/sketch/autoInfer';

/** The drawing tool active on the sketch canvas. */
export type SketchTool =
  | 'select'
  | 'line'
  | 'arcThreePoint'
  | 'arcTangent'
  | 'circle'
  | 'rectangle'
  | 'slot'
  | 'mirror'
  | 'dimension';

/** Solver state shown on the canvas; idle before the first run. */
export type SolveState =
  | { status: 'idle' }
  | SketchSolveResult;

/**
 * State of the sketch workspace inside the Tool trace tab. All geometry
 * mutations edit the Sketch (engine data); the canvas only renders it. Every
 * mutation marks the sketch dirty and the workspace schedules a solve; the
 * store never solves implicitly so tests stay deterministic.
 */
export const useSketchEditor = defineStore('sketchEditor', () => {
  const sketch = ref<Sketch>(emptySketch());
  const activeTool = ref<SketchTool>('select');
  const selectedIds = ref<string[]>([]);
  /** Id of the constraint selected by clicking its glyph, or null. Mutually
   * exclusive with selectedIds: selecting an entity clears this, and
   * selectConstraint clears the entity selection. */
  const selectedConstraintId = ref<string | null>(null);
  /** Whether the constraint glyph layer renders on the canvas; the toolbar
   * eye toggle flips this. Defaults shown. */
  const glyphsVisible = ref(true);
  const solveState = shallowRef<SolveState>({ status: 'idle' });
  /**
   * Bounded regions of the last successfully solved, non-empty sketch, from
   * extractRegions (engine/sketch/regions.ts). Recomputed after every solve;
   * a conflicting or failed solve, or an empty sketch, clears this to [].
   */
  const regionFaces = shallowRef<RegionFace[]>([]);
  /** The extractRegions error (construction-only geometry, no enclosed
   * region) when the last recompute found zero faces; null otherwise. */
  const regionsError = ref<string | null>(null);
  /** Id of the region the user clicked, or null. Cleared whenever a
   * recompute no longer has that id; auto-picked when exactly one face. */
  const selectedRegionId = ref<string | null>(null);
  /** Centroid and area of the currently selected face, captured alongside
   * selectedRegionId. Face ids are assigned by traversal order, so a
   * recompute can silently renumber faces; recomputeRegions uses this to
   * tell "the same face kept its id" apart from "a different face now has
   * that id", which would otherwise let the finish flow carve the wrong
   * region. */
  const selectedRegionGeom = ref<{ centroid: MmPoint; areaMm2: number } | null>(null);
  /** Id of the sketched tool being re-edited, or null for a new shape. */
  const editingToolId = ref<string | null>(null);
  /** The open line/arc chain's last point id, or null when no chain is open. */
  const chainTailId = ref<string | null>(null);
  /** Id of the last segment (line or arc) added to the open chain, or null. */
  const chainTailSegmentId = ref<string | null>(null);
  /** Photo underlay: display only, never enters geometry. */
  const underlayUrl = ref<string | null>(null);
  const underlayOpacityPct = ref(40);
  /** Millimeters per underlay image pixel from the calibration line, or null. */
  const underlayMmPerPixel = ref<number | null>(null);
  /** Points clicked so far by a multi-click tool (arc, circle, mirror,
   * rectangle, slot), awaiting the tool's next click. Lives in the store
   * (rather than component-local state) so Escape-clearing, the typed-length
   * quick entry, and the live readout can all share the single source of
   * truth for what a multi-click tool has picked so far (convention 10). */
  const pendingClicks = ref<MmPoint[]>([]);
  /** Hit-tested existing point id for each entry in pendingClicks, or null. */
  const pendingHitPointIds = ref<(string | null)[]>([]);
  /** Current cursor position in mm while over the canvas, or null once the
   * pointer leaves it. Display state only, never the model; shared by the
   * rubber-band live readout and the typed-length quick entry's direction. */
  const cursorMm = ref<MmPoint | null>(null);
  /** Id of the constraint the pointer is hovering (e.g. a conflict row), or
   * null. Distinct from selectedConstraintId: hovering never changes the
   * selection, it only drives the canvas highlight. */
  const hoveredConstraintId = ref<string | null>(null);

  /**
   * A point-in-time undo entry. Chain state (chainTailId, chainTailSegmentId)
   * travels with the sketch: undoing a chain point must move the open chain's
   * tail back with it, or the next appendChainPoint call would draw a line
   * from a point the undo just deleted, corrupting the sketch.
   */
  type HistoryEntry = {
    sketch: Sketch;
    chainTailId: string | null;
    chainTailSegmentId: string | null;
  };

  /** Maximum number of undo steps retained, matching cavityEditSession's cap. */
  const HISTORY_CAP = 100;
  /** History entries to restore on undo, oldest first. Editor state, never saved. */
  const historyStack = ref<HistoryEntry[]>([]);
  /** Entries undone and available for redo. Editor state, never saved. */
  const redoStack = ref<HistoryEntry[]>([]);
  /**
   * Nesting depth of the current top-level mutating action. A mutating store
   * function (addPoint, appendChainPoint, and so on) can call another one
   * internally (appendChainPoint calls addPoint; addThreePointArc calls
   * addConstraint for a tangent); only the outermost call should record a
   * history snapshot, so one user click undoes as one step rather than one
   * step per internal helper call. A point drag opens the same scope for its
   * whole gesture (see beginPointDrag), so a drag-to-merge that adds a
   * coincident constraint mid-drag joins the drag's single undo step instead
   * of pushing a second one.
   */
  let recordingDepth = 0;

  /**
   * True from beginPointDrag until endPointDrag. solveNow's per-pointermove
   * drag solves must not recompute regions: extractRegions rebuilds the
   * whole O(n^2) curve arrangement, which is far too slow to run on every
   * drag frame. The previously computed faces stay displayed (stale, but
   * visually stable) until the drag ends and the final, non-drag solve
   * recomputes them once.
   */
  let dragInProgress = false;

  /** Captures the current sketch and chain state as one history entry. */
  function captureHistoryEntry(): HistoryEntry {
    return {
      sketch: cloneSketch(sketch.value),
      chainTailId: chainTailId.value,
      chainTailSegmentId: chainTailSegmentId.value,
    };
  }

  /** Pushes the current state onto the undo stack and clears the redo stack. */
  function pushHistorySnapshot(): void {
    historyStack.value.push(captureHistoryEntry());
    if (historyStack.value.length > HISTORY_CAP) historyStack.value.shift();
    redoStack.value = [];
  }

  /** Marks the start of a mutating action; only the outermost call snapshots. */
  function beginMutation(): void {
    if (recordingDepth === 0) pushHistorySnapshot();
    recordingDepth += 1;
  }

  /** Marks the end of a mutating action. */
  function endMutation(): void {
    recordingDepth -= 1;
  }

  /**
   * Opens the history scope for a point drag. Called once, when a drag
   * crosses the pointer-move threshold and starts, not on every pointermove:
   * the drag's live solver writebacks in solveNow must not push snapshots, so
   * the whole drag undoes as the single step it visually was. The scope stays
   * open (via the same recordingDepth guard beginMutation uses) until
   * endPointDrag closes it, so a drag-to-merge's addCoincidentIfAbsent call
   * lands inside this one step instead of pushing its own.
   */
  function beginPointDrag(): void {
    beginMutation();
    dragInProgress = true;
  }

  /** Closes the history scope opened by beginPointDrag. */
  function endPointDrag(): void {
    endMutation();
    dragInProgress = false;
  }

  /**
   * Runs fn inside a single mutation scope so any store-mutating calls it
   * makes (addPoint, addDimension, and so on) push one combined undo step
   * instead of one per call. Uses the same recordingDepth guard as
   * beginMutation/endMutation, so nesting inside an already-open scope (e.g.
   * a point drag) is safe. Callers that perform one user gesture as two
   * mutating store calls (a typed-length commit that both places geometry
   * and adds its dimension, or a dimension draft that adds then sets a
   * value) should wrap the pair here so one undo removes both.
   */
  function runGrouped(fn: () => void): void {
    beginMutation();
    try {
      fn();
    } finally {
      endMutation();
    }
  }

  /** Restores a history entry: replaces the sketch and chain state, drops
   * selected ids the snapshot no longer has, and bumps generation so a solve
   * can be rescheduled. */
  function applyHistoryEntry(entry: HistoryEntry): void {
    sketch.value = entry.sketch;
    const survivingIds = new Set(entry.sketch.entities.map((e) => e.id));
    const survivingConstraintIds = new Set(entry.sketch.constraints.map((c) => c.id));
    selectedIds.value = selectedIds.value.filter((id) => survivingIds.has(id));
    if (
      selectedConstraintId.value !== null &&
      !survivingConstraintIds.has(selectedConstraintId.value)
    ) {
      selectedConstraintId.value = null;
    }
    chainTailId.value = entry.chainTailId !== null && survivingIds.has(entry.chainTailId)
      ? entry.chainTailId
      : null;
    chainTailSegmentId.value =
      entry.chainTailSegmentId !== null && survivingIds.has(entry.chainTailSegmentId)
        ? entry.chainTailSegmentId
        : null;
    bumpGeneration();
  }

  /** Steps the sketch back one snapshot, moving the current state to redo. */
  function undo(): void {
    const previous = historyStack.value.pop();
    if (previous === undefined) return;
    redoStack.value.push(captureHistoryEntry());
    applyHistoryEntry(previous);
  }

  /** Re-applies the most recently undone snapshot. */
  function redo(): void {
    const next = redoStack.value.pop();
    if (next === undefined) return;
    historyStack.value.push(captureHistoryEntry());
    applyHistoryEntry(next);
  }

  let idCounter = 0;
  /** Sketch-unique id; sequential so saved sketches diff readably. */
  function nextId(): string {
    idCounter += 1;
    return `s${idCounter}`;
  }

  /**
   * Bumped by every mutation of sketch.value. solveNow captures it before
   * awaiting the worker and discards a stale result if it no longer matches,
   * so a concurrent edit is never clobbered by a slower earlier solve.
   */
  let generation = 0;
  function bumpGeneration(): void {
    generation += 1;
  }

  function pointById(id: string): { x: number; y: number } | null {
    const entity = sketch.value.entities.find((e) => e.id === id);
    return entity !== undefined && entity.kind === 'point' ? { x: entity.x, y: entity.y } : null;
  }

  function startNewSketch(): void {
    sketch.value = emptySketch();
    activeTool.value = 'select';
    selectedIds.value = [];
    selectedConstraintId.value = null;
    solveState.value = { status: 'idle' };
    regionFaces.value = [];
    regionsError.value = null;
    selectedRegionId.value = null;
    selectedRegionGeom.value = null;
    editingToolId.value = null;
    chainTailId.value = null;
    chainTailSegmentId.value = null;
    underlayUrl.value = null;
    underlayOpacityPct.value = 40;
    underlayMmPerPixel.value = null;
    pendingClicks.value = [];
    pendingHitPointIds.value = [];
    cursorMm.value = null;
    hoveredConstraintId.value = null;
    glyphsVisible.value = true;
    idCounter = 0;
    historyStack.value = [];
    redoStack.value = [];
    recordingDepth = 0;
    bumpGeneration();
  }

  /** Opens an existing sketch (deep-copied) for editing a sketched tool. */
  function loadSketch(source: Sketch, toolId: string): void {
    startNewSketch();
    sketch.value = cloneSketch(source);
    bumpGeneration();
    editingToolId.value = toolId;
    // Continue id numbering above any existing s<N> ids.
    for (const entity of sketch.value.entities) {
      const match = /^s(\d+)$/.exec(entity.id);
      if (match) idCounter = Math.max(idCounter, Number(match[1]));
    }
    for (const constraint of sketch.value.constraints) {
      const match = /^s(\d+)$/.exec(constraint.id);
      if (match) idCounter = Math.max(idCounter, Number(match[1]));
    }
  }

  function addPoint(at: MmPoint, construction = false): string {
    beginMutation();
    try {
      const id = nextId();
      sketch.value.entities.push({ kind: 'point', id, x: at.x, y: at.y, construction });
      bumpGeneration();
      return id;
    } finally {
      endMutation();
    }
  }

  /**
   * Appends a point to the open line chain, creating a line from the chain
   * tail when one exists. When pointId names an existing sketch point (the
   * component's click-to-point snapping), that point is reused instead of
   * creating a new one; this is how a brand-new chain started on an existing
   * point joins it, and how a chain continuing onto an existing point closes
   * two chains at a shared corner. Returns the point id used.
   *
   * When the new segment falls within the auto H/V snap band (see
   * engine/sketch/autoInfer.ts), a horizontal or vertical constraint is added
   * to the new line automatically, unless suppressAutoHV is set (the Alt-key
   * suppression the canvas wires up).
   */
  function appendChainPoint(at: MmPoint, pointId?: string, suppressAutoHV = false): string | null {
    beginMutation();
    try {
      const startCoord = chainTailId.value !== null ? pointById(chainTailId.value) : null;
      const usedPointId = pointId ?? addPoint(at);
      if (chainTailId.value !== null && startCoord !== null) {
        const lineId = nextId();
        sketch.value.entities.push({
          kind: 'line',
          id: lineId,
          p1Id: chainTailId.value,
          p2Id: usedPointId,
          construction: false,
        });
        chainTailSegmentId.value = lineId;
        if (!suppressAutoHV) {
          const endCoord = pointById(usedPointId) ?? at;
          const inferred = inferHVConstraint(endCoord.x - startCoord.x, endCoord.y - startCoord.y);
          if (inferred !== null) {
            addConstraint({ kind: inferred, id: nextId(), lineId });
          }
        }
        bumpGeneration();
      }
      chainTailId.value = usedPointId;
      return usedPointId;
    } finally {
      endMutation();
    }
  }

  /** Closes the open chain onto an existing point and ends the chain. */
  function closeChainTo(pointId: string): void {
    if (chainTailId.value === null || chainTailId.value === pointId) return;
    beginMutation();
    try {
      sketch.value.entities.push({
        kind: 'line',
        id: nextId(),
        p1Id: chainTailId.value,
        p2Id: pointId,
        construction: false,
      });
      chainTailId.value = null;
      chainTailSegmentId.value = null;
      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  /** Ends the open chain without closing it. */
  function endChain(): void {
    chainTailId.value = null;
    chainTailSegmentId.value = null;
  }

  /** Adds a circle; centerPointId reuses an existing sketch point (the
   * component's click-to-point snapping) instead of creating a new one.
   * Returns the new circle's id, so a caller (the typed-diameter quick
   * entry) can add a dimension on it. */
  function addCircle(center: MmPoint, radiusMm: number, centerPointId?: string): string {
    beginMutation();
    try {
      const centerId = centerPointId ?? addPoint(center);
      const id = nextId();
      sketch.value.entities.push({
        kind: 'circle',
        id,
        centerId,
        radiusMm,
        construction: false,
      });
      bumpGeneration();
      return id;
    } finally {
      endMutation();
    }
  }

  /**
   * Adds a rectangle from two opposite corners: four points, four lines
   * sharing point ids at the corners (coincident by construction, no
   * separate coincident constraint needed), with horizontal constraints on
   * the top and bottom lines and vertical constraints on the two sides.
   */
  function addRectangle(corner1: MmPoint, corner2: MmPoint): void {
    beginMutation();
    try {
      const topLeft = { x: Math.min(corner1.x, corner2.x), y: Math.min(corner1.y, corner2.y) };
      const bottomRight = { x: Math.max(corner1.x, corner2.x), y: Math.max(corner1.y, corner2.y) };
      const topRight = { x: bottomRight.x, y: topLeft.y };
      const bottomLeft = { x: topLeft.x, y: bottomRight.y };
      const p0 = addPoint(topLeft);
      const p1 = addPoint(topRight);
      const p2 = addPoint(bottomRight);
      const p3 = addPoint(bottomLeft);
      const topLineId = nextId();
      sketch.value.entities.push({
        kind: 'line', id: topLineId, p1Id: p0, p2Id: p1, construction: false,
      });
      const rightLineId = nextId();
      sketch.value.entities.push({
        kind: 'line', id: rightLineId, p1Id: p1, p2Id: p2, construction: false,
      });
      const bottomLineId = nextId();
      sketch.value.entities.push({
        kind: 'line', id: bottomLineId, p1Id: p2, p2Id: p3, construction: false,
      });
      const leftLineId = nextId();
      sketch.value.entities.push({
        kind: 'line', id: leftLineId, p1Id: p3, p2Id: p0, construction: false,
      });
      addConstraint({ kind: 'horizontal', id: nextId(), lineId: topLineId });
      addConstraint({ kind: 'horizontal', id: nextId(), lineId: bottomLineId });
      addConstraint({ kind: 'vertical', id: nextId(), lineId: leftLineId });
      addConstraint({ kind: 'vertical', id: nextId(), lineId: rightLineId });
      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  /**
   * Adds a slot (the canonical elongated tool pocket / capsule shape): two
   * parallel lines offset from the axis by half the width, and two
   * semicircular end arcs centered on the axis endpoints. Tangent
   * constraints at all four line/arc junctions, plus a parallel constraint
   * between the two side lines, keep the shape a slot under drag; a single
   * diameter dimension on one end arc drives both ends to the same width
   * because both arcs are tangent to the very same pair of lines, so the
   * shared line separation forces identical radius on both ends. This is
   * done entirely with the constraint kinds model.ts already has (tangent,
   * parallel, diameter); no separate "equal radius" constraint kind exists
   * or is needed.
   */
  function addSlot(axisStart: MmPoint, axisEnd: MmPoint, widthMm: number): void {
    beginMutation();
    try {
      const dx = axisEnd.x - axisStart.x;
      const dy = axisEnd.y - axisStart.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;
      const r = widthMm / 2;

      const centerStartId = addPoint(axisStart);
      const centerEndId = addPoint(axisEnd);

      const topStart = { x: axisStart.x + nx * r, y: axisStart.y + ny * r };
      const bottomStart = { x: axisStart.x - nx * r, y: axisStart.y - ny * r };
      const topEnd = { x: axisEnd.x + nx * r, y: axisEnd.y + ny * r };
      const bottomEnd = { x: axisEnd.x - nx * r, y: axisEnd.y - ny * r };

      const topStartId = addPoint(topStart);
      const bottomStartId = addPoint(bottomStart);
      const topEndId = addPoint(topEnd);
      const bottomEndId = addPoint(bottomEnd);

      const topLineId = nextId();
      sketch.value.entities.push({
        kind: 'line', id: topLineId, p1Id: topStartId, p2Id: topEndId, construction: false,
      });
      const bottomLineId = nextId();
      sketch.value.entities.push({
        kind: 'line', id: bottomLineId, p1Id: bottomStartId, p2Id: bottomEndId, construction: false,
      });

      // End arc at axisStart: the semicircle bulging away from axisEnd. The
      // "through" point extends the axis backward past axisStart so it lies
      // on the far side of the semicircle; arcFromThreePoints derives the
      // orientation (ccw) from it, matching addThreePointArc's convention.
      const outwardStart = { x: axisStart.x - ux * r, y: axisStart.y - uy * r };
      const startArcDerived = arcFromThreePoints(topStart, outwardStart, bottomStart);
      const startCcw = startArcDerived?.ccw ?? true;
      const startArcId = nextId();
      sketch.value.entities.push({
        kind: 'arc',
        id: startArcId,
        centerId: centerStartId,
        startId: startCcw ? topStartId : bottomStartId,
        endId: startCcw ? bottomStartId : topStartId,
        construction: false,
      });

      // End arc at axisEnd: the semicircle bulging away from axisStart.
      const outwardEnd = { x: axisEnd.x + ux * r, y: axisEnd.y + uy * r };
      const endArcDerived = arcFromThreePoints(topEnd, outwardEnd, bottomEnd);
      const endCcw = endArcDerived?.ccw ?? true;
      const endArcId = nextId();
      sketch.value.entities.push({
        kind: 'arc',
        id: endArcId,
        centerId: centerEndId,
        startId: endCcw ? topEndId : bottomEndId,
        endId: endCcw ? bottomEndId : topEndId,
        construction: false,
      });

      addConstraint({ kind: 'parallel', id: nextId(), l1Id: topLineId, l2Id: bottomLineId });
      addConstraint({ kind: 'tangent', id: nextId(), aId: topLineId, bId: startArcId });
      addConstraint({ kind: 'tangent', id: nextId(), aId: bottomLineId, bId: startArcId });
      addConstraint({ kind: 'tangent', id: nextId(), aId: topLineId, bId: endArcId });
      addConstraint({ kind: 'tangent', id: nextId(), aId: bottomLineId, bId: endArcId });
      addDimension({ kind: 'diameter', id: nextId(), entityId: startArcId, mm: widthMm });

      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  /** Clears the multi-click tool's pending points; Escape and tool switches
   * both go through this single path. */
  function clearPendingClicks(): void {
    pendingClicks.value = [];
    pendingHitPointIds.value = [];
  }

  /**
   * Adds a three-point arc. Point order start, end, then a point the arc
   * passes through, matching the canvas tool. When an open chain exists, the
   * chain tail point is reused as the arc's start (no duplicate point) and
   * the chain continues from the arc's end; passing endPointId (an existing
   * point the caller hit-tested, typically the chain's start) closes the
   * chain onto it instead, the same way closeChainTo does for lines. With
   * tangent true, a tangent constraint is added between the chain's previous
   * segment and this arc (the arcTangent tool). startPointId reuses an
   * existing sketch point for the arc's start when no chain is open (the
   * component's click-to-point snapping); it is ignored while a chain is
   * open, since the chain tail is the start in that case. Returns false for
   * collinear picks, which the workspace reports as a status row.
   */
  function addThreePointArc(
    start: MmPoint,
    end: MmPoint,
    through: MmPoint,
    tangent = false,
    endPointId?: string,
    startPointId?: string,
  ): boolean {
    const chainStartId = chainTailId.value;
    const chainStartPoint = chainStartId !== null ? pointById(chainStartId) : null;
    const startAt = chainStartPoint ?? start;
    const derived = arcFromThreePoints(startAt, through, end);
    if (derived === null) return false;
    beginMutation();
    try {
    const centerId = addPoint(derived.center);
    const previousSegmentId = chainTailSegmentId.value;
    const startId = chainStartId ?? startPointId ?? addPoint(startAt);
    const closing = endPointId !== undefined && endPointId !== startId;
    const endId = closing ? endPointId! : addPoint(end);
    const arcId = nextId();
    // The stored arc always runs counterclockwise from start to end; a
    // clockwise pick stores the endpoints swapped.
    sketch.value.entities.push({
      kind: 'arc',
      id: arcId,
      centerId,
      startId: derived.ccw ? startId : endId,
      endId: derived.ccw ? endId : startId,
      construction: false,
    });
    if (tangent && chainStartId !== null && previousSegmentId !== null) {
      addConstraint({ kind: 'tangent', id: nextId(), aId: previousSegmentId, bId: arcId });
    }
    if (chainStartId !== null) {
      if (closing) {
        chainTailId.value = null;
        chainTailSegmentId.value = null;
      } else {
        chainTailId.value = endId;
        chainTailSegmentId.value = arcId;
      }
    }
    bumpGeneration();
    return true;
    } finally {
      endMutation();
    }
  }

  /**
   * Adds a mirror (construction) line plus a symmetric constraint between two
   * selected points, the spec's mirror-line workflow.
   */
  function addMirrorLine(a: MmPoint, b: MmPoint): string {
    beginMutation();
    try {
      const p1 = addPoint(a, true);
      const p2 = addPoint(b, true);
      const lineId = nextId();
      sketch.value.entities.push({
        kind: 'line',
        id: lineId,
        p1Id: p1,
        p2Id: p2,
        construction: true,
      });
      bumpGeneration();
      return lineId;
    } finally {
      endMutation();
    }
  }

  function addConstraint(constraint: SketchConstraint): void {
    beginMutation();
    try {
      sketch.value.constraints.push(constraint);
      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  function addDimension(dimension: SketchDimension): void {
    beginMutation();
    try {
      sketch.value.constraints.push(dimension);
      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  /** Rewrites a dimension's value in place (click-to-edit label). */
  function setDimensionValue(constraintId: string, value: number): void {
    const dimension = sketch.value.constraints.find((c) => c.id === constraintId);
    if (dimension === undefined) return;
    beginMutation();
    try {
      switch (dimension.kind) {
        case 'length':
        case 'distance':
        case 'radius':
        case 'diameter':
          dimension.mm = value;
          break;
        case 'angle':
          dimension.degrees = value;
          break;
        case 'coincident':
        case 'horizontal':
        case 'vertical':
        case 'parallel':
        case 'perpendicular':
        case 'tangent':
        case 'symmetric':
          // Not dimensions; nothing to edit.
          break;
        default:
          return assertNever(dimension);
      }
      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  /**
   * Adds a coincident constraint between two points unless one already ties
   * that unordered pair, or the two ids are the same point (a normal no-op:
   * dropping a drag back onto itself is not an error condition). This is the
   * drag-merge workflow: releasing a dragged point onto another point.
   */
  function addCoincidentIfAbsent(p1Id: string, p2Id: string): void {
    if (p1Id === p2Id) return;
    const exists = sketch.value.constraints.some(
      (c) =>
        c.kind === 'coincident' &&
        ((c.p1Id === p1Id && c.p2Id === p2Id) || (c.p1Id === p2Id && c.p2Id === p1Id)),
    );
    if (exists) return;
    addConstraint({ kind: 'coincident', id: nextId(), p1Id, p2Id });
  }

  function removeConstraint(constraintId: string): void {
    beginMutation();
    try {
      sketch.value.constraints = sketch.value.constraints.filter((c) => c.id !== constraintId);
      if (selectedConstraintId.value === constraintId) selectedConstraintId.value = null;
      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  /** Selects a constraint (clicked via its glyph), clearing any entity
   * selection; the watcher below clears this back when an entity is
   * selected, so the two selections stay mutually exclusive. */
  function selectConstraint(constraintId: string): void {
    selectedIds.value = [];
    selectedConstraintId.value = constraintId;
  }

  // Selecting an entity clears the constraint selection; selectConstraint
  // clears the entity selection directly above. deep:true is required
  // because selectedIds is mutated in place (push/splice) by several
  // callers, not always reassigned.
  watch(
    selectedIds,
    (ids) => {
      if (ids.length > 0 && selectedConstraintId.value !== null) selectedConstraintId.value = null;
    },
    { deep: true, flush: 'sync' },
  );

  /** The point ids a non-point entity refers to, or [] for a point itself. */
  function entityPointRefs(entity: SketchEntity): string[] {
    switch (entity.kind) {
      case 'point':
        return [];
      case 'line':
        return [entity.p1Id, entity.p2Id];
      case 'arc':
        return [entity.centerId, entity.startId, entity.endId];
      case 'circle':
        return [entity.centerId];
      default:
        return assertNever(entity);
    }
  }

  /** Entity ids referenced by the hovered constraint (e.g. a hovered conflict
   * row), for the canvas to highlight with the selection accent color; []
   * when nothing is hovered. */
  const hoveredEntityIds = computed<string[]>(() => {
    if (hoveredConstraintId.value === null) return [];
    const constraint = sketch.value.constraints.find((c) => c.id === hoveredConstraintId.value);
    return constraint === undefined ? [] : constraintRefIds(constraint);
  });

  /** Every entity or point id a constraint refers to. */
  function constraintRefIds(constraint: SketchConstraint): string[] {
    switch (constraint.kind) {
      case 'coincident':
        return [constraint.p1Id, constraint.p2Id];
      case 'horizontal':
      case 'vertical':
        return [constraint.lineId];
      case 'parallel':
      case 'perpendicular':
        return [constraint.l1Id, constraint.l2Id];
      case 'tangent':
        return [constraint.aId, constraint.bId];
      case 'symmetric':
        return [constraint.p1Id, constraint.p2Id, constraint.mirrorLineId];
      case 'length':
        return [constraint.lineId];
      case 'distance':
        return [constraint.p1Id, constraint.p2Id];
      case 'radius':
      case 'diameter':
        return [constraint.entityId];
      case 'angle':
        return [constraint.l1Id, constraint.l2Id];
      default:
        return assertNever(constraint);
    }
  }

  /**
   * Deletes the given entities. Points that become orphaned (endpoints of the
   * deleted entities not referenced by any remaining entity or constraint)
   * are removed too, so a shared endpoint between chained lines survives
   * while a far endpoint used nowhere else does not. Every constraint that
   * references a removed entity or a removed point is also dropped, and the
   * removed ids are cleared from the selection.
   */
  function deleteEntities(ids: string[]): void {
    if (ids.length === 0) return;
    beginMutation();
    try {
    const removedIds = new Set(ids);
    const removedEntities = sketch.value.entities.filter((e) => removedIds.has(e.id));
    // Candidate points: endpoints of the deleted entities, not themselves
    // already among the removed ids.
    const candidatePointIds = new Set<string>();
    for (const entity of removedEntities) {
      for (const pointId of entityPointRefs(entity)) {
        if (!removedIds.has(pointId)) candidatePointIds.add(pointId);
      }
    }
    const remainingEntities = sketch.value.entities.filter((e) => !removedIds.has(e.id));
    const survivingConstraints = sketch.value.constraints.filter(
      (c) => !constraintRefIds(c).some((id) => removedIds.has(id)),
    );
    const orphanedPointIds = new Set<string>();
    for (const pointId of candidatePointIds) {
      const usedByEntity = remainingEntities.some((e) => entityPointRefs(e).includes(pointId));
      const usedByConstraint = survivingConstraints.some((c) =>
        constraintRefIds(c).includes(pointId),
      );
      if (!usedByEntity && !usedByConstraint) orphanedPointIds.add(pointId);
    }
    const finalRemovedIds = new Set<string>([...removedIds, ...orphanedPointIds]);
    sketch.value.entities = sketch.value.entities.filter((e) => !finalRemovedIds.has(e.id));
    sketch.value.constraints = sketch.value.constraints.filter(
      (c) => !constraintRefIds(c).some((id) => finalRemovedIds.has(id)),
    );
    selectedIds.value = selectedIds.value.filter((id) => !finalRemovedIds.has(id));
    if (
      selectedConstraintId.value !== null &&
      !sketch.value.constraints.some((c) => c.id === selectedConstraintId.value)
    ) {
      selectedConstraintId.value = null;
    }
    bumpGeneration();
    } finally {
      endMutation();
    }
  }

  function toggleConstruction(entityId: string): void {
    const entity = sketch.value.entities.find((e) => e.id === entityId);
    if (entity === undefined) return;
    beginMutation();
    try {
      entity.construction = !entity.construction;
      bumpGeneration();
    } finally {
      endMutation();
    }
  }

  /** Fallback message when regionsError is null but there are no faces
   * (an empty sketch); mirrors profile.ts's/regions.ts's own wording. */
  const NO_REGIONS_FALLBACK =
    'The sketch has no enclosed region. Draw lines, arcs or a circle that close off an area.';
  /** Shown by the finish flow when several regions exist and none is picked. */
  const PICK_A_REGION =
    'This sketch has more than one enclosed region. Click a region on the canvas to select it, then finish again.';

  /**
   * Recomputes regionFaces/regionsError from the current (solved) sketch.
   * Cheap-guarded on an empty sketch. Auto-picks selectedRegionId when
   * exactly one face results, and drops it when the recompute no longer has
   * a face with that id (match is by id only within this one recompute).
   */
  function recomputeRegions(): void {
    if (sketch.value.entities.length === 0) {
      regionFaces.value = [];
      regionsError.value = null;
      selectedRegionId.value = null;
      return;
    }
    const result = extractRegions(sketch.value);
    if (!result.ok) {
      regionFaces.value = [];
      regionsError.value = result.error;
      selectedRegionId.value = null;
      return;
    }
    regionFaces.value = result.faces;
    regionsError.value = null;
    if (selectedRegionId.value !== null) {
      const geom = selectedRegionGeom.value;
      // Face ids are positional (assigned by traversal order), so a
      // recompute can renumber them even when the previously selected face's
      // geometry is unchanged, and can also hand the old id to a completely
      // different face. Search all faces for the one that is geometrically
      // the same face (not merely whichever face now carries the old id).
      const stillThere = geom === null ? undefined : result.faces.find((f) => isSameFace(f, geom));
      selectedRegionId.value = stillThere?.id ?? null;
    }
    if (selectedRegionId.value === null && result.faces.length === 1) {
      // Single-face sketches auto-repick even after a geometry change: with
      // only one face there is no ambiguity to get wrong.
      selectedRegionId.value = result.faces[0].id;
    }
    const selected = result.faces.find((f) => f.id === selectedRegionId.value) ?? null;
    selectedRegionGeom.value =
      selected === null ? null : { centroid: polygonCentroid(selected.outer), areaMm2: selected.areaMm2 };
  }

  /** True when `face` is geometrically the same region as the one described
   * by `geom` (a prior selection's centroid and area), not merely a
   * different face that happened to inherit the same positional id. */
  function isSameFace(face: RegionFace, geom: { centroid: MmPoint; areaMm2: number }): boolean {
    const centroid = polygonCentroid(face.outer);
    const centroidDistance = Math.hypot(centroid.x - geom.centroid.x, centroid.y - geom.centroid.y);
    const areaTolerance = 1e-6 * Math.max(1, Math.abs(geom.areaMm2));
    return (
      centroidDistance <= WELD_EPSILON_MM && Math.abs(face.areaMm2 - geom.areaMm2) <= areaTolerance
    );
  }

  /** Clears regions to the no-regions state, for a conflicting/failed solve. */
  function clearRegions(): void {
    regionFaces.value = [];
    regionsError.value = null;
    selectedRegionId.value = null;
    selectedRegionGeom.value = null;
  }

  /** Selects a region by clicking its shaded face on the canvas. */
  function selectRegion(regionId: string): void {
    selectedRegionId.value = regionId;
    const face = regionFaces.value.find((f) => f.id === regionId) ?? null;
    selectedRegionGeom.value =
      face === null ? null : { centroid: polygonCentroid(face.outer), areaMm2: face.areaMm2 };
  }

  /**
   * The outline the finish flow should use, per the region count: zero faces
   * surfaces the extraction error (or the fallback for an empty sketch), one
   * face is used automatically, several faces require a prior selectRegion
   * call or this returns the user-worded pick-a-region message.
   */
  function outlineForFinish(): { ok: true; outline: TracedOutline } | { ok: false; error: string } {
    if (regionFaces.value.length === 0) {
      return { ok: false, error: regionsError.value ?? NO_REGIONS_FALLBACK };
    }
    if (regionFaces.value.length === 1) {
      return { ok: true, outline: regionToOutline(regionFaces.value[0]) };
    }
    const selected = regionFaces.value.find((f) => f.id === selectedRegionId.value);
    if (selected === undefined) return { ok: false, error: PICK_A_REGION };
    return { ok: true, outline: regionToOutline(selected) };
  }

  /**
   * Runs the solver in the sketch worker over the current sketch, writing
   * solved coordinates back on success. With a drag target this is the
   * driven-point workflow used while a point is dragged. Regions are
   * recomputed from the freshly solved sketch on success; a conflicting or
   * failed solve clears them, since neither leaves a sketch worth extracting.
   * Both are skipped entirely while a point drag is in progress (see
   * dragInProgress): the drag's per-pointermove solves keep the last
   * computed faces on screen, and the final solve after endPointDrag (called
   * with dragInProgress already false) recomputes once for the settled
   * sketch.
   */
  async function solveNow(drag?: DragTarget): Promise<void> {
    const requestGeneration = generation;
    let result: SketchSolveResult;
    try {
      result = await solveSketchInWorker(
        JSON.parse(JSON.stringify(sketch.value)) as Sketch,
        drag,
      );
    } catch {
      // A concurrent edit already superseded this request; a later solve
      // covers the current sketch, so the failure would be stale noise.
      if (generation !== requestGeneration) return;
      solveState.value = {
        status: 'failed',
        message: 'The sketch solver could not be started. Reload the page to try again.',
      };
      if (!dragInProgress) clearRegions();
      return;
    }
    // The sketch changed while the worker was solving; discard the now-stale
    // result instead of clobbering the concurrent edit.
    if (generation !== requestGeneration) return;
    solveState.value = result;
    if (result.status === 'solved') {
      sketch.value = result.sketch;
      if (!dragInProgress) recomputeRegions();
    } else if (!dragInProgress) {
      clearRegions();
    }
  }

  return {
    sketch,
    activeTool,
    selectedIds,
    selectedConstraintId,
    selectConstraint,
    glyphsVisible,
    solveState,
    regionFaces,
    regionsError,
    selectedRegionId,
    selectRegion,
    outlineForFinish,
    editingToolId,
    chainTailId,
    chainTailSegmentId,
    underlayUrl,
    underlayOpacityPct,
    underlayMmPerPixel,
    pendingClicks,
    pendingHitPointIds,
    cursorMm,
    hoveredConstraintId,
    hoveredEntityIds,
    clearPendingClicks,
    nextId,
    startNewSketch,
    loadSketch,
    addPoint,
    appendChainPoint,
    closeChainTo,
    endChain,
    addCircle,
    addRectangle,
    addSlot,
    addThreePointArc,
    addMirrorLine,
    addConstraint,
    addCoincidentIfAbsent,
    addDimension,
    setDimensionValue,
    removeConstraint,
    deleteEntities,
    toggleConstruction,
    solveNow,
    historyStack,
    redoStack,
    beginPointDrag,
    endPointDrag,
    beginMutation,
    endMutation,
    runGrouped,
    undo,
    redo,
  };
});
