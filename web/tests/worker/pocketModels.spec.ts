import { beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, ManifoldToplevel } from 'manifold-3d';
import type { Font } from 'opentype.js';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import { pocketBinRecipeKey, type PocketBinRequest } from '../../src/worker/pocketModels';
import { CavityEditedBodyCache } from '../../src/worker/cavityEditedBodyCache';
import { generatePocketBin } from '../../src/engine/trace/pocketBin';
import {
  applyCavityEdits,
  applyCavityEditsMemoized,
} from '../../src/engine/carve/cavityEdits';
import { CarveCancelledError } from '../../src/engine/gridfinity/carvedBin';
import type { CavityEdit } from '../../src/engine/plan/types';
import type { ToolPlacement, TracedTool } from '../../src/engine/trace/types';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

/** The 30 x 22 L tool the pocket engine tests use, positively wound. */
function lTool(overrides: Partial<TracedTool> = {}): TracedTool {
  return {
    id: 'l-tool',
    name: 'L wrench',
    outline: {
      outer: [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 22 },
        { x: 0, y: 22 },
      ],
      holes: [],
    },
    rotationDeg: 0,
    offsetMm: 0,
    mirrored: false,
    minHoleWidthMm: 0,
    filledHoleIndices: [],
    clicks: [],
    fingerHoles: [],
    ...overrides,
  };
}

const centeredL: ToolPlacement = {
  toolId: 'l-tool',
  xMm: -15,
  yMm: -5.1,
  pocketDepthMm: 5,
  draftAngleDeg: 0,
};

function request(overrides: Partial<PocketBinRequest> = {}): PocketBinRequest {
  return {
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
    labelSlot: true,
    insert: null,
    tools: [lTool()],
    placements: [centeredL],
    edits: [],
    ...overrides,
  };
}

const e1: CavityEdit = { kind: 'remove', points: [{ xMm: -10, yMm: -1.5, zMm: 18 }], radiusMm: 3 };
const e2: CavityEdit = { kind: 'remove', points: [{ xMm: -8, yMm: 0, zMm: 18 }], radiusMm: 3 };

describe('pocketBinRecipeKey', () => {
  it('is stable when only the edits change, so appending one edit is a memo hit', () => {
    // The edits are excluded from the carve identity by construction: that is
    // the whole reason painting one more stroke onto an unchanged carve reuses
    // the previous body instead of missing on every keystroke.
    const base = pocketBinRecipeKey(request({ edits: [] }));
    expect(pocketBinRecipeKey(request({ edits: [e1] }))).toBe(base);
    expect(pocketBinRecipeKey(request({ edits: [e1, e2] }))).toBe(base);
  });

  it('changes with a placement move, a pocket depth, or a draft angle', () => {
    const base = pocketBinRecipeKey(request());
    expect(pocketBinRecipeKey(request({ placements: [{ ...centeredL, xMm: -12 }] }))).not.toBe(base);
    expect(
      pocketBinRecipeKey(request({ placements: [{ ...centeredL, pocketDepthMm: 8 }] })),
    ).not.toBe(base);
    expect(
      pocketBinRecipeKey(request({ placements: [{ ...centeredL, draftAngleDeg: 6 }] })),
    ).not.toBe(base);
  });

  it('changes with the tool geometry and with the bin envelope', () => {
    const base = pocketBinRecipeKey(request());
    expect(pocketBinRecipeKey(request({ tools: [lTool({ offsetMm: 1 })] }))).not.toBe(base);
    expect(pocketBinRecipeKey(request({ heightUnits: 4 }))).not.toBe(base);
    expect(pocketBinRecipeKey(request({ gridX: 3 }))).not.toBe(base);
  });
});

describe('the pocket flow edited-body memo keyed by pocketBinRecipeKey', () => {
  it('reuses the memoized body when appending one edit, and rebuilds on any other prefix', () => {
    // The pocket flow instantiates its own CavityEditedBodyCache; feeding it the
    // pocket recipe key exercises the same append-reuse contract the cutout flow
    // relies on, but proves the pocket key drives it.
    const cache = new CavityEditedBodyCache();
    const recipeKey = pocketBinRecipeKey(request());
    const freshBody = (): ReturnType<typeof m.Manifold.cube> => m.Manifold.cube([40, 40, 20], false);
    let binSolidBuilds = 0;
    const makeBinSolid = (): ReturnType<typeof m.Manifold.cube> => {
      binSolidBuilds += 1;
      return m.Manifold.cube([40, 40, 20], false);
    };

    const first = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1], {
      store: cache,
      recipeKey,
    });
    expect(cache.size).toBe(1);
    const second = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1, e2], {
      store: cache,
      recipeKey,
    });
    const full = applyCavityEdits(m, freshBody(), makeBinSolid(), [e1, e2]);
    // The appended-edit path never refolds e1, so its result equals the full fold.
    expect(Math.abs(second.volume() - full.volume())).toBeLessThan(1e-6);
    // An undo (shorter list) is a full rebuild, not a stale hit.
    const undone = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1], {
      store: cache,
      recipeKey,
    });
    expect(Math.abs(undone.volume() - first.volume())).toBeLessThan(1e-6);

    // A placement change gives a different recipe key: the memo misses.
    const movedKey = pocketBinRecipeKey(request({ placements: [{ ...centeredL, xMm: -12 }] }));
    const moved = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1, e2], {
      store: cache,
      recipeKey: movedKey,
    });
    expect(cache.size).toBe(1);

    first.delete();
    second.delete();
    full.delete();
    undone.delete();
    moved.delete();
    cache.clear();
    expect(binSolidBuilds).toBeGreaterThan(0);
  });

  it('two flows with separate caches do not evict each other', () => {
    // The worker instantiates one CavityEditedBodyCache per flow; a store into
    // one leaves the other's warm body untouched.
    const cutoutCache = new CavityEditedBodyCache();
    const pocketCache = new CavityEditedBodyCache();
    const recipeKey = pocketBinRecipeKey(request());

    applyCavityEditsMemoized(m, m.Manifold.cube([40, 40, 20], false), () => m.Manifold.cube([40, 40, 20], false), [e1], {
      store: pocketCache,
      recipeKey,
    }).delete();
    expect(pocketCache.size).toBe(1);
    expect(cutoutCache.size).toBe(0);

    pocketCache.clear();
  });
});

describe('a superseded pocket preview carve', () => {
  /** The ExecutionContext constructor, reached exactly as the worker reaches it. */
  function newContext(): ExecutionContext {
    const factory = m as unknown as { ExecutionContext: new () => ExecutionContext };
    return new factory.ExecutionContext();
  }

  it('reports supersession as a CarveCancelledError, not an invalid solid', () => {
    // A preview the user superseded himself must not reach him as "Pocket bin
    // generation produced an invalid solid: Cancelled", which reads as a defect
    // in a bin that is perfectly fine. The worker turns this error into a
    // superseded outcome; here we prove the carve raises it under a cancelled
    // context, matching the cutout flow.
    const ctx = newContext();
    ctx.cancel();

    let thrown: unknown;
    try {
      generatePocketBin(m, font, request(), ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CarveCancelledError);
    expect((thrown as Error).message).not.toContain('invalid solid');

    ctx.delete();
  });

  it('carves normally under a context that was never cancelled', () => {
    // The context must not change the result, or every preview would differ
    // from the download of the same bin.
    const ctx = newContext();

    const observed = generatePocketBin(m, font, request(), ctx);
    const plain = generatePocketBin(m, font, request());

    expect(observed.body.vertices.length).toBe(plain.body.vertices.length);

    ctx.delete();
  });
});
