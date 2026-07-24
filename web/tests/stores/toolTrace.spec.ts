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
    const tool = trace.addTool(outline, 'Sketched shape', [], false, [], {
      kind: 'sketch',
      sketch,
    });
    expect(tool.source.kind).toBe('sketch');
    if (tool.source.kind === 'sketch') {
      expect(tool.source.sketch).toEqual(sketch);
    }
    expect(trace.placements.some((p) => p.toolId === tool.id)).toBe(true);
  });
});
