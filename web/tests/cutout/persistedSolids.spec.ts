import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import {
  CUTOUT_SOLID_SCHEMA_VERSION,
  decodePreparedCutoutModel,
  decodeSweptSolid,
  encodePreparedCutoutModel,
  encodeSweptSolid,
  persistedSolidKeyIsFor,
  type PersistedSolidRecord,
} from '../../src/engine/cutout/persistedSolids';
import {
  cutoutModelKey,
  prepareCutoutModel,
  type PreparedCutoutModel,
} from '../../src/engine/cutout/cutoutBin';
import {
  CutoutModelCache,
  importCutoutModel,
  restoreCutoutModels,
  type CutoutModelKeySpec,
  type PersistedSolids,
} from '../../src/worker/cutoutModels';

// IndexedDB has no node implementation, so the browser wrapper
// (src/solidStore.ts) stays thin and untested, following the photo and model
// store precedent; these tests cover the record format, its trust checks and
// the cache-fill decisions through an in-memory fake of the persisted tier.

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

const SPEC: CutoutModelKeySpec = { modelSourceId: 'model-a', unitScale: 1, clearanceMm: 0.4 };
const KEY = cutoutModelKey(SPEC.modelSourceId, SPEC.unitScale, SPEC.clearanceMm);

function preparedCube(): PreparedCutoutModel {
  return prepareCutoutModel(m, m.Manifold.cube([10, 20, 30], true), {
    name: 'part.stl',
    unitScale: SPEC.unitScale,
    clearanceMm: SPEC.clearanceMm,
  });
}

/** The persisted tier over a Map, recording saves as the real one would. */
function fakePersisted(records: Map<string, PersistedSolidRecord> = new Map()): PersistedSolids & {
  records: Map<string, PersistedSolidRecord>;
} {
  return {
    records,
    loadPrepared: (spec) => {
      const record = records.get(
        cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm),
      );
      return Promise.resolve(
        record !== undefined && record.kind === 'offset'
          ? decodePreparedCutoutModel(m, record)
          : null,
      );
    },
    savePrepared: (spec, prepared) => {
      const key = cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm);
      records.set(key, encodePreparedCutoutModel(key, prepared));
    },
    loadSwept: (key) => {
      const record = records.get(key);
      return Promise.resolve(
        record !== undefined && record.kind === 'swept' ? decodeSweptSolid(m, record) : null,
      );
    },
    saveSwept: (key, entry) => {
      records.set(key, encodeSweptSolid(key, entry));
    },
  };
}

describe('the persisted solid record round trip', () => {
  it('reconstructs a prepared solid with NoError status, equal volume and bounds', () => {
    const prepared = preparedCube();
    const record = encodePreparedCutoutModel(KEY, prepared);

    const restored = decodePreparedCutoutModel(m, record);

    expect(restored).not.toBeNull();
    expect(restored!.solid.status()).toBe('NoError');
    // The record stores the mesh exactly as getMesh hands it out, which is
    // float32 vertices (the same precision every mesh export carries), while
    // the live solid computes in double precision; the round trip is
    // therefore exact to float32, not to double.
    expect(restored!.solid.volume()).toBeCloseTo(prepared.solid.volume(), 3);
    const expected = prepared.solid.boundingBox();
    const box = restored!.solid.boundingBox();
    for (let axis = 0; axis < 3; axis += 1) {
      expect(box.min[axis]).toBeCloseTo(expected.min[axis], 5);
      expect(box.max[axis]).toBeCloseTo(expected.max[axis], 5);
    }
    expect(restored!.sizeMm).toEqual(prepared.sizeMm);
    expect(restored!.triangleCount).toBe(prepared.triangleCount);

    prepared.solid.delete();
    restored!.solid.delete();
  });

  it('reconstructs a swept solid with its cached sweep length', () => {
    const solid = m.Manifold.cube([2, 2, 40], true);
    const record = encodeSweptSolid(`${KEY}:0:0:0:5`, { solid, lengthMm: 40 });

    const restored = decodeSweptSolid(m, record);

    expect(restored).not.toBeNull();
    expect(restored!.lengthMm).toBe(40);
    expect(restored!.solid.status()).toBe('NoError');
    expect(restored!.solid.volume()).toBeCloseTo(solid.volume(), 6);

    solid.delete();
    restored!.solid.delete();
  });
});

