import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const solveMock = vi.fn();
vi.mock('../../src/sketchClient', () => ({
  solveSketchInWorker: (...args: unknown[]) => solveMock(...args),
}));

import { useSketchEditor } from '../../src/stores/sketchEditor';
import { extractProfile } from '../../src/engine/sketch/profile';
import {
  measureLineLength,
  measureRadius,
  measureDiameter,
  measurePointDistance,
  measureAngleBetweenLines,
  formatMm,
  parseDimensionValue,
} from '../../src/engine/sketch/measure';

beforeEach(() => {
  setActivePinia(createPinia());
  solveMock.mockReset();
  solveMock.mockImplementation(async (sketch) => ({ status: 'solved', sketch, dof: 4 }));
});

describe('useSketchEditor', () => {
  it('starts empty and adds a line chain sharing intermediate points', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const first = editor.appendChainPoint({ x: 0, y: 0 });
    const second = editor.appendChainPoint({ x: 30, y: 0 });
    const third = editor.appendChainPoint({ x: 30, y: 20 });
    expect(first).not.toBeNull();
    const lines = editor.sketch.entities.filter((e) => e.kind === 'line');
    const points = editor.sketch.entities.filter((e) => e.kind === 'point');
    expect(lines).toHaveLength(2);
    expect(points).toHaveLength(3);
    // Chained lines share the middle point instead of duplicating it.
    expect((lines[0] as { p2Id: string }).p2Id).toBe((lines[1] as { p1Id: string }).p1Id);
    expect(second).toBe((lines[1] as { p1Id: string }).p1Id);
    expect(third).toBe((lines[1] as { p2Id: string }).p2Id);
  });

  it('closes the chain onto its first point when finishing at it', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const first = editor.appendChainPoint({ x: 0, y: 0 })!;
    editor.appendChainPoint({ x: 30, y: 0 });
    editor.appendChainPoint({ x: 30, y: 20 });
    editor.closeChainTo(first);
    const lines = editor.sketch.entities.filter((e) => e.kind === 'line');
    expect(lines).toHaveLength(3);
    expect((lines[2] as { p2Id: string }).p2Id).toBe(first);
  });

  it('adds a circle with center and radius', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.addCircle({ x: 10, y: 10 }, 12.5);
    const circle = editor.sketch.entities.find((e) => e.kind === 'circle');
    expect(circle).toBeDefined();
    expect((circle as { radiusMm: number }).radiusMm).toBeCloseTo(12.5);
  });

  it('adds a dimension and solves after the edit', async () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 28, y: 3 });
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    editor.addDimension({ kind: 'length', id: editor.nextId(), lineId: line.id, mm: 30 });
    await editor.solveNow();
    expect(solveMock).toHaveBeenCalled();
    expect(editor.solveState.status).toBe('solved');
  });

  it('commits an untouched measured default at the rounded value the user saw', () => {
    // Mirrors SketchWorkspace's beginDimensionFromSelection + commitDimensionDraft
    // flow: a line whose raw length is an irrational-looking double gets a
    // dimension seeded from the rounded measured value, and committing the
    // draft text unedited (Enter with no typing) must store that same
    // rounded figure, not the raw double the geometry actually measures to.
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: Math.SQRT2 * 25.87, y: 0 });
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    const rawMeasured = measureLineLength(editor.sketch, line.id);
    expect(Number.isInteger(rawMeasured * 100)).toBe(false);
    const seeded = formatMm(rawMeasured);
    const id = editor.nextId();
    editor.addDimension({ kind: 'length', id, lineId: line.id, mm: seeded });
    // Committing the draft text unedited (String(seeded), Enter without typing).
    const committed = parseDimensionValue(String(seeded));
    expect(committed).not.toBeNull();
    editor.setDimensionValue(id, committed!);
    const constraint = editor.sketch.constraints.find((c) => c.id === id) as { mm: number };
    expect(constraint.mm).toBe(seeded);
    expect(constraint.mm).not.toBe(rawMeasured);
  });

  it('rejects a dimension value with trailing garbage instead of taking a numeric prefix', () => {
    expect(parseDimensionValue('36.58743339531354SS')).toBeNull();
  });

  it('keeps the conflicting constraint ids for the diagnostics rows', async () => {
    solveMock.mockResolvedValue({ status: 'conflicting', conflictingConstraintIds: ['cX'] });
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 10, y: 0 });
    await editor.solveNow();
    expect(editor.solveState.status).toBe('conflicting');
    if (editor.solveState.status === 'conflicting') {
      expect(editor.solveState.conflictingConstraintIds).toEqual(['cX']);
    }
  });

  it('toggles the construction flag on a selected entity', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 10, y: 0 });
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    editor.toggleConstruction(line.id);
    expect(line.construction).toBe(true);
  });

  it('chains a line into an arc into a line, sharing point ids end to end', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const origin = editor.appendChainPoint({ x: 0, y: 0 })!;
    const arcStart = editor.appendChainPoint({ x: 30, y: 0 })!;
    // Arc bulges out to (40, 10) so the three points are not collinear.
    const added = editor.addThreePointArc({ x: 30, y: 0 }, { x: 30, y: 20 }, { x: 40, y: 10 });
    expect(added).toBe(true);
    const arc = editor.sketch.entities.find((e) => e.kind === 'arc') as
      | { startId: string; endId: string }
      | undefined;
    expect(arc).toBeDefined();
    // The arc reuses the chain tail as its start; no duplicate point.
    expect([arc!.startId, arc!.endId]).toContain(arcStart);
    const arcEndId = arc!.startId === arcStart ? arc!.endId : arc!.startId;
    expect(editor.chainTailId).toBe(arcEndId);
    expect(editor.sketch.entities.filter((e) => e.kind === 'point')).toHaveLength(4);
    editor.appendChainPoint({ x: 0, y: 20 });
    editor.closeChainTo(origin);
    const profile = extractProfile(editor.sketch);
    expect(profile.ok).toBe(true);
  });

  it('adds a tangent constraint between the chain and a tangent arc', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 30, y: 0 });
    const lineId = editor.sketch.entities.find((e) => e.kind === 'line')!.id;
    editor.addThreePointArc({ x: 30, y: 0 }, { x: 30, y: 20 }, { x: 40, y: 10 }, true);
    const tangent = editor.sketch.constraints.find((c) => c.kind === 'tangent') as
      | { aId: string; bId: string }
      | undefined;
    expect(tangent).toBeDefined();
    const arcId = editor.sketch.entities.find((e) => e.kind === 'arc')!.id;
    expect(tangent!.aId).toBe(lineId);
    expect(tangent!.bId).toBe(arcId);
  });

  it('discards a stale solve result when the sketch changed while solving', async () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 10, y: 0 });
    let resolveSolve: (value: unknown) => void = () => {};
    solveMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSolve = resolve;
        }),
    );
    const pending = editor.solveNow();
    // A concurrent edit happens while the worker is still solving.
    editor.appendChainPoint({ x: 10, y: 10 });
    const pointsBeforeResolve = editor.sketch.entities.filter((e) => e.kind === 'point').length;
    resolveSolve({
      status: 'solved',
      sketch: { entities: [], constraints: [] },
      dof: 0,
    });
    await pending;
    // The stale result must not overwrite the newer entity.
    expect(editor.sketch.entities.filter((e) => e.kind === 'point')).toHaveLength(
      pointsBeforeResolve,
    );
    expect(editor.solveState.status).not.toBe('solved');
  });

  it('surfaces a failed solve as a user-worded message instead of an unhandled rejection', async () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 10, y: 0 });
    solveMock.mockRejectedValue(new Error('worker crashed'));
    await editor.solveNow();
    expect(editor.solveState.status).toBe('failed');
    if (editor.solveState.status === 'failed') {
      expect(editor.solveState.message).toMatch(/solver/i);
    }
  });

  it('deletes an entity and its orphaned far endpoint, keeping the shared point', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const p1 = editor.appendChainPoint({ x: 0, y: 0 })!;
    const p2 = editor.appendChainPoint({ x: 10, y: 0 })!;
    const p3 = editor.appendChainPoint({ x: 10, y: 10 })!;
    const line1 = editor.sketch.entities.find(
      (e) => e.kind === 'line' && (e as { p1Id: string }).p1Id === p1,
    )!;
    const line2 = editor.sketch.entities.find(
      (e) => e.kind === 'line' && (e as { p2Id: string }).p2Id === p3,
    )!;
    editor.addConstraint({ kind: 'horizontal', id: editor.nextId(), lineId: line1.id });
    editor.selectedIds = [line1.id];
    editor.deleteEntities([line1.id]);
    const ids = new Set(editor.sketch.entities.map((e) => e.id));
    // The shared point survives (still used by line2); the far endpoint of
    // the deleted line does not.
    expect(ids.has(p2)).toBe(true);
    expect(ids.has(p1)).toBe(false);
    expect(ids.has(line1.id)).toBe(false);
    expect(ids.has(line2.id)).toBe(true);
    expect(editor.sketch.constraints.some((c) => c.kind === 'horizontal')).toBe(false);
    expect(editor.selectedIds).toEqual([]);
    // No dangling references left for other consumers (extractProfile etc).
    const pointIds = new Set(
      editor.sketch.entities.filter((e) => e.kind === 'point').map((e) => e.id),
    );
    for (const entity of editor.sketch.entities) {
      if (entity.kind === 'line') {
        expect(pointIds.has(entity.p1Id)).toBe(true);
        expect(pointIds.has(entity.p2Id)).toBe(true);
      }
    }
  });

  it('joins two chains at a shared corner point, producing one closed loop', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    // A plain point placed independently, the shared corner both chains reuse.
    const corner = editor.appendChainPoint({ x: 0, y: 0 })!;
    editor.endChain();
    // Chain A: corner -> a2 -> a3 (left open at a3).
    const a1 = editor.appendChainPoint({ x: 0, y: 0 }, corner)!;
    editor.appendChainPoint({ x: 10, y: 0 });
    const a3 = editor.appendChainPoint({ x: 10, y: 10 })!;
    editor.endChain();
    expect(a1).toBe(corner);
    // Chain B: corner -> b2, then closes onto chain A's open end (a3),
    // completing one rectangle through the shared corner point.
    const b1 = editor.appendChainPoint({ x: 0, y: 0 }, corner)!;
    editor.appendChainPoint({ x: 0, y: 10 });
    editor.closeChainTo(a3);
    expect(b1).toBe(corner);
    const profile = extractProfile(editor.sketch);
    expect(profile.ok).toBe(true);
  });

  it('merges dragged chain ends with a coincident constraint, without duplicating it', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    // Chain A: two points, left open.
    const a1 = editor.appendChainPoint({ x: 0, y: 0 })!;
    const a2 = editor.appendChainPoint({ x: 10, y: 0 })!;
    editor.endChain();
    // Chain B: two points, left open near chain A's end.
    const b1 = editor.appendChainPoint({ x: 10, y: 0.5 })!;
    editor.appendChainPoint({ x: 10, y: 10 });
    editor.endChain();

    editor.addCoincidentIfAbsent(a2, b1);
    let coincidents = editor.sketch.constraints.filter((c) => c.kind === 'coincident');
    expect(coincidents).toHaveLength(1);
    expect([coincidents[0].p1Id, coincidents[0].p2Id].sort()).toEqual([a2, b1].sort());

    // Same pair again, reversed order: no duplicate.
    editor.addCoincidentIfAbsent(b1, a2);
    coincidents = editor.sketch.constraints.filter((c) => c.kind === 'coincident');
    expect(coincidents).toHaveLength(1);

    // Self-merge is a no-op.
    editor.addCoincidentIfAbsent(a1, a1);
    coincidents = editor.sketch.constraints.filter((c) => c.kind === 'coincident');
    expect(coincidents).toHaveLength(1);
  });

  it('loads an existing sketch for editing a sketched tool', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.addCircle({ x: 0, y: 0 }, 5);
    const saved = JSON.parse(JSON.stringify(editor.sketch));
    editor.startNewSketch();
    expect(editor.sketch.entities).toHaveLength(0);
    editor.loadSketch(saved, 'tool-1');
    expect(editor.sketch.entities).toHaveLength(2);
    expect(editor.editingToolId).toBe('tool-1');
  });

  it('undoes and redoes a circle add, restoring the exact sketch', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.addCircle({ x: 0, y: 0 }, 5);
    const afterAdd = JSON.parse(JSON.stringify(editor.sketch));
    expect(editor.historyStack.length).toBe(1);

    editor.undo();
    expect(editor.sketch.entities).toHaveLength(0);
    expect(editor.sketch.constraints).toHaveLength(0);
    expect(editor.redoStack.length).toBe(1);

    editor.redo();
    expect(editor.sketch).toEqual(afterAdd);
    expect(editor.redoStack.length).toBe(0);
  });

  it('undo after deleteEntities restores both entities and constraints', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const p1 = editor.appendChainPoint({ x: 0, y: 0 })!;
    editor.appendChainPoint({ x: 10, y: 0 });
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    editor.addConstraint({ kind: 'horizontal', id: editor.nextId(), lineId: line.id });
    const beforeDelete = JSON.parse(JSON.stringify(editor.sketch));

    editor.selectedIds = [line.id];
    editor.deleteEntities([line.id]);
    expect(editor.sketch.constraints).toHaveLength(0);

    editor.undo();
    expect(editor.sketch).toEqual(beforeDelete);
    expect(editor.sketch.constraints.some((c) => c.kind === 'horizontal')).toBe(true);
    const ids = new Set(editor.sketch.entities.map((e) => e.id));
    expect(ids.has(p1)).toBe(true);
  });

  it('clears selection on undo when the selected id no longer exists', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.addCircle({ x: 0, y: 0 }, 5);
    const circle = editor.sketch.entities.find((e) => e.kind === 'circle')!;
    editor.selectedIds = [circle.id];
    editor.undo();
    expect(editor.selectedIds).toEqual([]);
  });

  it('pushes exactly one history snapshot for a completed point drag, and none for a solver writeback', async () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    const p2 = editor.appendChainPoint({ x: 10, y: 0 })!;
    const historyBeforeDrag = editor.historyStack.length;

    // A drag: one beginPointDrag at drag start, followed by repeated
    // solveNow writebacks (simulating pointermove) that must not push.
    editor.beginPointDrag();
    expect(editor.historyStack.length).toBe(historyBeforeDrag + 1);
    solveMock.mockImplementation(async (sketch) => ({ status: 'solved', sketch, dof: 3 }));
    await editor.solveNow({ pointId: p2, xMm: 12, yMm: 1 });
    await editor.solveNow({ pointId: p2, xMm: 14, yMm: 2 });
    await editor.solveNow();
    editor.endPointDrag();
    expect(editor.historyStack.length).toBe(historyBeforeDrag + 1);
  });

  it('pushes exactly one history snapshot for a drag that ends in a merge, and undo restores both position and removes the constraint', async () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const a1 = editor.appendChainPoint({ x: 0, y: 0 })!;
    const a2 = editor.appendChainPoint({ x: 10, y: 0 })!;
    editor.endChain();
    const b1 = editor.appendChainPoint({ x: 10, y: 5 })!;
    editor.endChain();
    const historyBeforeDrag = editor.historyStack.length;
    const beforeDrag = JSON.parse(JSON.stringify(editor.sketch));

    // Drag a2 toward b1 and release on it: one drag gesture, one merge.
    editor.beginPointDrag();
    solveMock.mockImplementation(async (sketch) => ({ status: 'solved', sketch, dof: 2 }));
    await editor.solveNow({ pointId: a2, xMm: 10, yMm: 4.5 });
    editor.addCoincidentIfAbsent(a2, b1);
    editor.endPointDrag();

    // One drag-to-merge gesture is one undo step, not two.
    expect(editor.historyStack.length).toBe(historyBeforeDrag + 1);
    expect(editor.sketch.constraints.some((c) => c.kind === 'coincident')).toBe(true);

    editor.undo();
    expect(editor.sketch).toEqual(beforeDrag);
    expect(editor.sketch.constraints.some((c) => c.kind === 'coincident')).toBe(false);
    expect(b1).toBeDefined();
  });

  it('restores the open chain tail on undo, so the chain continues validly from the restored point', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const first = editor.appendChainPoint({ x: 0, y: 0 })!;
    editor.appendChainPoint({ x: 10, y: 0 });
    expect(editor.chainTailId).not.toBeNull();
    const tailBeforeUndo = editor.chainTailId;

    editor.undo();
    // The chain tail moved back with the undone point; it must not still
    // reference the now-deleted point.
    expect(editor.chainTailId).not.toBe(tailBeforeUndo);
    expect(editor.chainTailId).toBe(first);
    const idsAfterUndo = new Set(editor.sketch.entities.map((e) => e.id));
    if (editor.chainTailId !== null) expect(idsAfterUndo.has(editor.chainTailId)).toBe(true);

    // Continuing the chain from the restored tail must not create a dangling reference.
    editor.appendChainPoint({ x: 5, y: 8 });
    for (const entity of editor.sketch.entities) {
      if (entity.kind === 'line') {
        expect(idsAfterUndo.has(entity.p1Id) || entity.p1Id === first).toBe(true);
        expect(editor.sketch.entities.some((e) => e.id === entity.p1Id)).toBe(true);
        expect(editor.sketch.entities.some((e) => e.id === entity.p2Id)).toBe(true);
      }
    }
  });

  it('selecting a constraint clears the entity selection and vice versa', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 10, y: 0 });
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    const constraintId = editor.nextId();
    editor.addConstraint({ kind: 'horizontal', id: constraintId, lineId: line.id });

    editor.selectConstraint(constraintId);
    expect(editor.selectedConstraintId).toBe(constraintId);
    expect(editor.selectedIds).toEqual([]);

    editor.selectedIds = [line.id];
    expect(editor.selectedConstraintId).toBeNull();

    editor.selectConstraint(constraintId);
    editor.selectedIds.push(line.id);
    expect(editor.selectedConstraintId).toBeNull();
  });

  it('deleting the selected constraint removes it and clears the selection', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    // suppressAutoHV: true, so this axis-aligned segment does not also pick
    // up the store's own auto H/V constraint, which would leave a second
    // horizontal constraint behind after this test's manual one is removed.
    editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    const constraintId = editor.nextId();
    editor.addConstraint({ kind: 'horizontal', id: constraintId, lineId: line.id });

    editor.selectConstraint(constraintId);
    editor.removeConstraint(constraintId);
    expect(editor.sketch.constraints).toHaveLength(0);
    expect(editor.selectedConstraintId).toBeNull();
  });

  it('restores recordingDepth on a cancelled drag (no merge), so a later mutation pushes exactly one more snapshot', async () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    const p2 = editor.appendChainPoint({ x: 10, y: 0 })!;
    const historyBeforeDrag = editor.historyStack.length;

    // A drag that a browser pointercancel interrupts: beginPointDrag opens
    // the scope, a writeback happens, then the canvas's cancel handler ends
    // the drag the same way pointerup would (no merge), closing the scope.
    editor.beginPointDrag();
    solveMock.mockImplementation(async (sketch) => ({ status: 'solved', sketch, dof: 3 }));
    await editor.solveNow({ pointId: p2, xMm: 12, yMm: 1 });
    editor.endPointDrag();
    expect(editor.historyStack.length).toBe(historyBeforeDrag + 1);

    // recordingDepth must be back at 0: a following mutation pushes exactly
    // one more snapshot, not zero (still nested) and not more than one.
    editor.addCircle({ x: 20, y: 20 }, 3);
    expect(editor.historyStack.length).toBe(historyBeforeDrag + 2);
  });

  it('caps the history stack at 100 snapshots', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    for (let i = 0; i < 105; i++) {
      editor.addCircle({ x: i, y: 0 }, 1);
    }
    expect(editor.historyStack.length).toBe(100);
  });

  /** Draws a closed square starting at (x, y), side length 10 mm. */
  function drawSquare(editor: ReturnType<typeof useSketchEditor>, x: number, y: number): void {
    const first = editor.appendChainPoint({ x, y })!;
    editor.appendChainPoint({ x: x + 10, y });
    editor.appendChainPoint({ x: x + 10, y: y + 10 });
    editor.appendChainPoint({ x, y: y + 10 });
    editor.closeChainTo(first);
  }

  describe('region extraction', () => {
    it('recomputes regions and auto-picks the single face after a solved square', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      await editor.solveNow();
      expect(editor.solveState.status).toBe('solved');
      expect(editor.regionFaces).toHaveLength(1);
      expect(editor.selectedRegionId).toBe(editor.regionFaces[0].id);
    });

    it('finds two separate faces from two disjoint squares and does not auto-pick', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      editor.endChain();
      drawSquare(editor, 30, 0);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(2);
      expect(editor.selectedRegionId).toBeNull();
    });

    it('clears regions on a conflicting or failed solve', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(1);

      solveMock.mockResolvedValue({ status: 'conflicting', conflictingConstraintIds: ['cX'] });
      await editor.solveNow();
      expect(editor.regionFaces).toEqual([]);
      expect(editor.selectedRegionId).toBeNull();
    });

    it('drops a stale selection once its region disappears and auto-repicks the remaining single face', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      editor.endChain();
      drawSquare(editor, 30, 0);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(2);
      // Select whichever face belongs to the second (30,0) square, identified
      // by an entity id that only that square's lines touch.
      const secondSquareEntityIds = new Set(
        editor.sketch.entities
          .filter((e) => e.kind === 'point' && e.x >= 25)
          .map((e) => e.id),
      );
      const secondFace = editor.regionFaces.find((f) =>
        f.entityIds.some((id) => {
          const entity = editor.sketch.entities.find((e) => e.id === id);
          return (
            entity !== undefined &&
            (entity.kind === 'line'
              ? secondSquareEntityIds.has(entity.p1Id) || secondSquareEntityIds.has(entity.p2Id)
              : false)
          );
        }),
      )!;
      editor.selectRegion(secondFace.id);
      expect(editor.selectedRegionId).toBe(secondFace.id);

      // Delete the second square's lines; deleteEntities cascades to remove
      // their now-orphaned endpoints.
      const secondSquareLineIds = editor.sketch.entities
        .filter(
          (e) =>
            e.kind === 'line' &&
            (secondSquareEntityIds.has(e.p1Id) || secondSquareEntityIds.has(e.p2Id)),
        )
        .map((e) => e.id);
      editor.deleteEntities(secondSquareLineIds);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(1);
      // The stale id is gone, and with exactly one face left it is auto-picked.
      expect(editor.selectedRegionId).toBe(editor.regionFaces[0].id);
      expect(editor.selectedRegionId).not.toBe(secondFace.id);
    });

    it('outlineForFinish surfaces the no-region error, the single-face outline, and the pick-a-region message', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();

      // Zero faces: nothing drawn yet is handled by the empty-sketch guard,
      // which is not extraction failure per se, so open a chain instead (an
      // unclosed line has geometry but no enclosed region).
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 });
      await editor.solveNow();
      const zeroFace = editor.outlineForFinish();
      expect(zeroFace.ok).toBe(false);
      if (!zeroFace.ok) expect(zeroFace.error.length).toBeGreaterThan(0);

      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      await editor.solveNow();
      const singleFace = editor.outlineForFinish();
      expect(singleFace.ok).toBe(true);
      if (singleFace.ok) expect(singleFace.outline.outer.length).toBeGreaterThan(0);

      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      editor.endChain();
      drawSquare(editor, 30, 0);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(2);
      expect(editor.selectedRegionId).toBeNull();
      const multiFace = editor.outlineForFinish();
      expect(multiFace.ok).toBe(false);
      if (!multiFace.ok) expect(multiFace.error).toMatch(/region/i);

      editor.selectRegion(editor.regionFaces[0].id);
      const picked = editor.outlineForFinish();
      expect(picked.ok).toBe(true);
    });

    it('keeps the selection across a recompute that renumbers faces but leaves the selected face geometrically unchanged', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      editor.endChain();
      drawSquare(editor, 30, 0);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(2);
      const secondSquareEntityIds = new Set(
        editor.sketch.entities.filter((e) => e.kind === 'point' && e.x >= 25).map((e) => e.id),
      );
      const secondFace = editor.regionFaces.find((f) =>
        f.entityIds.some((id) => {
          const entity = editor.sketch.entities.find((e) => e.id === id);
          return (
            entity !== undefined &&
            (entity.kind === 'line'
              ? secondSquareEntityIds.has(entity.p1Id) || secondSquareEntityIds.has(entity.p2Id)
              : false)
          );
        }),
      )!;
      editor.selectRegion(secondFace.id);
      expect(editor.selectedRegionId).toBe(secondFace.id);

      // Delete the first square and redraw an identical one: its geometry is
      // unchanged, but face ids are assigned by traversal order, so this can
      // (and here does) shuffle which id belongs to the still-selected face.
      const firstSquareLineIds = editor.sketch.entities
        .filter(
          (e) =>
            e.kind === 'line' &&
            !secondSquareEntityIds.has(e.p1Id) &&
            !secondSquareEntityIds.has(e.p2Id),
        )
        .map((e) => e.id);
      editor.deleteEntities(firstSquareLineIds);
      drawSquare(editor, 0, 0);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(2);

      const survivingSecondFace = editor.regionFaces.find((f) =>
        f.entityIds.some((id) => {
          const entity = editor.sketch.entities.find((e) => e.id === id);
          return (
            entity !== undefined &&
            (entity.kind === 'line'
              ? secondSquareEntityIds.has(entity.p1Id) || secondSquareEntityIds.has(entity.p2Id)
              : false)
          );
        }),
      )!;
      // The selection survives, keyed on the face's geometry, whether or not
      // its id happened to change.
      expect(editor.selectedRegionId).toBe(survivingSecondFace.id);
    });

    it('clears a stale selection when the face at the same id is now a different region', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      drawSquare(editor, 0, 0);
      editor.endChain();
      drawSquare(editor, 30, 0);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(2);
      const [faceA, faceB] = editor.regionFaces;
      editor.selectRegion(faceA.id);
      expect(editor.selectedRegionId).toBe(faceA.id);

      // Delete the selected face's square and grow the other square so a
      // recompute could plausibly reuse faceA's id for a face at a
      // completely different location; the geometry check must reject it.
      const faceASquareEntityIds = new Set(
        editor.sketch.entities.filter((e) => e.kind === 'point' && e.x < 25).map((e) => e.id),
      );
      const faceALineIds = editor.sketch.entities
        .filter(
          (e) =>
            e.kind === 'line' &&
            (faceASquareEntityIds.has(e.p1Id) || faceASquareEntityIds.has(e.p2Id)),
        )
        .map((e) => e.id);
      editor.deleteEntities(faceALineIds);
      editor.endChain();
      drawSquare(editor, 100, 100);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(2);
      expect(editor.selectedRegionId).toBeNull();
      void faceB;
    });

    it('does not recompute regions during a point drag, only once the drag ends', async () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      const first = editor.appendChainPoint({ x: 0, y: 0 })!;
      const p2 = editor.appendChainPoint({ x: 10, y: 0 })!;
      editor.appendChainPoint({ x: 10, y: 10 });
      editor.appendChainPoint({ x: 0, y: 10 });
      editor.closeChainTo(first);
      await editor.solveNow();
      expect(editor.regionFaces).toHaveLength(1);
      const facesBeforeDrag = editor.regionFaces;

      editor.beginPointDrag();
      // Two intermediate drag solves (per-pointermove writebacks): the solved
      // sketch moves p2 to different points each time, which would change the
      // extracted region's outer boundary if regions were recomputed here.
      await editor.solveNow({ pointId: p2, xMm: 12, yMm: 1 });
      expect(editor.regionFaces).toBe(facesBeforeDrag);
      await editor.solveNow({ pointId: p2, xMm: 14, yMm: 2 });
      expect(editor.regionFaces).toBe(facesBeforeDrag);

      editor.endPointDrag();
      await editor.solveNow();
      expect(editor.regionFaces).not.toBe(facesBeforeDrag);
      expect(editor.regionFaces).toHaveLength(1);
    });
  });

  describe('measured-value defaults', () => {
    it('measures a line length from its current solved geometry', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 30, y: 40 }, undefined, true);
      const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
      expect(measureLineLength(editor.sketch, line.id)).toBeCloseTo(50);
    });

    it('measures a circle radius and diameter from its stored radius', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      const circleId = editor.addCircle({ x: 0, y: 0 }, 5);
      expect(measureRadius(editor.sketch, circleId)).toBeCloseTo(5);
      expect(measureDiameter(editor.sketch, circleId)).toBeCloseTo(10);
    });

    it('measures the distance between two points', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      const p1 = editor.addPoint({ x: 0, y: 0 });
      const p2 = editor.addPoint({ x: 3, y: 4 });
      expect(measurePointDistance(editor.sketch, p1, p2)).toBeCloseTo(5);
    });

    it('creates a diameter dimension seeded from the measured diameter, mirroring the radius/diameter toggle', () => {
      // Mimics SketchWorkspace's toggleRadiusDiameter: an arc or circle
      // selection first gets a radius dimension (beginDimensionFromSelection's
      // default); switching the toggle to diameter removes that constraint
      // and adds a diameter one, reseeded from measureDiameter.
      const editor = useSketchEditor();
      editor.startNewSketch();
      const circleId = editor.addCircle({ x: 0, y: 0 }, 6);
      const radiusId = editor.nextId();
      editor.addDimension({
        kind: 'radius', id: radiusId, entityId: circleId, mm: measureRadius(editor.sketch, circleId),
      });

      editor.removeConstraint(radiusId);
      const diameterId = editor.nextId();
      const measuredDiameter = measureDiameter(editor.sketch, circleId);
      editor.addDimension({ kind: 'diameter', id: diameterId, entityId: circleId, mm: measuredDiameter });

      const dims = editor.sketch.constraints;
      expect(dims).toHaveLength(1);
      expect(dims[0].kind).toBe('diameter');
      expect(dims[0].kind === 'diameter' && dims[0].mm).toBeCloseTo(12);
      expect(measuredDiameter).toBeCloseTo(12);
    });

    it('measures the angle between two lines', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const l1 = editor.sketch.entities.find((e) => e.kind === 'line')!;
      editor.endChain();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 0, y: 10 }, undefined, true);
      const l2 = editor.sketch.entities.filter((e) => e.kind === 'line')[1];
      expect(measureAngleBetweenLines(editor.sketch, l1.id, l2.id)).toBeCloseTo(90);
    });
  });

  describe('rectangle tool', () => {
    it('creates four lines sharing corner points, with H/V constraints on the sides', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.addRectangle({ x: 0, y: 0 }, { x: 20, y: 10 });

      const lines = editor.sketch.entities.filter((e) => e.kind === 'line');
      expect(lines).toHaveLength(4);
      const points = editor.sketch.entities.filter((e) => e.kind === 'point');
      expect(points).toHaveLength(4);
      // Coincident corners by construction: every point is referenced by
      // exactly two of the four lines (its two adjacent sides).
      for (const p of points) {
        const refCount = lines.filter((l) => l.kind === 'line' && (l.p1Id === p.id || l.p2Id === p.id)).length;
        expect(refCount).toBe(2);
      }
      const horizontals = editor.sketch.constraints.filter((c) => c.kind === 'horizontal');
      const verticals = editor.sketch.constraints.filter((c) => c.kind === 'vertical');
      expect(horizontals).toHaveLength(2);
      expect(verticals).toHaveLength(2);
    });
  });

  describe('slot tool', () => {
    it('creates two parallel lines and two end arcs with tangent junctions and one diameter dimension', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.addSlot({ x: 0, y: 0 }, { x: 30, y: 0 }, 10);

      const lines = editor.sketch.entities.filter((e) => e.kind === 'line');
      const arcs = editor.sketch.entities.filter((e) => e.kind === 'arc');
      expect(lines).toHaveLength(2);
      expect(arcs).toHaveLength(2);

      const parallels = editor.sketch.constraints.filter((c) => c.kind === 'parallel');
      const tangents = editor.sketch.constraints.filter((c) => c.kind === 'tangent');
      const diameters = editor.sketch.constraints.filter((c) => c.kind === 'diameter');
      expect(parallels).toHaveLength(1);
      expect(tangents).toHaveLength(4);
      expect(diameters).toHaveLength(1);
      expect(diameters[0].kind === 'diameter' && diameters[0].mm).toBe(10);

      // Both end arcs measure radius 5 (half the width) from their geometry.
      for (const arc of arcs) {
        expect(measureRadius(editor.sketch, arc.id)).toBeCloseTo(5);
      }
    });
  });

  describe('auto H/V inference on chain placement', () => {
    it('adds a horizontal constraint for a segment drawn within the snap band', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0.1 });
      const horizontals = editor.sketch.constraints.filter((c) => c.kind === 'horizontal');
      expect(horizontals).toHaveLength(1);
    });

    it('adds a vertical constraint for a segment drawn within the snap band', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 0.1, y: 10 });
      const verticals = editor.sketch.constraints.filter((c) => c.kind === 'vertical');
      expect(verticals).toHaveLength(1);
    });

    it('adds no H/V constraint for a segment well outside the snap band', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 10 });
      const hv = editor.sketch.constraints.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical');
      expect(hv).toHaveLength(0);
    });

    it('suppresses the auto constraint when suppressAutoHV (Alt) is set, even inside the snap band', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const hv = editor.sketch.constraints.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical');
      expect(hv).toHaveLength(0);
    });
  });

  describe('typed-length application', () => {
    it('placing a chain point at a typed length adds a matching length dimension', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      // Mimics the quick-entry commit: a typed length replaces the magnitude
      // of the current direction toward the cursor, then a length dimension
      // pins the new segment at exactly that value.
      const tail = editor.sketch.entities.find((e) => e.kind === 'point')!;
      const typed = 25;
      const cursor = { x: 10, y: 0 };
      const dx = cursor.x - (tail as { x: number }).x;
      const dy = cursor.y - (tail as { y: number }).y;
      const dirLen = Math.hypot(dx, dy) || 1;
      const target = { x: (dx / dirLen) * typed, y: (dy / dirLen) * typed };
      editor.appendChainPoint(target);
      expect(editor.chainTailSegmentId).not.toBeNull();
      editor.addDimension({
        kind: 'length', id: editor.nextId(), lineId: editor.chainTailSegmentId!, mm: typed,
      });
      const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
      expect(measureLineLength(editor.sketch, line.id)).toBeCloseTo(typed);
      const dims = editor.sketch.constraints.filter((c) => c.kind === 'length');
      expect(dims).toHaveLength(1);
      expect(dims[0].kind === 'length' && dims[0].mm).toBe(typed);
    });

    it('runGrouped collapses a segment placement and its length dimension into one undo step', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      const historyBefore = editor.historyStack.length;

      editor.runGrouped(() => {
        editor.appendChainPoint({ x: 25, y: 0 });
        editor.addDimension({
          kind: 'length', id: editor.nextId(), lineId: editor.chainTailSegmentId!, mm: 25,
        });
      });
      expect(editor.historyStack.length).toBe(historyBefore + 1);
      const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
      expect(measureLineLength(editor.sketch, line.id)).toBeCloseTo(25);
      expect(editor.sketch.constraints.filter((c) => c.kind === 'length')).toHaveLength(1);

      // One undo removes both the geometry and its dimension.
      editor.undo();
      expect(editor.sketch.entities.filter((e) => e.kind === 'line')).toHaveLength(0);
      expect(editor.sketch.constraints.filter((c) => c.kind === 'length')).toHaveLength(0);
    });
  });

  describe('auto-return to select on tool completion (task F)', () => {
    it('returns one-shot tools to select after completing their shape', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();

      editor.activeTool = 'circle';
      editor.addCircle({ x: 0, y: 0 }, 5);
      expect(editor.activeTool).toBe('select');

      editor.activeTool = 'rectangle';
      editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
      expect(editor.activeTool).toBe('select');

      editor.activeTool = 'slot';
      editor.addSlot({ x: 0, y: 0 }, { x: 20, y: 0 }, 6);
      expect(editor.activeTool).toBe('select');

      editor.activeTool = 'mirror';
      editor.addMirrorLine({ x: 0, y: 0 }, { x: 10, y: 0 });
      expect(editor.activeTool).toBe('select');
    });

    it('returns the line chain tool to select when closeChainTo closes the chain, but not while it stays open', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.activeTool = 'line';
      const first = editor.appendChainPoint({ x: 0, y: 0 })!;
      editor.appendChainPoint({ x: 10, y: 0 });
      // The chain is still open: the tool stays active.
      expect(editor.activeTool).toBe('line');
      editor.appendChainPoint({ x: 10, y: 10 });
      editor.closeChainTo(first);
      expect(editor.activeTool).toBe('select');
    });

    it('returns the arc chain tool to select when addThreePointArc closes onto an existing point', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.activeTool = 'line';
      const origin = editor.appendChainPoint({ x: 0, y: 0 })!;
      editor.appendChainPoint({ x: 30, y: 0 });
      editor.appendChainPoint({ x: 30, y: 20 });
      editor.activeTool = 'arcThreePoint';
      // Closes the arc onto the chain's own origin point.
      const added = editor.addThreePointArc(
        { x: 30, y: 20 },
        { x: 0, y: 0 },
        { x: 15, y: 30 },
        false,
        origin,
      );
      expect(added).toBe(true);
      expect(editor.activeTool).toBe('select');
    });
  });

  describe('dimension tool: two selected lines (task G)', () => {
    it('measures an angle dimension the same way beginDimensionFromSelection does for two lines', () => {
      // Mimics SketchWorkspace's beginDimensionFromSelection: two selected
      // lines produce an angle dimension in degrees, seeded from
      // measureAngleBetweenLines, the same measured-default pattern the
      // radius/diameter toggle test above uses.
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const l1 = editor.sketch.entities.find((e) => e.kind === 'line')!;
      editor.endChain();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 0, y: 10 }, undefined, true);
      const l2 = editor.sketch.entities.filter((e) => e.kind === 'line')[1];

      const measured = measureAngleBetweenLines(editor.sketch, l1.id, l2.id);
      const id = editor.nextId();
      editor.addDimension({ kind: 'angle', id, l1Id: l1.id, l2Id: l2.id, degrees: measured });

      const dims = editor.sketch.constraints.filter((c) => c.kind === 'angle');
      expect(dims).toHaveLength(1);
      expect(dims[0].kind === 'angle' && dims[0].degrees).toBeCloseTo(90);
      expect(measured).toBeCloseTo(90);
    });
  });

  describe('dimension tool rebuild: place-then-commit, edit, escape, label drag', () => {
    it('resolves a single line to a pending length, places it at a click, and commits with a labelOffset', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const line = editor.sketch.entities.find((e) => e.kind === 'line')!;

      editor.selectedIds = [line.id];
      const hint = editor.resolveDimensionAtSelection();
      expect(hint).toContain('length');
      expect(editor.dimensionPending).toEqual({ kind: 'length', lineId: line.id });
      expect(editor.selectedIds).toEqual([]);

      // Placement click above the line's midpoint (5, 0): the labelOffset is
      // the click position minus the length dimension's anchor (the line's
      // midpoint), per LabelOffset's documented convention.
      editor.placeDimensionDraft({ x: 5, y: -8 });
      expect(editor.dimensionPending).toBeNull();
      expect(editor.dimensionDraft).not.toBeNull();
      expect(editor.dimensionDraft!.constraintId).toBeNull();
      expect(editor.dimensionDraft!.text).toBe('10');
      expect(editor.dimensionDraft!.labelOffset).toEqual({ x: 0, y: -8 });

      // Commit with an edited value: the constraint is added only now, with
      // the typed value and the placed labelOffset.
      editor.dimensionDraft!.text = '25';
      expect(editor.commitDimensionDraft()).toBe(true);
      expect(editor.dimensionDraft).toBeNull();
      const dims = editor.sketch.constraints.filter((c) => c.kind === 'length');
      expect(dims).toHaveLength(1);
      expect(dims[0].kind === 'length' && dims[0].mm).toBe(25);
      expect(dims[0].kind === 'length' && dims[0].labelOffset).toEqual({ x: 0, y: -8 });
    });

    it('double-click (openDimensionDraftForEdit) reopens an existing dimension and commit updates its value only', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
      const id = editor.nextId();
      editor.addDimension({ kind: 'length', id, lineId: line.id, mm: 10, labelOffset: { x: 1, y: 2 } });

      editor.openDimensionDraftForEdit(id);
      expect(editor.dimensionDraft).toMatchObject({ constraintId: id, pending: null, text: '10' });
      editor.dimensionDraft!.text = '42';
      expect(editor.commitDimensionDraft()).toBe(true);

      const dim = editor.sketch.constraints.find((c) => c.id === id)!;
      expect(dim.kind === 'length' && dim.mm).toBe(42);
      // The label position is untouched by an edit that only changes value.
      expect(dim.kind === 'length' && dim.labelOffset).toEqual({ x: 1, y: 2 });
    });

    it('cancelDimensionDraft after a placement leaves no constraint behind (Escape before commit)', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const line = editor.sketch.entities.find((e) => e.kind === 'line')!;

      editor.selectedIds = [line.id];
      editor.resolveDimensionAtSelection();
      editor.placeDimensionDraft({ x: 5, y: -8 });
      expect(editor.dimensionDraft).not.toBeNull();

      editor.cancelDimensionDraft();
      expect(editor.dimensionDraft).toBeNull();
      expect(editor.sketch.constraints.filter((c) => c.kind === 'length')).toHaveLength(0);
    });

    it('two parallel lines surface a hint and never resolve to a dimension', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const l1 = editor.sketch.entities.find((e) => e.kind === 'line')!;
      editor.endChain();
      editor.appendChainPoint({ x: 0, y: 5 });
      editor.appendChainPoint({ x: 10, y: 5 }, undefined, true);
      const l2 = editor.sketch.entities.filter((e) => e.kind === 'line')[1];

      editor.selectedIds = [l1.id, l2.id];
      const hint = editor.resolveDimensionAtSelection();
      expect(hint).toBe('Select a point and a line for a distance.');
      expect(editor.dimensionPending).toBeNull();
      expect(editor.selectedIds).toEqual([]);
    });

    it('updateLabelOffset between beginLabelDrag/endLabelDrag collapses a whole drag into one undo step', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.appendChainPoint({ x: 0, y: 0 });
      editor.appendChainPoint({ x: 10, y: 0 }, undefined, true);
      const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
      const id = editor.nextId();
      editor.addDimension({ kind: 'length', id, lineId: line.id, mm: 10, labelOffset: { x: 0, y: -8 } });
      const historyBeforeDrag = editor.historyStack.length;

      editor.beginLabelDrag();
      editor.updateLabelOffset(id, { x: 2, y: -8 });
      editor.updateLabelOffset(id, { x: 4, y: -6 });
      editor.updateLabelOffset(id, { x: 6, y: -4 });
      editor.endLabelDrag();

      expect(editor.historyStack.length).toBe(historyBeforeDrag + 1);
      const dim = editor.sketch.constraints.find((c) => c.id === id)!;
      expect(dim.kind === 'length' && dim.labelOffset).toEqual({ x: 6, y: -4 });

      editor.undo();
      const reverted = editor.sketch.constraints.find((c) => c.id === id)!;
      expect(reverted.kind === 'length' && reverted.labelOffset).toEqual({ x: 0, y: -8 });
    });
  });

  describe('startNewSketch resets all display state', () => {
    it('clears pending clicks, cursor, hovered constraint and restores glyph visibility', () => {
      const editor = useSketchEditor();
      editor.startNewSketch();
      editor.pendingClicks.push({ x: 1, y: 2 });
      editor.pendingHitPointIds.push('p1');
      editor.cursorMm = { x: 3, y: 4 };
      editor.hoveredConstraintId = 'c1';
      editor.glyphsVisible = false;

      editor.startNewSketch();
      expect(editor.pendingClicks).toEqual([]);
      expect(editor.pendingHitPointIds).toEqual([]);
      expect(editor.cursorMm).toBeNull();
      expect(editor.hoveredConstraintId).toBeNull();
      expect(editor.glyphsVisible).toBe(true);
    });
  });
});
