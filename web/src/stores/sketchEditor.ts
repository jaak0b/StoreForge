import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import {
  arcFromThreePoints,
  cloneSketch,
  emptySketch,
  type Sketch,
  type SketchConstraint,
  type SketchDimension,
} from '../engine/sketch/model';
import type { DragTarget, SketchSolveResult } from '../engine/sketch/solve';
import type { MmPoint } from '../engine/trace/types';
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

  function startNewSketch(): void {
    sketch.value = emptySketch();
    activeTool.value = 'select';
    selectedIds.value = [];
    solveState.value = { status: 'idle' };
    editingToolId.value = null;
    chainTailId.value = null;
    underlayUrl.value = null;
    underlayOpacityPct.value = 40;
    underlayMmPerPixel.value = null;
    idCounter = 0;
  }

  /** Opens an existing sketch (deep-copied) for editing a sketched tool. */
  function loadSketch(source: Sketch, toolId: string): void {
    startNewSketch();
    sketch.value = cloneSketch(source);
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
    return id;
  }

  /**
   * Appends a point to the open line chain, creating a line from the chain
   * tail when one exists. Returns the new point id.
   */
  function appendChainPoint(at: MmPoint): string | null {
    const pointId = addPoint(at);
    if (chainTailId.value !== null) {
      sketch.value.entities.push({
        kind: 'line',
        id: nextId(),
        p1Id: chainTailId.value,
        p2Id: pointId,
        construction: false,
      });
    }
    chainTailId.value = pointId;
    return pointId;
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
  }

  /** Ends the open chain without closing it. */
  function endChain(): void {
    chainTailId.value = null;
  }

  function addCircle(center: MmPoint, radiusMm: number): void {
    const centerId = addPoint(center);
    sketch.value.entities.push({
      kind: 'circle',
      id: nextId(),
      centerId,
      radiusMm,
      construction: false,
    });
  }

  /**
   * Adds a three-point arc. Point order start, end, then a point the arc
   * passes through, matching the canvas tool. Returns false for collinear
   * picks, which the workspace reports as a status row.
   */
  function addThreePointArc(start: MmPoint, end: MmPoint, through: MmPoint): boolean {
    const derived = arcFromThreePoints(start, through, end);
    if (derived === null) return false;
    const centerId = addPoint(derived.center);
    const startId = addPoint(start);
    const endId = addPoint(end);
    // The stored arc always runs counterclockwise from start to end; a
    // clockwise pick stores the endpoints swapped.
    sketch.value.entities.push({
      kind: 'arc',
      id: nextId(),
      centerId,
      startId: derived.ccw ? startId : endId,
      endId: derived.ccw ? endId : startId,
      construction: false,
    });
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
    return lineId;
  }

  function addConstraint(constraint: SketchConstraint): void {
    sketch.value.constraints.push(constraint);
  }

  function addDimension(dimension: SketchDimension): void {
    sketch.value.constraints.push(dimension);
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
      default: {
        const exhaustive: never = dimension;
        throw new Error(`Unhandled constraint kind: ${String(exhaustive)}`);
      }
    }
  }

  function removeConstraint(constraintId: string): void {
    sketch.value.constraints = sketch.value.constraints.filter((c) => c.id !== constraintId);
  }

  function toggleConstruction(entityId: string): void {
    const entity = sketch.value.entities.find((e) => e.id === entityId);
    if (entity === undefined) return;
    entity.construction = !entity.construction;
  }

  /**
   * Runs the solver in the sketch worker over the current sketch, writing
   * solved coordinates back on success. With a drag target this is the
   * driven-point workflow used while a point is dragged.
   */
  async function solveNow(drag?: DragTarget): Promise<void> {
    const result = await solveSketchInWorker(
      JSON.parse(JSON.stringify(sketch.value)) as Sketch,
      drag,
    );
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
    toggleConstruction,
    solveNow,
  };
});
