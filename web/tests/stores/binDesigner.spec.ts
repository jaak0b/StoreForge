import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useBinDesigner } from '../../src/stores/binDesigner';
import { evenDividerWalls } from '../../src/engine/gridfinity/dividerModel';

describe('binDesigner divider mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('starts in None mode with no walls', () => {
    const store = useBinDesigner();
    expect(store.dividerMode).toBe('none');
    expect(store.walls).toEqual([]);
  });

  it('generates the grid walls from the counts when switching to Grid', () => {
    const store = useBinDesigner();
    store.gridX = 3;
    store.gridY = 2;
    store.dividerCountX = 2;
    store.dividerCountY = 1;
    store.setDividerMode('grid');
    expect(store.walls).toEqual(evenDividerWalls(3, 2, 2, 1));
  });

  it('applies a count change immediately while in Grid mode', () => {
    const store = useBinDesigner();
    store.gridX = 4;
    store.gridY = 1;
    store.setDividerMode('grid');
    store.setDividerCount('x', 3);
    expect(store.walls).toEqual(evenDividerWalls(4, 1, 3, 0));
  });

  it('clamps a count to a non-negative integer', () => {
    const store = useBinDesigner();
    store.setDividerCount('x', -2.7);
    expect(store.dividerCountX).toBe(0);
    store.setDividerCount('y', 2.9);
    expect(store.dividerCountY).toBe(2);
  });

  it('does not regenerate walls when a count changes outside Grid mode', () => {
    const store = useBinDesigner();
    store.setDividerCount('x', 3);
    expect(store.walls).toEqual([]);
  });

  it('regenerates the grid walls when the footprint changes in Grid mode', () => {
    const store = useBinDesigner();
    store.gridX = 2;
    store.gridY = 1;
    store.dividerCountX = 1;
    store.setDividerMode('grid');
    expect(store.walls).toEqual(evenDividerWalls(2, 1, 1, 0));
    store.setGridX(5);
    expect(store.walls).toEqual(evenDividerWalls(5, 1, 1, 0));
    store.setGridY(3);
    expect(store.walls).toEqual(evenDividerWalls(5, 3, 1, 0));
  });

  it('leaves a mid-edit footprint alone until it parses, in Grid mode', () => {
    const store = useBinDesigner();
    store.gridX = 3;
    store.gridY = 1;
    store.dividerCountX = 2;
    store.setDividerMode('grid');
    const before = store.walls.map((wall) => ({ ...wall }));
    store.setGridX(Number.NaN);
    expect(store.walls).toEqual(before);
  });

  it('does not touch the walls when the footprint changes in Custom mode', () => {
    const store = useBinDesigner();
    store.walls = evenDividerWalls(2, 1, 1, 0);
    store.inferDividerModeFromWalls();
    expect(store.dividerMode).toBe('custom');
    const custom = store.walls.map((wall) => ({ ...wall }));
    store.setGridX(6);
    store.setGridY(4);
    expect(store.walls).toEqual(custom);
  });

  it('keeps the current walls when switching from Grid to Custom', () => {
    const store = useBinDesigner();
    store.gridX = 3;
    store.gridY = 1;
    store.dividerCountX = 2;
    store.setDividerMode('grid');
    const gridWalls = store.walls.map((wall) => ({ ...wall }));
    store.setDividerMode('custom');
    expect(store.walls).toEqual(gridWalls);
  });

  it('empties the walls when switching to None', () => {
    const store = useBinDesigner();
    store.gridX = 3;
    store.dividerCountX = 2;
    store.setDividerMode('grid');
    expect(store.walls.length).toBeGreaterThan(0);
    store.setDividerMode('none');
    expect(store.walls).toEqual([]);
    expect(store.selectedWallIndex).toBeNull();
  });

  it('infers Custom from loaded walls and None from an empty list', () => {
    const store = useBinDesigner();
    store.walls = evenDividerWalls(3, 1, 2, 0);
    store.inferDividerModeFromWalls();
    expect(store.dividerMode).toBe('custom');

    store.walls = [];
    store.inferDividerModeFromWalls();
    expect(store.dividerMode).toBe('none');
  });
});