describe('the persisted solid trust checks', () => {
  it('treats a record written under another schema version as a miss', () => {
    const prepared = preparedCube();
    const record = {
      ...encodePreparedCutoutModel(KEY, prepared),
      schemaVersion: CUTOUT_SOLID_SCHEMA_VERSION + 1,
    };

    expect(decodePreparedCutoutModel(m, record)).toBeNull();

    prepared.solid.delete();
  });

  it('treats a record written under another manifold-3d version as a miss', () => {
    const prepared = preparedCube();
    const record = {
      ...encodePreparedCutoutModel(KEY, prepared),
      manifoldVersion: '^0.0.1',
    };

    expect(decodePreparedCutoutModel(m, record)).toBeNull();

    prepared.solid.delete();
  });

  it('treats a corrupt record with truncated triangles as a miss without throwing', () => {
    // A record damaged in storage must never feed a printed part: whatever
    // the truncated mesh reconstructs to, it is not the solid that was
    // persisted, so it is a miss and gets recomputed and overwritten.
    const prepared = preparedCube();
    const intact = encodePreparedCutoutModel(KEY, prepared);
    const record = {
      ...intact,
      mesh: {
        ...intact.mesh,
        triVerts: intact.mesh.triVerts.slice(0, intact.mesh.triVerts.length - 2),
      },
    };

    expect(() => decodePreparedCutoutModel(m, record)).not.toThrow();
    expect(decodePreparedCutoutModel(m, record)).toBeNull();

    prepared.solid.delete();
  });
});

describe('filling the in-memory cache from the persisted tier', () => {
  it('answers an import from a persisted record without running the prepare', async () => {
    // The reload scenario end to end: a first import computes and persists,
    // a fresh cache (the reloaded worker) restores from the record, and the
    // 18 second prepare never runs again.
    const persisted = fakePersisted();
    const firstSession = new CutoutModelCache();
    importCutoutModel(firstSession, SPEC, preparedCube, (spec, prepared) =>
      persisted.savePrepared(spec, prepared),
    );
    expect(persisted.records.has(KEY)).toBe(true);
    firstSession.release([]);

    const reloaded = new CutoutModelCache();
    const prepare = vi.fn(preparedCube);
    const restored = await restoreCutoutModels(reloaded, [SPEC], persisted);
    const result = importCutoutModel(reloaded, SPEC, prepare);

    expect(restored.map((entry) => entry.spec)).toEqual([SPEC]);
    expect(result.outcome).toBe('hit');
    expect(prepare).not.toHaveBeenCalled();
    expect(reloaded.get(SPEC)!.solid.status()).toBe('NoError');

    reloaded.release([]);
  });

  it('leaves a spec with no usable record a miss that recomputes', async () => {
    const persisted = fakePersisted();
    const cache = new CutoutModelCache();

    const restored = await restoreCutoutModels(cache, [SPEC], persisted);
    const result = importCutoutModel(cache, SPEC, preparedCube);

    expect(restored).toEqual([]);
    expect(result.outcome).toBe('miss');

    cache.release([]);
  });
});

describe('which persisted records belong to a model key', () => {
  it('matches the offset key itself and swept keys under it, and nothing else', () => {
    expect(persistedSolidKeyIsFor('model-a:1:0.4', ['model-a:1:0.4'])).toBe(true);
    expect(persistedSolidKeyIsFor('model-a:1:0.4:0:0:90:5', ['model-a:1:0.4'])).toBe(true);
    // A different clearance is a different model key, not a suffix of this one.
    expect(persistedSolidKeyIsFor('model-a:1:0.8', ['model-a:1:0.4'])).toBe(false);
    expect(persistedSolidKeyIsFor('model-b:1:0.4', ['model-a:1:0.4'])).toBe(false);
  });
});
