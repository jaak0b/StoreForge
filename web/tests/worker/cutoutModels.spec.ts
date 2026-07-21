import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import {
  CavityEditedBodyCache,
  CutoutModelCache,
  CutoutSweptCache,
  importCutoutModel,
  resolveCutoutModels,
  sweptKeyOf,
  sweptMemoFor,
  type SweptMemoEvent,
  type CutoutModelKeySpec,
  type CutoutModelRequest,
} from '../../src/worker/cutoutModels';
import {
  DEFAULT_CUTOUT_CLEARANCE_MM,
  buildCutoutBinBody,
  cutoutModelKey,
  prepareCutoutModel,
  type CutoutBinParams,
  type ModelPlacement,
  type PreparedCutoutModel,
  type SweptSolidMemo,
} from '../../src/engine/cutout/cutoutBin';
import {
  applyCavityEdits,
  applyCavityEditsMemoized,
} from '../../src/engine/cutout/cavityEdits';
import { referencedCutoutModelKeySpecs } from '../../src/engine/plan/storedAssets';
import type { CavityEdit, QueueEntry } from '../../src/engine/plan/types';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

const AT_ORIGIN: ModelPlacement = {
  xMm: 0,
  yMm: 0,
  zMm: 0,
  rotXDeg: 0,
  rotYDeg: 0,
  rotZDeg: 0,
};

function spec(overrides: Partial<CutoutModelKeySpec> = {}): CutoutModelKeySpec {
  return {
    modelSourceId: 'model-a',
    unitScale: 1,
    clearanceMm: DEFAULT_CUTOUT_CLEARANCE_MM,
    ...overrides,
  };
}

/**
 * A real import, so the seam being counted is the same work the worker does
 * and not a stand-in that could stay cheap while the real one got expensive.
 */
function prepareCube(sizeMm: number, keySpec: CutoutModelKeySpec): PreparedCutoutModel {
  return prepareCutoutModel(m, m.Manifold.cube([sizeMm, sizeMm, sizeMm], true), {
    name: 'part.stl',
    unitScale: keySpec.unitScale,
    clearanceMm: keySpec.clearanceMm,
  });
}

/** A cache holding one prepared cube per spec, plus a way to release them all. */
function cacheOf(specs: CutoutModelKeySpec[]): CutoutModelCache {
  const cache = new CutoutModelCache();
  for (const keySpec of specs) cache.put(keySpec, prepareCube(10, keySpec));
  return cache;
}

