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

describe('toolTrace removeSession cascade', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    URL.createObjectURL ??= () => 'blob:test';
    URL.revokeObjectURL ??= () => {};
  });

  const photoOutline = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    holes: [],
  };

  it('removes the session and every tool sourced from it, plus their placements', () => {
    const trace = useToolTrace();
    trace.sessions = [
      { id: 's1', traceSourceId: 'p1', paper },
      { id: 's2', traceSourceId: 'p2', paper },
    ];
    const fromS1 = trace.addTool(photoOutline, 'From sheet 1', {
      kind: 'photo',
      sessionId: 's1',
      clicks: [],
    });
    const fromS2 = trace.addTool(photoOutline, 'From sheet 2', {
      kind: 'photo',
      sessionId: 's2',
      clicks: [],
    });
    const sketched = trace.addTool(photoOutline, 'Sketched shape', {
      kind: 'sketch',
      sketch: { schemaVersion: SKETCH_SCHEMA_VERSION, entities: [], constraints: [] },
    });

    trace.removeSession('s1');

    expect(trace.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(trace.tools.map((t) => t.id)).toEqual([fromS2.id, sketched.id]);
    expect(trace.placements.some((p) => p.toolId === fromS1.id)).toBe(false);
    expect(trace.placements.some((p) => p.toolId === fromS2.id)).toBe(true);
    expect(trace.placements.some((p) => p.toolId === sketched.id)).toBe(true);
  });

  it('clears the active photo working state when the removed session is active', async () => {
    const trace = useToolTrace();
    trace.sessions = [{ id: 's1', traceSourceId: 'p1', paper }];
    await trace.activateSession('s1', new Blob(['a']));
    trace.removeSession('s1');
    expect(trace.activeSessionId).toBeNull();
    expect(trace.embedReady).toBe(false);
    expect(trace.sessionBlobs.size).toBe(0);
  });
});

describe('toolTrace start-over reset', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('leaves the store pristine: no sources, tools, placements or selection', () => {
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
    trace.sessions = [{ id: 's1', traceSourceId: 'p1', paper }];
    trace.addTool(outline, 'Circle', { kind: 'primitive' });
    trace.gridManual = true;
    trace.gridX = 4;

    trace.reset();

    expect(trace.sessions).toEqual([]);
    expect(trace.tools).toEqual([]);
    expect(trace.placements).toEqual([]);
    expect(trace.selectedToolId).toBeNull();
    expect(trace.activeSessionId).toBeNull();
    expect(trace.gridManual).toBe(false);
    expect(trace.gridX).toBe(1);
  });
});

