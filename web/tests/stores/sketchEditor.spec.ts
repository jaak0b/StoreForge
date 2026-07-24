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
});