describe('the prepared model cache', () => {
  it('performs the import once when the same model is imported twice', () => {
    // The whole responsiveness argument for the feature is that the clearance
    // offset runs once per model per clearance and never again while the user
    // drags. Counting the calls rather than the wall clock keeps the assertion
    // stable in CI, where timings are not.
    const cache = new CutoutModelCache();
    const prepare = vi.fn(() => prepareCube(10, spec()));

    const first = importCutoutModel(cache, spec(), prepare);
    const second = importCutoutModel(cache, spec(), prepare);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(first.outcome).toBe('miss');
    expect(second.outcome).toBe('hit');
    // A hit still reports the facts, so the caller cannot tell the difference
    // anywhere except in the timing line.
    expect(second.facts).toEqual(first.facts);

    cache.release([]);
  });

  it('re-imports when the clearance changes and not when the placement does', () => {
    // Keying by model alone has no visible symptom: the preview renders, the
    // solid is watertight, the download succeeds, and the printed part is
    // simply the wrong size. Placement is not part of the key at all, because
    // it is applied to the cached solid rather than baked into it.
    const cache = new CutoutModelCache();
    const prepare = vi.fn((keySpec: CutoutModelKeySpec) => prepareCube(10, keySpec));

    importCutoutModel(cache, spec(), () => prepare(spec()));
    const sameAgain = importCutoutModel(cache, spec(), () => prepare(spec()));
    const wider = spec({ clearanceMm: 0.8 });
    const afterClearanceChange = importCutoutModel(cache, wider, () => prepare(wider));

    expect(sameAgain.outcome).toBe('hit');
    expect(afterClearanceChange.outcome).toBe('miss');
    expect(prepare).toHaveBeenCalledTimes(2);

    cache.release([]);
  });

  it('re-imports when the unit scale changes', () => {
    // A scale correction rescales the model before it is simplified and
    // dilated, so it invalidates the entry exactly as a clearance change does,
    // and with exactly the same silent wrong-size failure if it does not.
    const cache = new CutoutModelCache();
    const inches = spec({ unitScale: 25.4 });

    const first = importCutoutModel(cache, spec(), () => prepareCube(10, spec()));
    const rescaled = importCutoutModel(cache, inches, () => prepareCube(10, inches));

    expect(first.outcome).toBe('miss');
    expect(rescaled.outcome).toBe('miss');
    expect(rescaled.facts.sizeMm.x).toBeCloseTo(first.facts.sizeMm.x * 25.4, 3);

    cache.release([]);
  });

  it('leaves the other models cached when one model is re-imported', () => {
    // A clearance change costs one Minkowski sum, not one per model in the
    // bin. Invalidating the whole cache would turn a one model cost into an
    // all model one with nothing on screen to show for it.
    const a = spec({ modelSourceId: 'model-a' });
    const b = spec({ modelSourceId: 'model-b' });
    const cache = cacheOf([a, b]);
    const prepare = vi.fn(() => prepareCube(10, spec({ clearanceMm: 0.8 })));

    importCutoutModel(cache, spec({ modelSourceId: 'model-a', clearanceMm: 0.8 }), prepare);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(cache.get(b)).toBeDefined();
    expect(cache.get(a)).toBeDefined();

    cache.release([]);
  });

  it('reports exactly the specs it does not hold', () => {
    const held = spec();
    const cache = cacheOf([held]);
    const wanted = [held, spec({ clearanceMm: 0.8 }), spec({ modelSourceId: 'model-b' })];

    expect(cache.missing(wanted)).toEqual([
      spec({ clearanceMm: 0.8 }),
      spec({ modelSourceId: 'model-b' }),
    ]);

    cache.release([]);
  });
});

describe('releasing cached solids', () => {
  it('drops superseded clearance keys for a model still in the bin', () => {
    // Tuning a clearance through several values must not leave one solid per
    // value in the WASM heap, which nothing collects.
    const tried = [0.2, 0.4, 0.6, 0.8].map((clearanceMm) => spec({ clearanceMm }));
    const cache = cacheOf(tried);
    const settled = tried[tried.length - 1];
    const superseded = cache.get(tried[0])!;

    cache.release([settled]);

    expect(cache.size).toBe(1);
    expect(cache.get(settled)).toBeDefined();
    // Evicting has to free the solid, not just forget the entry.
    expect(() => superseded.solid.volume()).toThrow(/deleted object/);

    cache.release([]);
  });

  it('drops a superseded unit scale key the same way', () => {
    // Accepting a rescale proposal must not leave the pre-correction solid
    // behind, which is the same argument as the clearance one.
    const asMillimetres = spec({ unitScale: 1 });
    const asInches = spec({ unitScale: 25.4 });
    const cache = cacheOf([asMillimetres, asInches]);

    cache.release([asInches]);

    expect(cache.size).toBe(1);
    expect(cache.get(asInches)).toBeDefined();
    expect(cache.get(asMillimetres)).toBeUndefined();

    cache.release([]);
  });

  it('keeps a queued model cached when the editor closes, and frees it with the last reference', () => {
    // The owner decision this encodes: a prepared solid stays alive while ANY
    // reference to its model exists on the page, the open editor OR a queue
    // row. Releasing with only the editor's own models after queueing a bin
    // wiped the cache and cost the 18 second offset again on re-opening.
    const editorOnly = spec({ modelSourceId: 'model-editor' });
    const queued = spec({ modelSourceId: 'model-queued' });
    const cache = cacheOf([editorOnly, queued]);
    const queuedEntry: QueueEntry = {
      id: 'c1',
      quantity: 1,
      createdAt: '2026-07-20T10:00:00.000Z',
      product: {
        kind: 'bin',
        bin: {
          origin: 'cutout',
          gridX: 1,
          gridY: 1,
          heightUnits: 3,
          magnetHoles: false,
          edits: [],
          models: [
            {
              id: 'record-queued',
              name: 'part.stl',
              modelSourceId: 'model-queued',
              triangleCount: 12,
              unitScale: 1,
              sizeMm: { x: 10, y: 10, z: 10 },
              placement: AT_ORIGIN,
              clearanceMm: DEFAULT_CUTOUT_CLEARANCE_MM,
              sweepEnabled: false,
              draftAngleDeg: 0,
            },
          ],
        },
      },
    };

    // The editor resets after queueing: its own models are gone, the queue row remains.
    cache.release(referencedCutoutModelKeySpecs([queuedEntry], [], []));

    expect(cache.get(queued)).toBeDefined();
    expect(cache.get(editorOnly)).toBeUndefined();

    // The queue row is deleted: the last reference goes, and so does the solid.
    cache.release(referencedCutoutModelKeySpecs([], [], []));
    expect(cache.size).toBe(0);
  });

  it('frees the solid an entry replaces rather than leaking it', () => {
    const cache = new CutoutModelCache();
    const first = prepareCube(10, spec());
    cache.put(spec(), first);

    cache.put(spec(), prepareCube(20, spec()));

    expect(() => first.solid.volume()).toThrow(/deleted object/);

    cache.release([]);
  });
});