describe('toolTrace multi-part sketch tools', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function square(x0: number, y0: number, size: number) {
    return {
      outer: [
        { x: x0, y: y0 },
        { x: x0 + size, y: y0 },
        { x: x0 + size, y: y0 + size },
        { x: x0, y: y0 + size },
      ],
      holes: [[
        { x: x0 + size * 0.4, y: y0 + size * 0.6 },
        { x: x0 + size * 0.4, y: y0 + size * 0.4 },
        { x: x0 + size * 0.6, y: y0 + size * 0.4 },
        { x: x0 + size * 0.6, y: y0 + size * 0.6 },
      ]],
    };
  }

  it('addToolParts stores every selected region as its own part', () => {
    const trace = useToolTrace();
    const sketch = { schemaVersion: SKETCH_SCHEMA_VERSION, entities: [], constraints: [] };
    const tool = trace.addToolParts(
      [square(0, 0, 20), square(30, 0, 20)],
      'Sketched shape',
      { kind: 'sketch', sketch },
    );
    expect(tool.parts).toHaveLength(2);
    expect(trace.placements.some((p) => p.toolId === tool.id)).toBe(true);
  });

  it('re-finish rematches parts by geometry: filled holes carry over, unmatched ones drop, and the placement holds the world position', async () => {
    const { matchPartsByGeometry, placementPreservingCentroid, sortPartsByCentroid } =
      await import('../../src/engine/trace/edit');
    const { recentredParts } = await import('../../src/engine/trace/layoutModel');

    const trace = useToolTrace();
    const sketch = { schemaVersion: SKETCH_SCHEMA_VERSION, entities: [], constraints: [] };
    // A big square (dominates the combined bounding box) plus a small square
    // tucked fully inside its extent, so recentering leaves the big square's
    // own recentred position essentially unchanged whether the small square
    // is present, absent, or swapped for a different one in the same corner
    // of the bounding box. The small squares themselves recentre far enough
    // apart (more than matchPartsByGeometry's 20 mm tolerance) not to be
    // confused with one another.
    const big = square(0, 0, 100);
    const smallOld = square(40, 40, 5);
    const smallNew = square(60, 60, 5);
    const tool = trace.addToolParts([smallOld, big], 'Sketched shape', { kind: 'sketch', sketch });
    // sortPartsByCentroid orders by centroid y then x: smallOld's centroid
    // (42.5, 42.5) sorts before big's (50, 50).
    expect(tool.parts).toHaveLength(2);
    trace.toggleFilledHole(tool.id, 0, 0); // smallOld's hole
    trace.toggleFilledHole(tool.id, 1, 0); // big's hole
    expect(tool.filledHoles).toHaveLength(2);
    // Copied out as plain numbers: placementOf returns the live reactive
    // placement object, which moveTool below mutates in place.
    const placementBeforeLive = trace.placementOf(tool.id)!;
    const placementBefore = { xMm: placementBeforeLive.xMm, yMm: placementBeforeLive.yMm };

    // Re-finish: the small square moves to a new corner of the same big
    // square (smallOld is dropped, smallNew is unmatched-new); big itself is
    // reselected unchanged. This is exactly the sequence
    // TraceTab.finishSketch's re-finish path runs.
    const oldParts = tool.parts;
    const oldFilledHoles = tool.filledHoles;
    const newRawParts = [big, smallNew];
    const newParts = recentredParts(sortPartsByCentroid(newRawParts));
    const matches = matchPartsByGeometry(oldParts, newParts);
    // Exactly one part (big) survived; smallOld has no match (dropped) and
    // smallNew is a new, unmatched part.
    expect(matches).toHaveLength(1);

    trace.replaceToolParts(tool.id, newRawParts, { kind: 'sketch', sketch });
    expect(tool.parts).toHaveLength(2);
    // replaceToolParts clears filledHoles as its own baseline; the re-finish
    // flow always remaps and reapplies them right after.
    expect(tool.filledHoles).toEqual([]);

    const remapped = oldFilledHoles
      .map((f) => {
        const match = matches.find((m) => m.oldIndex === f.partIndex);
        return match === undefined ? null : { partIndex: match.newIndex, holeIndex: f.holeIndex };
      })
      .filter((f): f is { partIndex: number; holeIndex: number } => f !== null);
    trace.setFilledHoles(tool.id, remapped);

    // Only the surviving (big-square) part's fill carried over; the dropped
    // small-square part's fill is gone.
    expect(tool.filledHoles).toHaveLength(1);
    expect(tool.filledHoles[0]).toEqual({ partIndex: matches[0].newIndex, holeIndex: 0 });

    const adjusted = placementPreservingCentroid(oldParts, newParts, placementBefore);
    trace.moveTool(tool.id, adjusted.xMm, adjusted.yMm);
    const placementAfter = trace.placementOf(tool.id)!;
    // The combined centroid's world position is unchanged even though the
    // tool-local parts (and their own combined centroid) moved.
    const { combinedCentroidOf } = await import('../../src/engine/trace/edit');
    const worldBefore = combinedCentroidOf(oldParts);
    const worldAfter = combinedCentroidOf(newParts);
    expect(placementAfter.xMm + worldAfter.x).toBeCloseTo(placementBefore.xMm + worldBefore.x, 6);
    expect(placementAfter.yMm + worldAfter.y).toBeCloseTo(placementBefore.yMm + worldBefore.y, 6);
  });

  it('re-finish drops a remapped filled hole whose index no longer exists on the matched part', async () => {
    const { matchPartsByGeometry } = await import('../../src/engine/trace/edit');

    // A single square part with two holes; its re-finished replacement lands
    // at (nearly) the same centroid but has only one hole. A fill on the
    // second (now-gone) hole must be dropped, not carried over as an index
    // the plan's own import validation would later reject.
    const twoHoleSquare = {
      outer: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      holes: [
        [
          { x: 2, y: 2 },
          { x: 2, y: 4 },
          { x: 4, y: 4 },
          { x: 4, y: 2 },
        ],
        [
          { x: 14, y: 14 },
          { x: 14, y: 16 },
          { x: 16, y: 16 },
          { x: 16, y: 14 },
        ],
      ],
    };
    const oneHoleSquare = {
      outer: twoHoleSquare.outer.map((p) => ({ ...p })),
      holes: [twoHoleSquare.holes[0].map((p) => ({ ...p }))],
    };

    const trace = useToolTrace();
    const sketch = { schemaVersion: SKETCH_SCHEMA_VERSION, entities: [], constraints: [] };
    const tool = trace.addToolParts([twoHoleSquare], 'Sketched shape', { kind: 'sketch', sketch });
    trace.toggleFilledHole(tool.id, 0, 0); // hole 0, survives
    trace.toggleFilledHole(tool.id, 0, 1); // hole 1, will be out of range after re-finish
    expect(tool.filledHoles).toHaveLength(2);

    const oldParts = tool.parts;
    const oldFilledHoles = tool.filledHoles;
    const newRawParts = [oneHoleSquare];
    const { recentredParts } = await import('../../src/engine/trace/layoutModel');
    const { sortPartsByCentroid } = await import('../../src/engine/trace/edit');
    const newParts = recentredParts(sortPartsByCentroid(newRawParts));
    const matches = matchPartsByGeometry(oldParts, newParts);
    expect(matches).toHaveLength(1);

    trace.replaceToolParts(tool.id, newRawParts, { kind: 'sketch', sketch });

    const remapped = oldFilledHoles
      .map((f) => {
        const match = matches.find((m) => m.oldIndex === f.partIndex);
        if (match === undefined) return null;
        if (f.holeIndex >= newParts[match.newIndex].holes.length) return null;
        return { partIndex: match.newIndex, holeIndex: f.holeIndex };
      })
      .filter((f): f is { partIndex: number; holeIndex: number } => f !== null);
    trace.setFilledHoles(tool.id, remapped);

    // Only hole 0's fill (still present on the matched part) carries over;
    // hole 1's fill, now out of range, is dropped rather than kept verbatim.
    expect(tool.filledHoles).toHaveLength(1);
    expect(tool.filledHoles[0]).toEqual({ partIndex: matches[0].newIndex, holeIndex: 0 });
  });
});
