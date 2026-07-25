import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const rectifyCalls: unknown[] = [];
vi.mock('../../src/visionClient', () => {
  const mocked = {
    loadPhoto: vi.fn(async () => ({ width: 400, height: 300 })),
    rectifyPaper: vi.fn(async (corners: unknown, kind: unknown) => {
      rectifyCalls.push([corners, kind]);
      return {
        calibration: {
          corners,
          kind,
          mmPerPixel: 0.5,
          rectifiedWidthPx: 420,
          rectifiedHeightPx: 594,
        },
        preview: null,
      };
    }),
    embedImage: vi.fn(async () => ({ encodeMs: 1 })),
  };
  return mocked as unknown as typeof import('../../src/visionClient');
});

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

const paper = {
  kind: 'a4' as const,
  corners: {
    tl: { x: 0, y: 0 },
    tr: { x: 100, y: 0 },
    br: { x: 100, y: 140 },
    bl: { x: 0, y: 140 },
  },
};

describe('toolTrace active session', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    URL.createObjectURL ??= () => 'blob:test';
    URL.revokeObjectURL ??= () => {};
  });

  it('keys embedReady by session so a stale embed never reads as ready', async () => {
    const trace = useToolTrace();
    trace.sessions = [
      { id: 's1', traceSourceId: 'p1', paper },
      { id: 's2', traceSourceId: 'p2', paper },
    ];
    await trace.activateSession('s1', new Blob(['a']));
    expect(trace.activeSessionId).toBe('s1');
    expect(trace.embedReady).toBe(true);
    // Activating the next session invalidates the old embed the instant the
    // switch starts; wrong millimeters otherwise.
    const activation = trace.activateSession('s2', new Blob(['b']));
    expect(trace.embedReady).toBe(false);
    await activation;
    expect(trace.embedReady).toBe(true);
    expect(trace.activeSessionId).toBe('s2');
  });

  it('applies the activated session saved corners without re-detection', async () => {
    const trace = useToolTrace();
    trace.sessions = [{ id: 's1', traceSourceId: 'p1', paper }];
    rectifyCalls.length = 0;
    await trace.activateSession('s1', new Blob(['a']));
    expect(rectifyCalls).toHaveLength(1);
    expect(rectifyCalls[0]).toEqual([paper.corners, 'a4']);
    expect(trace.calibration?.kind).toBe('a4');
  });

  it('clears the prior session calibration before loading the next', async () => {
    const trace = useToolTrace();
    trace.sessions = [
      { id: 's1', traceSourceId: 'p1', paper },
      { id: 's2', traceSourceId: 'p2', paper },
    ];
    await trace.activateSession('s1', new Blob(['a']));
    const first = trace.calibration;
    await trace.activateSession('s2', new Blob(['b']));
    expect(trace.calibration).not.toBe(first);
    expect(trace.corners).toEqual(paper.corners);
  });

  it('rejects activating a session the store does not hold', async () => {
    const trace = useToolTrace();
    await expect(trace.activateSession('nope', new Blob(['a']))).rejects.toThrow();
  });

  it('registers a fresh photo upload as a new pending session', () => {
    const trace = useToolTrace();
    const id = trace.startPhotoSession(new Blob(['a']), 'blob:x', { width: 4, height: 3 });
    expect(trace.activeSessionId).toBe(id);
    expect(trace.sessionBlobs.get(id)).toBeInstanceOf(Blob);
    expect(trace.embedReady).toBe(false);
  });

  it('clears sessions and the active key on reset', async () => {
    const trace = useToolTrace();
    trace.sessions = [{ id: 's1', traceSourceId: 'p1', paper }];
    await trace.activateSession('s1', new Blob(['a']));
    trace.reset();
    expect(trace.sessions).toEqual([]);
    expect(trace.activeSessionId).toBeNull();
    expect(trace.embedReady).toBe(false);
    expect(trace.sessionBlobs.size).toBe(0);
  });
});