describe('pinning borrowed solids across a carve await', () => {
  /** A promise the test resolves by hand, standing in for the persisted-tier await. */
  function gate(): { open: () => void; closed: Promise<void> } {
    let open!: () => void;
    const closed = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, closed };
  }

  it('does not free a borrowed solid when a release arrives during the await window', async () => {
    // The worker's single thread yields at the persisted-tier await inside a
    // carve, and a plan mutation's release can run right there. The solid the
    // carve borrowed must survive that release, or the carve resumes on freed
    // WASM memory.
    const borrowed = spec({ modelSourceId: 'model-borrowed' });
    const unreferenced = spec({ modelSourceId: 'model-unreferenced' });
    const cache = cacheOf([borrowed, unreferenced]);
    const borrowedSolid = cache.get(borrowed)!.solid;
    const unreferencedSolid = cache.get(unreferenced)!.solid;
    const awaitWindow = gate();

    const carve = cache.whilePinned([borrowed], async () => {
      await awaitWindow.closed;
      // The carve resumes and consumes the solid it borrowed before the await.
      return borrowedSolid.volume();
    });
    // The release fires while the carve is suspended, keeping nothing.
    cache.release([]);

    // The unpinned entry went; the pinned one is deferred, not freed.
    expect(() => unreferencedSolid.volume()).toThrow(/deleted object/);
    expect(cache.get(borrowed)).toBeDefined();

    awaitWindow.open();
    await expect(carve).resolves.toBeGreaterThan(0);

    cache.release([]);
  });

  it('applies the deferred eviction when the borrow ends', async () => {
    const borrowed = spec({ modelSourceId: 'model-borrowed' });
    const cache = cacheOf([borrowed]);
    const borrowedSolid = cache.get(borrowed)!.solid;
    const awaitWindow = gate();

    const carve = cache.whilePinned([borrowed], async () => {
      await awaitWindow.closed;
    });
    cache.release([]);
    awaitWindow.open();
    await carve;

    // The release keeps its meaning with only its timing deferred: once no
    // carve borrows the solid, what the caller stopped naming does go.
    expect(cache.get(borrowed)).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(() => borrowedSolid.volume()).toThrow(/deleted object/);
  });

  it('keeps a still-named pinned entry cached after the borrow ends', async () => {
    // A release that KEEPS the pinned key must not schedule an eviction: the
    // deferral only remembers evictions actually asked for.
    const borrowed = spec({ modelSourceId: 'model-borrowed' });
    const cache = cacheOf([borrowed]);
    const awaitWindow = gate();

    const carve = cache.whilePinned([borrowed], async () => {
      await awaitWindow.closed;
    });
    cache.release([borrowed]);
    awaitWindow.open();
    await carve;

    expect(cache.get(borrowed)).toBeDefined();
    cache.release([]);
  });

  it('leaves both carves’ solids alive when two interleaved carves each release to their own keep set', async () => {
    // The preview vs export interleaving: each carve releases keeping only
    // the keys it names, so each release would evict the other carve's
    // borrowed solid if pins did not defer it.
    const forPreview = spec({ modelSourceId: 'model-preview' });
    const forExport = spec({ modelSourceId: 'model-export' });
    const cache = cacheOf([forPreview, forExport]);
    const previewSolid = cache.get(forPreview)!.solid;
    const exportSolid = cache.get(forExport)!.solid;
    const previewWindow = gate();
    const exportWindow = gate();

    const preview = cache.whilePinned([forPreview], async () => {
      await previewWindow.closed;
      return previewSolid.volume();
    });
    const exportCarve = cache.whilePinned([forExport], async () => {
      await exportWindow.closed;
      return exportSolid.volume();
    });
    // Each carve's own release names only its own model.
    cache.release([forPreview]);
    cache.release([forExport]);

    // Both borrowed solids are still alive while both carves are in flight.
    expect(previewSolid.volume()).toBeGreaterThan(0);
    expect(exportSolid.volume()).toBeGreaterThan(0);

    previewWindow.open();
    exportWindow.open();
    await expect(preview).resolves.toBeGreaterThan(0);
    await expect(exportCarve).resolves.toBeGreaterThan(0);

    // The deferred evictions applied as each borrow ended: the preview's
    // model was evicted by the export's release and vice versa.
    expect(cache.size).toBe(0);
  });

  it('protects a pinned swept solid from release and retainForModelKeys alike', async () => {
    const cache = new CutoutSweptCache();
    const modelKey = cutoutModelKey('model-a', 1, 0.4);
    const key = `${modelKey}:0:0:0:5`;
    const solid = m.Manifold.cube([2, 2, 40], true);
    cache.put(key, { solid, lengthMm: 40 });
    const awaitWindow = gate();

    const carve = cache.whilePinned([key], async () => {
      await awaitWindow.closed;
      return solid.volume();
    });
    // Both eviction paths fire during the await window: a concurrent carve's
    // release and a plan mutation dropping the source model.
    cache.release([]);
    cache.retainForModelKeys([]);

    expect(cache.get(key)).toBeDefined();
    awaitWindow.open();
    await expect(carve).resolves.toBeGreaterThan(0);

    // The deferred eviction applied when the borrow ended.
    expect(cache.size).toBe(0);
    expect(() => solid.volume()).toThrow(/deleted object/);
  });

  it('frees a solid pinned by two overlapping carves only after the last unpin', async () => {
    // A preview and an export of the same bin pin the same key at once; the
    // first to finish must not free what the second still borrows.
    const shared = spec({ modelSourceId: 'model-shared' });
    const cache = cacheOf([shared]);
    const sharedSolid = cache.get(shared)!.solid;
    const firstWindow = gate();
    const secondWindow = gate();

    const first = cache.whilePinned([shared], async () => {
      await firstWindow.closed;
    });
    const second = cache.whilePinned([shared], async () => {
      await secondWindow.closed;
      return sharedSolid.volume();
    });
    cache.release([]);

    firstWindow.open();
    await first;
    // The first carve finished, the second still borrows: not freed yet.
    expect(sharedSolid.volume()).toBeGreaterThan(0);

    secondWindow.open();
    await expect(second).resolves.toBeGreaterThan(0);
    expect(cache.size).toBe(0);
  });
});

