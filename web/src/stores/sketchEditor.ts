import { defineStore } from 'pinia';
import { ref, shallowRef, watch } from 'vue';
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
import { extractRegions, regionToOutline, type RegionFace } from '../engine/sketch/regions';

/** The drawing tool active on the sketch canvas. */
export type SketchTool =
  | 'select'
  | 'line'
  | 'arcThreePoint'
  | 'arcTangent'
  | 'circle'
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
  }

  /** Closes the history scope opened by beginPointDrag. */
  function endPointDrag(): void {
    endMutation();
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
    editingToolId.value = null;
    chainTailId.value = null;
    chainTailSegmentId.value = null;
    underlayUrl.value = null;
    underlayOpacityPct.value = 40;
    underlayMmPerPixel.value = null;
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
   */
  function appendChainPoint(at: MmPoint, pointId?: string): string | null {
    beginMutation();
    try {
      const usedPointId = pointId ?? addPoint(at);
      if (chainTailId.value !== null) {
        const lineId = nextId();
        sketch.value.entities.push({
          kind: 'line',
          id: lineId,
          p1Id: chainTailId.value,
          p2Id: usedPointId,
          construction: false,
        });
        chainTailSegmentId.value = lineId;
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
   * component's click-to-point snapping) instead of creating a new one. */
  function addCircle(center: MmPoint, radiusMm: number, centerPointId?: string): void {
    beginMutation();
    try {
      const centerId = centerPointId ?? addPoint(center);
      sketch.value.entities.push({
        kind: 'circle',
        id: nextId(),
        centerId,
        radiusMm,
        construction: false,
      });
      bumpGeneration();
    } finally {
      endMutation();
    }
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
    if (
      selectedRegionId.value !== null &&
      !result.faces.some((f) => f.id === selectedRegionId.value)
    ) {
      selectedRegionId.value = null;
    }
    if (selectedRegionId.value === null && result.faces.length === 1) {
      selectedRegionId.value = result.faces[0].id;
    }
  }

  /** Clears regions to the no-regions state, for a conflicting/failed solve. */
  function clearRegions(): void {
    regionFaces.value = [];
    regionsError.value = null;
    selectedRegionId.value = null;
  }

  /** Selects a region by clicking its shaded face on the canvas. */
  function selectRegion(regionId: string): void {
    selectedRegionId.value = regionId;
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
      clearRegions();
      return;
    }
    // The sketch changed while the worker was solving; discard the now-stale
    // result instead of clobbering the concurrent edit.
    if (generation !== requestGeneration) return;
    solveState.value = result;
    if (result.status === 'solved') {
      sketch.value = result.sketch;
      recomputeRegions();
    } else {
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
    underlayUrl,
    underlayOpacityPct,
    underlayMmPerPixel,
    nextId,
    startNewSketch,
    loadSketch,
    addPoint,
    appendChainPoint,
    closeChainTo,
    endChain,
    addCircle,
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
    undo,
    redo,
  };
});
