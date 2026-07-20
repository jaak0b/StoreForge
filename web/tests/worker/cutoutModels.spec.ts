import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import {
  CutoutModelCache,
  importCutoutModel,
  resolveCutoutModels,
  type CutoutModelKeySpec,
  type CutoutModelRequest,
} from '../../src/worker/cutoutModels';
import {
  DEFAULT_CUTOUT_CLEARANCE_MM,
  prepareCutoutModel,
  type ModelPlacement,
  type PreparedCutoutModel,
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
    return { ...spec(), name: 'part.stl', placement: AT_ORIGIN, ...overrides };
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
