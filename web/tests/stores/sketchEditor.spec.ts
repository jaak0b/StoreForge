import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const solveMock = vi.fn();
vi.mock('../../src/sketchClient', () => ({
  solveSketchInWorker: (...args: unknown[]) => solveMock(...args),
}));

import { useSketchEditor } from '../../src/stores/sketchEditor';
import { extractProfile } from '../../src/engine/sketch/profile';

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
    expect(editor.historyStack.length).toBe(historyBeforeDrag + 1);
  });

  it('caps the history stack at 100 snapshots', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    for (let i = 0; i < 105; i++) {
      editor.addCircle({ x: i, y: 0 }, 1);
    }
    expect(editor.historyStack.length).toBe(100);
  });
});