describe('resolving a carve request against the cache', () => {
  function request(overrides: Partial<CutoutModelRequest> = {}): CutoutModelRequest {
    return {
      ...spec(),
      name: 'part.stl',
      placement: AT_ORIGIN,
      sweepEnabled: false,
      draftAngleDeg: 0,
      ...overrides,
    };
  }

  it('hands the carve the cached solid without taking ownership of it', () => {
    const cache = cacheOf([spec()]);
    const cached = cache.get(spec())!;

    const resolved = resolveCutoutModels(cache, [request()]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].solid).toBe(cached.solid);
    expect(resolved[0].name).toBe('part.stl');
    // Still cached and still usable after the carve consumed it.
    expect(cached.solid.volume()).toBeGreaterThan(0);

    cache.release([]);
  });

  it('resolves the same cached solid whatever the sweep fields say', () => {
    // The sweep is applied at carve time on the placed cutter, so turning it
    // on or changing the draft angle must hit the same cache entry: no new
    // key, no import miss, only a re-carve. The fields ride through to the
    // carve spec, which is where the sweep actually reads them.
    const cache = cacheOf([spec()]);
    const cached = cache.get(spec())!;

    const resolved = resolveCutoutModels(cache, [
      request({ sweepEnabled: true, draftAngleDeg: 10 }),
    ]);

    expect(resolved[0].solid).toBe(cached.solid);
    expect(resolved[0].sweepEnabled).toBe(true);
    expect(resolved[0].draftAngleDeg).toBe(10);
    expect(cache.missing([spec()])).toEqual([]);

    cache.release([]);
  });

  it('refuses a model whose solid is not loaded, in the words the user gets', () => {
    // Generating with a model silently missing would export a solid block of
    // plastic and waste a real print, so this blocks rather than warns.
    const cache = new CutoutModelCache();

    expect(() => resolveCutoutModels(cache, [request({ name: 'bracket.stl' })])).toThrow(
      'The model "bracket.stl" is not stored on this device, so this bin cannot be ' +
        'generated. Upload the model again, or remove it from the bin.',
    );
  });
});

