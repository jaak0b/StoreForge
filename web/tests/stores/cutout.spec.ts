import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCutout } from '../../src/stores/cutout';
import type { CavityEdit } from '../../src/engine/plan/types';

const stroke = (x: number): CavityEdit => ({
  kind: 'remove',
  points: [{ xMm: x, yMm: 0, zMm: 5 }],
  radiusMm: 3,
});

describe('cavity edit state', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('appendEdit clears the redo stack', () => {
    const store = useCutout();
    store.appendEdit(stroke(1));
    store.undoEdit();
    expect(store.redoStack).toHaveLength(1);
    store.appendEdit(stroke(2));
    expect(store.redoStack).toHaveLength(0);
    expect(store.edits).toHaveLength(1);
  });

  it('undo and redo walk the list one step at a time', () => {
    const store = useCutout();
    store.appendEdit(stroke(1));
    store.appendEdit(stroke(2));
    store.undoEdit();
    expect(store.edits).toHaveLength(1);
    store.redoEdit();
    expect(store.edits).toHaveLength(2);
    expect(store.edits[1]).toEqual(stroke(2));
  });

  it('undo on empty and redo on empty do nothing', () => {
    const store = useCutout();
    store.undoEdit();
    store.redoEdit();
    expect(store.edits).toHaveLength(0);
    expect(store.redoStack).toHaveLength(0);
  });

  it('rollbackEdit drops the last edit without making it redoable', () => {
    const store = useCutout();
    store.appendEdit(stroke(1));
    store.rollbackEdit();
    expect(store.edits).toHaveLength(0);
    expect(store.redoStack).toHaveLength(0);
  });

  it('clearEdits empties both the list and the redo stack', () => {
    const store = useCutout();
    store.appendEdit(stroke(1));
    store.undoEdit();
    store.appendEdit(stroke(2));
    store.clearEdits();
    expect(store.edits).toHaveLength(0);
    expect(store.redoStack).toHaveLength(0);
  });

  it('setBrushRadius clamps to the shared bounds', () => {
    const store = useCutout();
    store.setBrushRadius(0.05);
    expect(store.brushRadiusMm).toBe(0.2);
    store.setBrushRadius(500);
    expect(store.brushRadiusMm).toBe(50);
  });

  it('reset clears edits, redo, tool and radius', () => {
    const store = useCutout();
    store.appendEdit(stroke(1));
    store.setActiveTool('add');
    store.setBrushRadius(7);
    store.reset();
    expect(store.edits).toHaveLength(0);
    expect(store.redoStack).toHaveLength(0);
    expect(store.activeTool).toBeNull();
    expect(store.brushRadiusMm).toBe(3);
  });
});
