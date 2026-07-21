import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createCavityEditSession } from '../../src/stores/cavityEditSession';
import { useCutout } from '../../src/stores/cutout';
import { useToolTrace } from '../../src/stores/toolTrace';
import type { CavityEdit } from '../../src/engine/plan/types';

const stroke = (x: number): CavityEdit => ({
  kind: 'remove',
  points: [{ xMm: x, yMm: 0, zMm: 5 }],
  radiusMm: 3,
});

// One of the exact messages finishCavityEdits throws, so it is recognised as an
// edit rejection (the only failure that rolls edits back).
const REJECTION_MESSAGE =
  'The cavity edits removed the entire bin, so the last edit was not applied.';

describe('createCavityEditSession', () => {
  it('appendEdit clears the redo stack', () => {
    const s = createCavityEditSession();
    s.appendEdit(stroke(1));
    s.undoEdit();
    expect(s.redoStack.value).toHaveLength(1);
    s.appendEdit(stroke(2));
    expect(s.redoStack.value).toHaveLength(0);
    expect(s.edits.value).toHaveLength(1);
  });

  it('undo and redo walk the list one step at a time', () => {
    const s = createCavityEditSession();
    s.appendEdit(stroke(1));
    s.appendEdit(stroke(2));
    s.undoEdit();
    expect(s.edits.value).toHaveLength(1);
    s.redoEdit();
    expect(s.edits.value).toHaveLength(2);
    expect(s.edits.value[1]).toEqual(stroke(2));
  });

  it('undo on empty and redo on empty do nothing', () => {
    const s = createCavityEditSession();
    s.undoEdit();
    s.redoEdit();
    expect(s.edits.value).toHaveLength(0);
    expect(s.redoStack.value).toHaveLength(0);
  });

  it('popLastEditForRejection drops the last edit without making it redoable', () => {
    const s = createCavityEditSession();
    s.appendEdit(stroke(1));
    s.popLastEditForRejection();
    expect(s.edits.value).toHaveLength(0);
    expect(s.redoStack.value).toHaveLength(0);
  });

  it('setBrushRadius clamps to the shared bounds', () => {
    const s = createCavityEditSession();
    s.setBrushRadius(0.05);
    expect(s.brushRadiusMm.value).toBe(0.2);
    s.setBrushRadius(500);
    expect(s.brushRadiusMm.value).toBe(50);
  });

  it('setFlattenHeight clamps to the shared bounds', () => {
    const s = createCavityEditSession();
    s.setFlattenHeight(0.05);
    expect(s.flattenHeightMm.value).toBe(0.2);
    s.setFlattenHeight(1000);
    expect(s.flattenHeightMm.value).toBe(100);
  });

  it('appendEdit deep-copies, so mutating the source edit leaves the session alone', () => {
    const s = createCavityEditSession();
    const source = stroke(1);
    s.appendEdit(source);
    source.points[0].xMm = 999;
    source.radiusMm = 999;
    expect(s.edits.value[0]).toEqual(stroke(1));
  });

  it('setEdits deep-copies and marks the loaded edits known good', () => {
    const s = createCavityEditSession();
    const source = [stroke(1), stroke(2)];
    s.setEdits(source);
    expect(s.edits.value).toHaveLength(2);
    expect(s.lastGoodEditCount.value).toBe(2);
    // Independent clones: mutating the source does not reach into the session.
    source[0].points[0].xMm = 999;
    expect(s.edits.value[0]).toEqual(stroke(1));
    // And the redo stack is cleared on load.
    expect(s.redoStack.value).toHaveLength(0);
  });

  it('clearEdits empties both stacks and forgets the known-good count', () => {
    const s = createCavityEditSession();
    s.setEdits([stroke(1), stroke(2)]);
    s.appendEdit(stroke(3));
    s.undoEdit();
    s.clearEdits();
    expect(s.edits.value).toHaveLength(0);
    expect(s.redoStack.value).toHaveLength(0);
    expect(s.lastGoodEditCount.value).toBe(0);
  });

  it('noteLandedCarve clamps the known-good count to the live edit list', () => {
    const s = createCavityEditSession();
    s.appendEdit(stroke(1));
    // A carve of 3 edits reports back after two of them were undone: the live
    // list is the ceiling, so the count cannot exceed it.
    s.noteLandedCarve(3);
    expect(s.lastGoodEditCount.value).toBe(1);
  });

  it('rollbackRejectedEdits unwinds every edit above the last known-good count', () => {
    const s = createCavityEditSession();
    s.appendEdit(stroke(1));
    s.noteLandedCarve(1);
    s.appendEdit(stroke(2));
    s.appendEdit(stroke(3));
    // Two edits were painted after the last good carve; a rejection drops both.
    const returned = s.rollbackRejectedEdits(REJECTION_MESSAGE);
    expect(returned).toBe(REJECTION_MESSAGE);
    expect(s.edits.value).toHaveLength(1);
    expect(s.edits.value[0]).toEqual(stroke(1));
  });

  it('rollbackRejectedEdits leaves edits alone for a non-rejection failure', () => {
    const s = createCavityEditSession();
    s.appendEdit(stroke(1));
    s.appendEdit(stroke(2));
    const returned = s.rollbackRejectedEdits('A pocket refers to a tool that is no longer in the plan.');
    expect(returned).toBeNull();
    expect(s.edits.value).toHaveLength(2);
  });

  it('rollbackRejectedEdits does nothing when the message is null', () => {
    const s = createCavityEditSession();
    s.appendEdit(stroke(1));
    expect(s.rollbackRejectedEdits(null)).toBeNull();
    expect(s.edits.value).toHaveLength(1);
  });

  it('resetEditSession returns everything to defaults', () => {
    const s = createCavityEditSession();
    s.setEdits([stroke(1)]);
    s.appendEdit(stroke(2));
    s.setActiveTool('add');
    s.setBrushRadius(7);
    s.setFlattenHeight(9);
    s.resetEditSession();
    expect(s.edits.value).toHaveLength(0);
    expect(s.redoStack.value).toHaveLength(0);
    expect(s.activeTool.value).toBeNull();
    expect(s.brushRadiusMm.value).toBe(3);
    expect(s.flattenHeightMm.value).toBe(5);
    expect(s.lastGoodEditCount.value).toBe(0);
  });
});