describe('the swept solid key', () => {
  function sweptRequest(overrides: Partial<CutoutModelRequest> = {}): CutoutModelRequest {
    return {
      ...spec(),
      name: 'part.stl',
      placement: { ...AT_ORIGIN, rotXDeg: 30 },
      sweepEnabled: true,
      draftAngleDeg: 5,
      ...overrides,
    };
  }

  it('is null for an unswept model, which never consults the cache', () => {
    expect(sweptKeyOf(sweptRequest({ sweepEnabled: false }))).toBeNull();
  });

  it('changes with the rotation, because the sweep is not rotation invariant', () => {
    const base = sweptKeyOf(sweptRequest())!;
    const turned = sweptKeyOf(
      sweptRequest({ placement: { ...AT_ORIGIN, rotXDeg: 30, rotZDeg: 90 } }),
    )!;
    expect(turned).not.toBe(base);
  });

  it('changes with the draft angle and the model identity, not with the position', () => {
    const base = sweptKeyOf(sweptRequest())!;
    expect(sweptKeyOf(sweptRequest({ draftAngleDeg: 10 }))).not.toBe(base);
    expect(sweptKeyOf(sweptRequest({ clearanceMm: 0.8 }))).not.toBe(base);
    // A pure translation keys identically: that is what makes a drag end a
    // cache hit rather than a fresh Minkowski sum.
    expect(
      sweptKeyOf(
        sweptRequest({
          placement: { ...AT_ORIGIN, rotXDeg: 30, xMm: 12, yMm: -4, zMm: 20 },
        }),
      ),
    ).toBe(base);
  });
});

