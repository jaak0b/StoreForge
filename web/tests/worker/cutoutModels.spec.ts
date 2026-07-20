import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import {
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

  it('frees the solid an entry replaces rather than leaking it', () => {
    const cache = new CutoutModelCache();
    const first = prepareCube(10, spec());
    cache.put(spec(), first);

    cache.put(spec(), prepareCube(20, spec()));

    expect(() => first.solid.volume()).toThrow(/deleted object/);

    cache.release([]);
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