// The session is embedded in both carved-interior stores; its behaviour must
// hold identically whichever store exposes it, and each store's instance must
// be independent of the other's.
describe.each([
  ['cutout', useCutout],
  ['toolTrace', useToolTrace],
] as const)('cavity edit session embedded in the %s store', (_name, useStore) => {
  beforeEach(() => setActivePinia(createPinia()));

  it('appends, undoes, redoes and pops through the store surface', () => {
    const store = useStore();
    store.appendEdit(stroke(1));
    store.appendEdit(stroke(2));
    store.undoEdit();
    expect(store.edits).toHaveLength(1);
    expect(store.redoStack).toHaveLength(1);
    store.redoEdit();
    expect(store.edits).toHaveLength(2);
    store.popLastEditForRejection();
    expect(store.edits).toHaveLength(1);
    expect(store.redoStack).toHaveLength(0);
  });

  it('clamps the brush radius and marks landed carves known good', () => {
    const store = useStore();
    store.setBrushRadius(0.05);
    expect(store.brushRadiusMm).toBe(0.2);
    store.setEdits([stroke(1), stroke(2)]);
    expect(store.lastGoodEditCount).toBe(2);
    store.appendEdit(stroke(3));
    const rolled = store.rollbackRejectedEdits(REJECTION_MESSAGE);
    expect(rolled).toBe(REJECTION_MESSAGE);
    expect(store.edits).toHaveLength(2);
  });
});

describe('the two store instances are independent', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps separate edit lists and brush settings', () => {
    const cutout = useCutout();
    const trace = useToolTrace();
    cutout.appendEdit(stroke(1));
    cutout.setBrushRadius(10);
    trace.setBrushRadius(20);
    expect(cutout.edits).toHaveLength(1);
    expect(trace.edits).toHaveLength(0);
    expect(cutout.brushRadiusMm).toBe(10);
    expect(trace.brushRadiusMm).toBe(20);
  });
});
