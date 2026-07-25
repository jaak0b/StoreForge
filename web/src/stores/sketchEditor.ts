import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
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
import type { MmPoint } from '../engine/trace/types';
import { assertNever } from '../engine/plan/types';
import { solveSketchInWorker } from '../sketchClient';

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
  const solveState = shallowRef<SolveState>({ status: 'idle' });
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
    solveState.value = { status: 'idle' };
    editingToolId.value = null;
    chainTailId.value = null;
    chainTailSegmentId.value = null;
    underlayUrl.value = null;
    underlayOpacityPct.value = 40;
    underlayMmPerPixel.value = null;
    idCounter = 0;
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
    const id = nextId();
    sketch.value.entities.push({ kind: 'point', id, x: at.x, y: at.y, construction });
    bumpGeneration();
    return id;
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
  }

  /** Closes the open chain onto an existing point and ends the chain. */
  function closeChainTo(pointId: string): void {
    if (chainTailId.value === null || chainTailId.value === pointId) return;
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
  }

  /** Ends the open chain without closing it. */
  function endChain(): void {
    chainTailId.value = null;
    chainTailSegmentId.value = null;
  }

  /** Adds a circle; centerPointId reuses an existing sketch point (the
   * component's click-to-point snapping) instead of creating a new one. */
  function addCircle(center: MmPoint, radiusMm: number, centerPointId?: string): void {
    const centerId = centerPointId ?? addPoint(center);
    sketch.value.entities.push({
      kind: 'circle',
      id: nextId(),
      centerId,
      radiusMm,
      construction: false,
    });
    bumpGeneration();
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
  }

  /**
   * Adds a mirror (construction) line plus a symmetric constraint between two
   * selected points, the spec's mirror-line workflow.
   */
  function addMirrorLine(a: MmPoint, b: MmPoint): string {
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
  }

  function addConstraint(constraint: SketchConstraint): void {
    sketch.value.constraints.push(constraint);
    bumpGeneration();
  }

  function addDimension(dimension: SketchDimension): void {
    sketch.value.constraints.push(dimension);
    bumpGeneration();
  }

  /** Rewrites a dimension's value in place (click-to-edit label). */
  function setDimensionValue(constraintId: string, value: number): void {
    const dimension = sketch.value.constraints.find((c) => c.id === constraintId);
    if (dimension === undefined) return;
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
  }

  function removeConstraint(constraintId: string): void {
    sketch.value.constraints = sketch.value.constraints.filter((c) => c.id !== constraintId);
    bumpGeneration();
  }

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
    bumpGeneration();
  }

  function toggleConstruction(entityId: string): void {
    const entity = sketch.value.entities.find((e) => e.id === entityId);
    if (entity === undefined) return;
    entity.construction = !entity.construction;
    bumpGeneration();
  }

  /**
   * Runs the solver in the sketch worker over the current sketch, writing
   * solved coordinates back on success. With a drag target this is the
   * driven-point workflow used while a point is dragged.
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
      return;
    }
    // The sketch changed while the worker was solving; discard the now-stale
    // result instead of clobbering the concurrent edit.
    if (generation !== requestGeneration) return;
    solveState.value = result;
    if (result.status === 'solved') {
      sketch.value = result.sketch;
    }
  }

  return {
    sketch,
    activeTool,
    selectedIds,
    solveState,
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
    addDimension,
    setDimensionValue,
    removeConstraint,
    deleteEntities,
    toggleConstruction,
    solveNow,
  };
});
