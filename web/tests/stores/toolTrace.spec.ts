import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useToolTrace } from '../../src/stores/toolTrace';
import { SKETCH_SCHEMA_VERSION } from '../../src/engine/sketch/model';

describe('toolTrace store shadow option', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('leaves the shadow post-filter off for a fresh session', () => {
    // The trace canvas passes this ref straight to the worker, which runs the
    // shadow and paper-halo filter only when it is true. A default of true
    // would delete a bare metal tool from the mask before it is ever traced.
    const store = useToolTrace();
    expect(store.removeShadows).toBe(false);
  });

  it('returns the shadow post-filter to off on reset', () => {
    const store = useToolTrace();
    store.removeShadows = true;
    store.reset();
    expect(store.removeShadows).toBe(false);
  });

  it('adds a sketched tool carrying its editable sketch', () => {
    const trace = useToolTrace();
    const sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point' as const, id: 'pc', x: 0, y: 0, construction: false },
        { kind: 'circle' as const, id: 'c1', centerId: 'pc', radiusMm: 12, construction: false },
      ],
      constraints: [],
    };
    const outline = {
      outer: [
        { x: -12, y: -12 },
        { x: 12, y: -12 },
        { x: 12, y: 12 },
        { x: -12, y: 12 },
      ],
      holes: [],
    };
    const tool = trace.addTool(outline, 'Sketched shape', { kind: 'sketch', sketch });
    expect(tool.source.kind).toBe('sketch');
    if (tool.source.kind === 'sketch') {
      expect(tool.source.sketch).toEqual(sketch);
    }
    expect(trace.placements.some((p) => p.toolId === tool.id)).toBe(true);
  });

  it('adds a primitive tool with no re-edit data', () => {
    const trace = useToolTrace();
    const outline = {
      outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      holes: [],
    };
    const tool = trace.addTool(outline, 'Circle', { kind: 'primitive' });
    expect(tool.source).toEqual({ kind: 'primitive' });
    expect('clicks' in tool).toBe(false);
  });

  it('stores a photo tool\'s clicks and strokes inside its source', () => {
    const trace = useToolTrace();
    const outline = {
      outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      holes: [],
    };
    const clicks = [{ x: 5, y: 5, label: 1 as const }];
    const tool = trace.addTool(outline, undefined, {
      kind: 'photo',
      sessionId: 's1',
      clicks,
      brushStrokes: [],
    });
    expect(tool.source.kind).toBe('photo');
    if (tool.source.kind === 'photo') {
      expect(tool.source.sessionId).toBe('s1');
      expect(tool.source.clicks).toEqual(clicks);
    }
  });
});