describe('the swept solid cache', () => {
  /** A memo over a fresh cache, recording every consultation. */
  function memoWithLog(): {
    cache: CutoutSweptCache;
    memo: SweptSolidMemo;
    events: SweptMemoEvent[];
  } {
    const cache = new CutoutSweptCache();
    const events: SweptMemoEvent[] = [];
    const memo = sweptMemoFor(cache, (event) => events.push(event));
    return { cache, memo, events };
  }

  it('computes once and answers a second consultation of the same key from the cache', () => {
    const { cache, memo, events } = memoWithLog();
    const compute = vi.fn((lengthMm: number) =>
      m.Manifold.cube([2, 2, lengthMm], true),
    );

    memo('key-a', { minLengthMm: 10, standardLengthMm: 40 }, compute);
    // A shorter minimum, as a model dragged upward asks for: still covered.
    memo('key-a', { minLengthMm: 5, standardLengthMm: 40 }, compute);

    expect(compute).toHaveBeenCalledTimes(1);
    // The miss computed at the standard length, which is what covers later
    // placements down to the bed.
    expect(compute).toHaveBeenCalledWith(40);
    expect(events.map((event) => event.outcome)).toEqual(['miss', 'hit']);

    cache.release([]);
  });

  it('recomputes when the cached length no longer covers the placement', () => {
    // A model dragged below the bed needs a longer sweep than the standard
    // bed-anchored length; serving the short solid would leave its pocket
    // stopping short of the bin top.
    const { cache, memo } = memoWithLog();
    const compute = vi.fn((lengthMm: number) =>
      m.Manifold.cube([2, 2, lengthMm], true),
    );

    memo('key-a', { minLengthMm: 10, standardLengthMm: 40 }, compute);
    memo('key-a', { minLengthMm: 55, standardLengthMm: 40 }, compute);

    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute).toHaveBeenLastCalledWith(55);

    cache.release([]);
  });

  it('computes separately for separate keys, which is a rotation or angle change', () => {
    const { cache, memo, events } = memoWithLog();
    const compute = vi.fn((lengthMm: number) =>
      m.Manifold.cube([2, 2, lengthMm], true),
    );

    memo('key-a', { minLengthMm: 10, standardLengthMm: 40 }, compute);
    memo('key-b', { minLengthMm: 10, standardLengthMm: 40 }, compute);

    expect(compute).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.outcome)).toEqual(['miss', 'miss']);
    expect(cache.size).toBe(2);

    cache.release([]);
  });

  it('releases everything the current carve does not name', () => {
    // The same explicit eviction the prepared-model cache uses: a model
    // rotated through many angles must not accumulate one swept solid per
    // angle it passed through.
    const { cache, memo } = memoWithLog();
    const compute = (lengthMm: number): ReturnType<typeof m.Manifold.cube> =>
      m.Manifold.cube([2, 2, lengthMm], true);

    memo('key-a', { minLengthMm: 10, standardLengthMm: 40 }, compute);
    memo('key-b', { minLengthMm: 10, standardLengthMm: 40 }, compute);
    cache.release(['key-b']);

    expect(cache.size).toBe(1);
    expect(cache.get('key-a')).toBeUndefined();
    expect(cache.get('key-b')).toBeDefined();

    cache.release([]);
    expect(cache.size).toBe(0);
  });

  it('drops the swept solids of a released prepared model, and keeps the rest', () => {
    const { cache, memo } = memoWithLog();
    const compute = (lengthMm: number): ReturnType<typeof m.Manifold.cube> =>
      m.Manifold.cube([2, 2, lengthMm], true);
    const keptModel = cutoutModelKey('model-a', 1, 0.4);
    const droppedModel = cutoutModelKey('model-b', 1, 0.4);

    memo(`${keptModel}:0:0:0:0`, { minLengthMm: 10, standardLengthMm: 40 }, compute);
    memo(`${droppedModel}:0:0:0:0`, { minLengthMm: 10, standardLengthMm: 40 }, compute);
    cache.retainForModelKeys([keptModel]);

    expect(cache.size).toBe(1);
    expect(cache.get(`${keptModel}:0:0:0:0`)).toBeDefined();

    cache.release([]);
  });
});

describe('a carve through the swept cache', () => {
  /** A 2x2x6 bin around the given models. */
  function params(models: CutoutBinParams['models'], memo?: SweptSolidMemo): CutoutBinParams {
    return {
      gridX: 2,
      gridY: 2,
      heightUnits: 6,
      magnetHoles: true,
      walls: [],
      labelSlot: true,
      insert: null,
      models,
      sweptMemo: memo,
    };
  }

  it('produces exactly the direct-path bin, cold and warm, on a rotated translated model', () => {
    // The equality the whole cache design rests on: the cached solid is built
    // in the rotated frame at a longer sweep length, translated and trimmed,
    // and that must be the same bin the uncached path carves. Volume and
    // bounds together pin it; a length-dependent cutter would move both.
    const cache = new CutoutSweptCache();
    const memo = sweptMemoFor(cache, () => {});
    const prepared = prepareCutoutModel(
      m,
      m.Manifold.cube([10, 20, 30], true),
      { name: 'part.stl', unitScale: 1, clearanceMm: 0 },
    ).solid;
    const model = {
      name: 'part.stl',
      solid: prepared,
      placement: { xMm: 6, yMm: -3, zMm: 21, rotXDeg: 90, rotYDeg: 0, rotZDeg: 30 },
      clearanceMm: 0,
      sweepEnabled: true,
      draftAngleDeg: 5,
    };

    const direct = buildCutoutBinBody(m, params([model]));
    const cold = buildCutoutBinBody(m, params([{ ...model, sweptKey: 'k' }], memo));
    const warm = buildCutoutBinBody(m, params([{ ...model, sweptKey: 'k' }], memo));

    for (const carve of [cold, warm]) {
      expect(carve.body.volume()).toBeCloseTo(direct.body.volume(), 6);
      const expected = direct.body.boundingBox();
      const box = carve.body.boundingBox();
      for (let axis = 0; axis < 3; axis += 1) {
        expect(box.min[axis]).toBeCloseTo(expected.min[axis], 6);
        expect(box.max[axis]).toBeCloseTo(expected.max[axis], 6);
      }
      // Same pocket, so same reported size; closeTo rather than exact because
      // the trim-plane intersection is computed against different sweep
      // lengths on the two paths and the last floating-point bit can differ.
      expect(carve.footprints[0].sizeMm.x).toBeCloseTo(direct.footprints[0].sizeMm.x, 9);
      expect(carve.footprints[0].sizeMm.y).toBeCloseTo(direct.footprints[0].sizeMm.y, 9);
      expect(carve.footprints[0].sizeMm.z).toBeCloseTo(direct.footprints[0].sizeMm.z, 9);
    }

    direct.body.delete();
    cold.body.delete();
    warm.body.delete();
    cache.release([]);
    prepared.delete();
  });

  it('answers a pure drag from the cache and a rotation change with a fresh sweep', () => {
    const cache = new CutoutSweptCache();
    const events: SweptMemoEvent[] = [];
    const memo = sweptMemoFor(cache, (event) => events.push(event));
    const prepared = prepareCutoutModel(
      m,
      m.Manifold.cube([10, 20, 30], true),
      { name: 'part.stl', unitScale: 1, clearanceMm: 0 },
    ).solid;
    const modelAt = (placement: ModelPlacement): CutoutBinParams['models'][number] => ({
      name: 'part.stl',
      solid: prepared,
      placement,
      clearanceMm: 0,
      sweepEnabled: true,
      draftAngleDeg: 0,
      sweptKey: `part:${placement.rotXDeg}`,
    });

    const first = buildCutoutBinBody(
      m,
      params([modelAt({ ...AT_ORIGIN, zMm: 21 })], memo),
    );
    // A drag: same rotation, different position, including downward.
    const dragged = buildCutoutBinBody(
      m,
      params([modelAt({ ...AT_ORIGIN, xMm: 10, zMm: 16 })], memo),
    );
    // A rotation: a different key, so a fresh sweep.
    const rotated = buildCutoutBinBody(
      m,
      params([modelAt({ ...AT_ORIGIN, rotXDeg: 90, zMm: 21 })], memo),
    );

    expect(events.map((event) => event.outcome)).toEqual(['miss', 'hit', 'miss']);

    first.body.delete();
    dragged.body.delete();
    rotated.body.delete();
    cache.release([]);
    prepared.delete();
  });
});

describe('CavityEditedBodyCache and applyCavityEditsMemoized', () => {
  it('appending one edit reuses the memoized body; any other prefix rebuilds', async () => {
    const cache = new CavityEditedBodyCache();
    const recipeKey = 'recipe';
    const freshBody = () => m.Manifold.cube([40, 40, 20], false);
    let binSolidBuilds = 0;
    const makeBinSolid = () => {
      binSolidBuilds += 1;
      return m.Manifold.cube([40, 40, 20], false);
    };
    const e1: CavityEdit = { kind: 'remove', points: [{ xMm: 5, yMm: 5, zMm: 18 }], radiusMm: 3 };
    const e2: CavityEdit = { kind: 'remove', points: [{ xMm: 30, yMm: 30, zMm: 18 }], radiusMm: 3 };
    const first = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1], {
      store: cache, recipeKey,
    });
    expect(cache.size).toBe(1);
    const second = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1, e2], {
      store: cache, recipeKey,
    });
    // The appended-edit path never rebuilds e1, so its result equals the full fold.
    const full = applyCavityEdits(m, freshBody(), makeBinSolid(), [e1, e2]);
    expect(Math.abs(second.volume() - full.volume())).toBeLessThan(1e-6);
    // An undo (shorter list) is a full rebuild, not a crash and not a stale hit.
    const undone = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1], {
      store: cache, recipeKey,
    });
    expect(Math.abs(undone.volume() - first.volume())).toBeLessThan(1e-6);
    first.delete(); second.delete(); full.delete(); undone.delete();
    cache.clear();
    expect(binSolidBuilds).toBeGreaterThan(0);
  });
});
