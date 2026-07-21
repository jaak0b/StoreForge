# Cavity Edit Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved spec docs/superpowers/specs/2026-07-21-cavity-edits-design.md: brush-based Add / Remove / Flatten cavity edit tools for cutout bins, with multi-step undo/redo, a confirmed clear-all, plan file persistence (version 9), and an incremental single-entry worker memo so appending one stroke does not redo the whole carve.

**Architecture:** A new `CavityEdit` discriminated union lives on `CutoutBin` in the plan model and is validated and defaulted (version 8 loads with `edits: []`) by the plan file module. A new framework-agnostic engine module `web/src/engine/cutout/cavityEdits.ts` turns strokes into capsule-chain solids (per-segment convex hull of two spheres), flatten clicks into cylinders, and folds them onto the carved body after the model carve and before the label stage inside `buildCutoutBinBody`; the worker passes edits through the existing `CutoutBinRequest` path and holds a single-entry edited-body memo keyed by carve recipe plus edit-list prefix. The UI adds a paint mode to `CutoutViewport.vue` (raycast brush cursor, main-thread ghost capsules, commit on pointer up) and a toolbar plus undo/redo/clear-all state in `stores/cutout.ts` and `CutoutTab.vue`.

**Tech Stack:** Vue 3 + TypeScript + Vuetify + Pinia (UI), manifold-3d WASM in the Comlink worker (CSG), three.js (viewport), Vitest (tests, engine level where possible).

## Global Constraints

- Never use the em-dash character anywhere, including in this plan, code comments, and UI text.
- Every branch on `CavityEdit['kind']` (and any other discriminated union) handles every member explicitly and ends in `assertNever`; no trailing `else` that absorbs future members.
- Engine modules (`web/src/engine/**`) never import Vue, Pinia, or touch the DOM; `ManifoldToplevel` is injected.
- All generated geometry is watertight: `status()` checked, genus asserted where meaningful; geometry constructions are established CSG operations (convex hull capsule, Minkowski-free), named as such.
- Errors the user can fix are returned or thrown as complete user-worded sentences; no silently swallowed catch.
- Per task: `npx vitest run <changed test files>` and `npm run build` green inside `web/` before commit.
- Commit message: a single short sentence, then the `Co-Authored-By: Claude <noreply@anthropic.com>` trailer. No other AI attribution.
- UI text is plain technical prose in complete sentences, 3D printing community terminology.
---

## Task 1: Data model and plan file version 9

**Files:**
- Modify: `web/src/engine/plan/types.ts` (CutoutBin at ~line 203, PlanFile at ~line 477, `PLAN_FILE_VERSION` at ~line 493)
- Modify: `web/src/engine/plan/planFile.ts` (cutout branch of `validateBin` ~line 693, `pickBin` ~line 723, version comment in `parsePlanFile` ~line 1398)
- Create: `web/src/engine/cutout/cavityEdits.ts` (radius bound constants only in this task; geometry follows in Task 2)
- Modify: `web/tests/plan/planFile.spec.ts`

**Interfaces:**
- Produces in `types.ts`:
  ```ts
  export interface Vec3Mm { xMm: number; yMm: number; zMm: number; }
  export type CavityEdit =
    | { kind: 'add'; points: Vec3Mm[]; radiusMm: number }
    | { kind: 'remove'; points: Vec3Mm[]; radiusMm: number }
    | { kind: 'flatten'; centerMm: Vec3Mm; radiusMm: number; planeZMm: number };
  export interface CutoutBin extends BinEnvelope {
    origin: 'cutout';
    models: CutoutModel[];
    /** Manual cavity edits, applied in list order after the model carve. */
    edits: CavityEdit[];
  }
  ```
- Produces in `cavityEdits.ts` (single home for the bounds; validator and UI both import them):
  ```ts
  export const CAVITY_EDIT_RADIUS_MIN_MM = 0.2;
  export const CAVITY_EDIT_RADIUS_MAX_MM = 50;
  ```
- Produces in `planFile.ts`:
  ```ts
  export function validateCavityEdits(raw: unknown, subject: string): string | null
  ```
- Consumes: `assertNever` from `types.ts`, `isFiniteNumber` (module local in planFile.ts).

**Steps:**

- [ ] Write failing tests in `web/tests/plan/planFile.spec.ts` (append to the existing file, following its existing `parsePlanFile`/`serializePlanFile` style):
  ```ts
  describe('cavity edits (plan version 9)', () => {
    function cutoutEntry(edits: unknown): Record<string, unknown> {
      return {
        id: 'e1',
        quantity: 1,
        createdAt: '2026-07-21T00:00:00.000Z',
        product: {
          kind: 'bin',
          labelSlot: true,
          bin: {
            origin: 'cutout',
            gridX: 2,
            gridY: 2,
            heightUnits: 4,
            magnetHoles: false,
            models: [],
            ...(edits === undefined ? {} : { edits }),
          },
        },
      };
    }
    function planText(edits: unknown, version = 9): string {
      return JSON.stringify({ version, entries: [cutoutEntry(edits)], batches: [] });
    }

    it('round-trips edits through serialize and parse', () => {
      const edits = [
        { kind: 'add', points: [{ xMm: 1, yMm: 2, zMm: 3 }], radiusMm: 2 },
        { kind: 'remove', points: [{ xMm: 0, yMm: 0, zMm: 5 }, { xMm: 4, yMm: 0, zMm: 5 }], radiusMm: 1.5 },
        { kind: 'flatten', centerMm: { xMm: 5, yMm: 5, zMm: 10 }, radiusMm: 6, planeZMm: 9 },
      ];
      const result = parsePlanFile(planText(edits));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bin = (result.plan.entries[0].product as { bin: { edits: unknown } }).bin;
      expect(bin.edits).toEqual(edits);
      const reparsed = parsePlanFile(
        serializePlanFile(result.plan.entries, result.plan.batches),
      );
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect((reparsed.plan.entries[0].product as { bin: { edits: unknown } }).bin.edits).toEqual(edits);
    });

    it('loads a version 8 cutout bin with no edits field as an empty edit list', () => {
      const result = parsePlanFile(planText(undefined, 8));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.plan.entries[0].product as { bin: { edits: unknown } }).bin.edits).toEqual([]);
      expect(result.plan.version).toBe(9);
    });

    it('rejects an edit with a radius outside 0.2 to 50 mm', () => {
      const result = parsePlanFile(
        planText([{ kind: 'add', points: [{ xMm: 0, yMm: 0, zMm: 0 }], radiusMm: 0.1 }]),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('brush radius');
    });

    it('rejects a stroke edit with no points', () => {
      const result = parsePlanFile(planText([{ kind: 'remove', points: [], radiusMm: 2 }]));
      expect(result.ok).toBe(false);
    });

    it('rejects an edit with a non-finite coordinate', () => {
      const result = parsePlanFile(
        planText([{ kind: 'flatten', centerMm: { xMm: 0, yMm: 0, zMm: null }, radiusMm: 2, planeZMm: 1 }]),
      );
      expect(result.ok).toBe(false);
    });

    it('merges an imported entry with edits over an existing one', () => {
      const a = parsePlanFile(planText([]));
      const b = parsePlanFile(
        planText([{ kind: 'add', points: [{ xMm: 1, yMm: 1, zMm: 1 }], radiusMm: 3 }]),
      );
      if (!a.ok || !b.ok) throw new Error('setup failed');
      const merged = mergeEntries(a.plan.entries, b.plan.entries);
      expect(merged).toHaveLength(1);
      expect((merged[0].product as { bin: { edits: unknown[] } }).bin.edits).toHaveLength(1);
    });
  });
  ```
- [ ] Run and confirm failure: from `web/`, `npx vitest run tests/plan/planFile.spec.ts -t "cavity edits"` (fails: version 9 rejected, edits dropped).
- [ ] Create `web/src/engine/cutout/cavityEdits.ts` with a module doc comment and only the two bound constants shown under Interfaces (Task 2 fills in the geometry).
- [ ] In `types.ts`: add `Vec3Mm` and `CavityEdit` (exactly as under Interfaces, each variant documented: coordinates are bin-local mm, the same frame as `ModelPlacement`), add `edits: CavityEdit[]` to `CutoutBin`, change `PlanFile.version` to `9` and `PLAN_FILE_VERSION` to `9`, and extend the version doc comment: version 9 is version 8 plus the cavity edit list on cutout bins; a version 8 file simply contains no edits.
- [ ] In `planFile.ts`: import `CAVITY_EDIT_RADIUS_MIN_MM`, `CAVITY_EDIT_RADIUS_MAX_MM` from `../cutout/cavityEdits` and `CavityEdit`, `Vec3Mm` types from `./types`; add:
  ```ts
  function isVec3Mm(value: unknown): value is Vec3Mm {
    const p = value as Record<string, unknown> | null;
    return (
      typeof p === 'object' &&
      p !== null &&
      isFiniteNumber(p.xMm) &&
      isFiniteNumber(p.yMm) &&
      isFiniteNumber(p.zMm)
    );
  }

  /**
   * Validates a raw value as a cutout bin's list of cavity edits. Absent is
   * valid: a plan written before version 9 has no edits at all.
   */
  export function validateCavityEdits(raw: unknown, subject: string): string | null {
    if (raw === undefined) return null;
    if (!Array.isArray(raw)) {
      return `${subject}: The cavity edits must be a list.`;
    }
    for (const rawEdit of raw) {
      if (typeof rawEdit !== 'object' || rawEdit === null || Array.isArray(rawEdit)) {
        return `${subject}: A cavity edit is not an object.`;
      }
      const edit = rawEdit as Record<string, unknown>;
      if (
        !isFiniteNumber(edit.radiusMm) ||
        edit.radiusMm < CAVITY_EDIT_RADIUS_MIN_MM ||
        edit.radiusMm > CAVITY_EDIT_RADIUS_MAX_MM
      ) {
        return (
          `${subject}: A cavity edit's brush radius must be a number from ` +
          `${CAVITY_EDIT_RADIUS_MIN_MM} to ${CAVITY_EDIT_RADIUS_MAX_MM} mm.`
        );
      }
      if (edit.kind === 'add' || edit.kind === 'remove') {
        if (!Array.isArray(edit.points) || edit.points.length === 0 || !edit.points.every(isVec3Mm)) {
          return `${subject}: A brush stroke edit needs at least one point with finite x, y and z in mm.`;
        }
        continue;
      }
      if (edit.kind === 'flatten') {
        if (!isVec3Mm(edit.centerMm)) {
          return `${subject}: A flatten edit needs a centre with finite x, y and z in mm.`;
        }
        if (!isFiniteNumber(edit.planeZMm)) {
          return `${subject}: A flatten edit needs a finite plane height in mm.`;
        }
        continue;
      }
      return `${subject}: A cavity edit's kind must be add, remove or flatten.`;
    }
    return null;
  }
  ```
  (The kind check is on raw untyped data, so the closed set is enforced by the explicit final return rather than `assertNever`; `assertNever` binds on the typed union in Task 2.)
- [ ] In `validateBin`, cutout branch (~line 693): after `validateCutoutModels`, return `validateCavityEdits(bin.edits, subject)` when the models validate:
  ```ts
  const modelsProblem = validateCutoutModels(bin.models, subject, bin.gridX, bin.gridY);
  if (modelsProblem !== null) return modelsProblem;
  return validateCavityEdits(bin.edits, subject);
  ```
- [ ] Add a picker beside `pickCutoutModels` that copies only known fields (spread nothing from raw), and wire it into `pickBin`'s cutout branch:
  ```ts
  /** Copies only the known CavityEdit fields; absent (pre-version-9) means none. */
  export function pickCavityEdits(raw: Record<string, unknown>): CavityEdit[] {
    if (!Array.isArray(raw.edits)) return [];
    return (raw.edits as Record<string, unknown>[]).map((edit): CavityEdit => {
      const copyPoint = (p: Vec3Mm): Vec3Mm => ({ xMm: p.xMm, yMm: p.yMm, zMm: p.zMm });
      if (edit.kind === 'flatten') {
        return {
          kind: 'flatten',
          centerMm: copyPoint(edit.centerMm as Vec3Mm),
          radiusMm: edit.radiusMm as number,
          planeZMm: edit.planeZMm as number,
        };
      }
      return {
        kind: edit.kind as 'add' | 'remove',
        points: (edit.points as Vec3Mm[]).map(copyPoint),
        radiusMm: edit.radiusMm as number,
      };
    });
  }
  ```
  ```ts
  if (raw.origin === 'cutout') {
    return { ...envelope, origin: 'cutout', models: pickCutoutModels(raw), edits: pickCavityEdits(raw) };
  }
  ```
- [ ] Update the version walkthrough comment in `parsePlanFile` (~line 1398): version 9 adds the cavity edit list on cutout bins, absent in earlier versions and defaulted to an empty list on pick.
- [ ] Fix any compile fallout from `CutoutBin` gaining a required field: `CutoutTab.vue` `designedProduct()` (~line 832) does not compile until Task 6 adds `edits`; for now add `edits: []` there with a `// Filled by the cavity edit tools task.` note, and search for other `origin: 'cutout'` literals (`web/src/stores/binQueue.ts`, tests) and add `edits: []` where a `CutoutBin` is constructed.
- [ ] Run to pass: `npx vitest run tests/plan/planFile.spec.ts` then the full `npx vitest run` and `npm run build`.
- [ ] Commit:
  ```
  git add -A && git commit -m "Add cavity edits to the plan model as file version 9.

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

## Task 2: Engine module cavityEdits.ts (stroke solids, flatten solids, fold)

**Files:**
- Modify: `web/src/engine/cutout/cavityEdits.ts` (created in Task 1)
- Create: `web/tests/cutout/cavityEdits.spec.ts`

**Interfaces:**
- Consumes: `ManifoldToplevel`, `Manifold` from `manifold-3d`; `circleSegments(radiusMm, toleranceMm)` from `../geometry/circleSegments`; `sweptReachZ(heightUnits)` and `simplifyToleranceMm(clearanceMm)` conventions from `./cutoutBin`; `CavityEdit`, `Vec3Mm`, `assertNever` from `../plan/types`.
- Produces (exact signatures; Tasks 3 to 6 use these names verbatim):
  ```ts
  export const CAVITY_EDIT_RADIUS_MIN_MM = 0.2;
  export const CAVITY_EDIT_RADIUS_MAX_MM = 50;
  export function strokeToleranceMm(radiusMm: number): number; // radiusMm / 4
  export function simplifyStroke(points: Vec3Mm[], toleranceMm: number): Vec3Mm[];
  export function strokeSolid(m: ManifoldToplevel, points: Vec3Mm[], radiusMm: number): Manifold;
  export function flattenSolid(
    m: ManifoldToplevel,
    edit: { centerMm: Vec3Mm; radiusMm: number; planeZMm: number },
    binTopZMm: number,
  ): Manifold;
  export function applyCavityEdits(
    m: ManifoldToplevel,
    body: Manifold,           // ownership taken; a new body is returned
    binSolid: Manifold,       // borrowed: the un-carved solid bin body, for the add clamp
    edits: CavityEdit[],
    binTopZMm: number,
  ): Manifold;
  export function cavityEditsKey(edits: CavityEdit[]): string; // deterministic JSON of the list
  ```
- Error contract of `applyCavityEdits`: throws `new Error('The cavity edits removed the entire bin, so the last edit was not applied.')` when the result is empty, and `new Error(\`Applying the cavity edits produced an invalid solid (${status}).\`)` when status is not `'NoError'`. Both are user-worded per rule 2.

**Design notes (bindings to established constructions, rule 1 and rule 12):**
- Capsule: the convex hull of two spheres of equal radius is exactly the capsule over their segment (standard CSG construction, Manifold convex hull). Per consecutive point pair, then a single union of all segment capsules; a single point is one sphere.
- Sphere resolution: `circleSegments(radiusMm, strokeToleranceMm(radiusMm))`, the same sagitta-bound facet derivation the clearance offset sphere uses in `prepareCutoutModel` (quarter rule), so no new constant enters.
- Polyline simplification: Douglas-Peucker in 3D (point-to-segment distance), tolerance `radiusMm / 4`, applied inside `strokeSolid` before hulling; named as Douglas-Peucker in the doc comment.
- Flatten: `m.Manifold.cylinder(binTopZMm - planeZMm, radiusMm, radiusMm, circleSegments(radiusMm, strokeToleranceMm(radiusMm)))` translated to `(centerMm.xMm, centerMm.yMm, planeZMm)`; `binTopZMm` is `sweptReachZ(heightUnits)` supplied by the caller so the cylinder provably clears the lip crest (Task 3), reusing the existing derivation rather than a new figure.
- Fold order in `applyCavityEdits`: for each edit in list order, switch on `edit.kind` ending in `assertNever(edit)`; `add` unions `strokeSolid(...).intersect(binSolid)` into the body (envelope clamp), `remove` subtracts `strokeSolid`, `flatten` subtracts `flattenSolid`. Intermediate solids deleted as the existing `advance` pattern in `prepareCutoutModel` does; status and emptiness checked once on the final body.

**Steps:**

- [ ] Write failing tests in `web/tests/cutout/cavityEdits.spec.ts`:
  ```ts
  import { beforeAll, describe, expect, it } from 'vitest';
  import type { Manifold, ManifoldToplevel } from 'manifold-3d';
  import { loadManifold } from '../helpers/manifold';
  import {
    applyCavityEdits,
    cavityEditsKey,
    simplifyStroke,
    strokeSolid,
    flattenSolid,
  } from '../../src/engine/cutout/cavityEdits';
  import type { CavityEdit, Vec3Mm } from '../../src/engine/plan/types';

  let m: ManifoldToplevel;
  beforeAll(async () => {
    m = await loadManifold();
  });

  const p = (xMm: number, yMm: number, zMm: number): Vec3Mm => ({ xMm, yMm, zMm });

  /** A 40 x 40 x 20 mm box standing on the bed, a stand-in bin envelope. */
  function box(): Manifold {
    return m.Manifold.cube([40, 40, 20], false);
  }

  describe('strokeSolid', () => {
    it('builds a watertight connected capsule chain from a multi-segment stroke', () => {
      const solid = strokeSolid(m, [p(5, 5, 5), p(20, 5, 5), p(20, 20, 5), p(30, 20, 12)], 2);
      expect(solid.status()).toBe('NoError');
      expect(solid.numTri()).toBeGreaterThan(0);
      expect(solid.decompose()).toHaveLength(1);
      expect(solid.genus()).toBe(0);
      solid.delete();
    });

    it('builds a single sphere from a single point', () => {
      const solid = strokeSolid(m, [p(0, 0, 0)], 3);
      const sphereVolume = (4 / 3) * Math.PI * 27;
      // A faceted sphere is inscribed in the true sphere, so under but near.
      expect(solid.volume()).toBeGreaterThan(sphereVolume * 0.9);
      expect(solid.volume()).toBeLessThanOrEqual(sphereVolume);
      solid.delete();
    });
  });

  describe('simplifyStroke', () => {
    it('collapses collinear points and keeps genuine corners', () => {
      const stroke = [p(0, 0, 0), p(1, 0.01, 0), p(2, 0, 0), p(3, -0.01, 0), p(4, 0, 0), p(4, 5, 0)];
      const simplified = simplifyStroke(stroke, 0.5);
      expect(simplified[0]).toEqual(stroke[0]);
      expect(simplified[simplified.length - 1]).toEqual(stroke[stroke.length - 1]);
      expect(simplified.length).toBeLessThan(stroke.length);
      expect(simplified).toContainEqual(p(4, 0, 0));
    });
  });

  describe('applyCavityEdits', () => {
    function carvedBody(): Manifold {
      // The box with a pocket already carved, standing in for a carved bin.
      const envelope = box();
      const pocket = m.Manifold.cube([10, 10, 10], false).translate([15, 15, 10]);
      const body = envelope.subtract(pocket);
      envelope.delete();
      pocket.delete();
      return body;
    }

    it('add increases volume but never past the un-carved envelope', () => {
      const binSolid = box();
      const before = carvedBody();
      const beforeVolume = before.volume();
      const edits: CavityEdit[] = [
        { kind: 'add', points: [p(20, 20, 15), p(20, 20, 25)], radiusMm: 4 },
      ];
      const after = applyCavityEdits(m, before, binSolid, edits, 20);
      expect(after.status()).toBe('NoError');
      expect(after.volume()).toBeGreaterThan(beforeVolume);
      expect(after.volume()).toBeLessThanOrEqual(binSolid.volume());
      after.delete();
      binSolid.delete();
    });

    it('remove decreases volume', () => {
      const binSolid = box();
      const before = carvedBody();
      const beforeVolume = before.volume();
      const after = applyCavityEdits(m, before, binSolid, [
        { kind: 'remove', points: [p(5, 5, 18), p(35, 5, 18)], radiusMm: 3 },
      ], 20);
      expect(after.volume()).toBeLessThan(beforeVolume);
      after.delete();
      binSolid.delete();
    });

    it('flatten leaves no material above the plane inside the brush circle', () => {
      const binSolid = box();
      const before = carvedBody();
      const after = applyCavityEdits(m, before, binSolid, [
        { kind: 'flatten', centerMm: p(10, 10, 15), radiusMm: 5, planeZMm: 12 },
      ], 20);
      // Probe: intersect the result with the flatten cylinder region above the plane.
      const probe = flattenSolid(m, { centerMm: p(10, 10, 15), radiusMm: 5, planeZMm: 12 }, 20);
      const above = after.intersect(probe);
      expect(above.isEmpty()).toBe(true);
      above.delete();
      probe.delete();
      after.delete();
      binSolid.delete();
    });

    it('is order dependent for an overlapping add and remove pair', () => {
      const binSolid = box();
      const add: CavityEdit = { kind: 'add', points: [p(18, 18, 14)], radiusMm: 5 };
      const remove: CavityEdit = { kind: 'remove', points: [p(20, 20, 14)], radiusMm: 5 };
      const a = applyCavityEdits(m, carvedBody(), binSolid, [add, remove], 20);
      const b = applyCavityEdits(m, carvedBody(), binSolid, [remove, add], 20);
      expect(Math.abs(a.volume() - b.volume())).toBeGreaterThan(1);
      a.delete();
      b.delete();
      binSolid.delete();
    });

    it('rejects an edit that empties the body with a user-worded message', () => {
      const binSolid = box();
      const before = box();
      expect(() =>
        applyCavityEdits(m, before, binSolid, [
          { kind: 'remove', points: [p(20, 20, 10)], radiusMm: 50 },
        ], 20),
      ).toThrow(/entire bin/);
      binSolid.delete();
    });
  });

  describe('cavityEditsKey', () => {
    it('is stable for equal lists and differs on any change', () => {
      const edits: CavityEdit[] = [{ kind: 'add', points: [p(1, 2, 3)], radiusMm: 2 }];
      expect(cavityEditsKey(edits)).toBe(cavityEditsKey([{ kind: 'add', points: [p(1, 2, 3)], radiusMm: 2 }]));
      expect(cavityEditsKey(edits)).not.toBe(cavityEditsKey([{ kind: 'remove', points: [p(1, 2, 3)], radiusMm: 2 }]));
      expect(cavityEditsKey([])).toBe(cavityEditsKey([]));
    });
  });
  ```
- [ ] Run and confirm failure: `npx vitest run tests/cutout/cavityEdits.spec.ts` (fails: exports missing).
- [ ] Implement `web/src/engine/cutout/cavityEdits.ts` in full:
  ```ts
  // Manual cavity edits for cutout bins: brush strokes and flatten clicks,
  // stored on the plan (plan/types CavityEdit) and folded onto the carved body
  // after the model carve and before the label stage. Framework-agnostic; the
  // ManifoldToplevel is injected as everywhere else in the engine.
  import type { Manifold, ManifoldToplevel } from 'manifold-3d';
  import { circleSegments } from '../geometry/circleSegments';
  import { assertNever, type CavityEdit, type Vec3Mm } from '../plan/types';

  /** The brush radius bounds the plan validator and the radius field enforce. */
  export const CAVITY_EDIT_RADIUS_MIN_MM = 0.2;
  export const CAVITY_EDIT_RADIUS_MAX_MM = 50;

  /**
   * The geometric error budget one stroke may spend, in mm: a quarter of its
   * own brush radius, the same quarter rule the clearance offset pipeline
   * spends (simplifyToleranceMm in cutoutBin.ts). Spent twice coherently: the
   * Douglas-Peucker simplification of the polyline and the sphere faceting
   * both stay within it, so the painted shape is faithful to brush fidelity.
   */
  export function strokeToleranceMm(radiusMm: number): number {
    return radiusMm / 4;
  }

  function pointSegmentDistanceMm(point: Vec3Mm, a: Vec3Mm, b: Vec3Mm): number {
    const abx = b.xMm - a.xMm;
    const aby = b.yMm - a.yMm;
    const abz = b.zMm - a.zMm;
    const apx = point.xMm - a.xMm;
    const apy = point.yMm - a.yMm;
    const apz = point.zMm - a.zMm;
    const lengthSq = abx * abx + aby * aby + abz * abz;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / lengthSq));
    const dx = apx - t * abx;
    const dy = apy - t * aby;
    const dz = apz - t * abz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Douglas-Peucker polyline simplification in 3D: keep the point farthest
   * from the chord when it exceeds the tolerance, recurse on both halves.
   * The standard algorithm, applied to bound solid cost on long mouse paths
   * without changing the painted shape beyond the stroke's error budget.
   */
  export function simplifyStroke(points: Vec3Mm[], toleranceMm: number): Vec3Mm[] {
    if (points.length <= 2) return points.slice();
    let farthestIndex = 0;
    let farthestDistance = 0;
    const first = points[0];
    const last = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i += 1) {
      const distance = pointSegmentDistanceMm(points[i], first, last);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = i;
      }
    }
    if (farthestDistance <= toleranceMm) return [first, last];
    const head = simplifyStroke(points.slice(0, farthestIndex + 1), toleranceMm);
    const tail = simplifyStroke(points.slice(farthestIndex), toleranceMm);
    return head.slice(0, -1).concat(tail);
  }

  function sphereAt(m: ManifoldToplevel, point: Vec3Mm, radiusMm: number, segments: number): Manifold {
    return m.Manifold.sphere(radiusMm, segments).translate([point.xMm, point.yMm, point.zMm]);
  }

  /**
   * The solid one brush stroke paints: per consecutive point pair, the convex
   * hull of two spheres, which is exactly the capsule over that segment (a
   * standard CSG construction); the segment capsules are unioned into one
   * solid. A single point is one sphere. The sphere faceting follows the same
   * sagitta-bound derivation the clearance offset sphere uses (circleSegments
   * against the quarter-rule budget), so no new constant enters.
   */
  export function strokeSolid(m: ManifoldToplevel, points: Vec3Mm[], radiusMm: number): Manifold {
    if (points.length === 0) {
      throw new Error('A brush stroke needs at least one point.');
    }
    const toleranceMm = strokeToleranceMm(radiusMm);
    const segments = circleSegments(radiusMm, toleranceMm);
    const simplified = simplifyStroke(points, toleranceMm);
    if (simplified.length === 1) {
      return sphereAt(m, simplified[0], radiusMm, segments);
    }
    const capsules: Manifold[] = [];
    for (let i = 0; i < simplified.length - 1; i += 1) {
      const a = sphereAt(m, simplified[i], radiusMm, segments);
      const b = sphereAt(m, simplified[i + 1], radiusMm, segments);
      capsules.push(m.Manifold.hull([a, b]));
      a.delete();
      b.delete();
    }
    const union = m.Manifold.union(capsules);
    for (const capsule of capsules) capsule.delete();
    return union;
  }

  /**
   * The solid one flatten click shaves away: a cylinder of the brush radius,
   * standing on the picked plane and reaching binTopZMm, the same figure the
   * swept pockets reach (sweptReachZ), so the cut provably opens through the
   * lip rather than leaving a roof over the flattened region.
   */
  export function flattenSolid(
    m: ManifoldToplevel,
    edit: { centerMm: Vec3Mm; radiusMm: number; planeZMm: number },
    binTopZMm: number,
  ): Manifold {
    const heightMm = binTopZMm - edit.planeZMm;
    if (!(heightMm > 0)) {
      throw new Error('The flatten height must lie below the top of the bin.');
    }
    return m.Manifold.cylinder(
      heightMm,
      edit.radiusMm,
      edit.radiusMm,
      circleSegments(edit.radiusMm, strokeToleranceMm(edit.radiusMm)),
    ).translate([edit.centerMm.xMm, edit.centerMm.yMm, edit.planeZMm]);
  }

  /**
   * Folds the edits onto the carved body in list order. Remove and flatten
   * subtract their solid; add unions the stroke solid intersected with the
   * un-carved solid bin body, so Add can only restore material the bin
   * originally had and never grows material outside the bin envelope.
   * Takes ownership of body; binSolid is borrowed. The final body is status
   * checked, and an edit list that empties the bin is a user-worded error.
   */
  export function applyCavityEdits(
    m: ManifoldToplevel,
    body: Manifold,
    binSolid: Manifold,
    edits: CavityEdit[],
    binTopZMm: number,
  ): Manifold {
    let current: Manifold = body;
    const advance = (next: Manifold): void => {
      current.delete();
      current = next;
    };
    try {
      for (const edit of edits) {
        switch (edit.kind) {
          case 'add': {
            const stroke = strokeSolid(m, edit.points, edit.radiusMm);
            const clamped = stroke.intersect(binSolid);
            stroke.delete();
            advance(current.add(clamped));
            clamped.delete();
            break;
          }
          case 'remove': {
            const stroke = strokeSolid(m, edit.points, edit.radiusMm);
            advance(current.subtract(stroke));
            stroke.delete();
            break;
          }
          case 'flatten': {
            const cylinder = flattenSolid(m, edit, binTopZMm);
            advance(current.subtract(cylinder));
            cylinder.delete();
            break;
          }
          default:
            assertNever(edit);
        }
      }
      if (current.isEmpty()) {
        throw new Error('The cavity edits removed the entire bin, so the last edit was not applied.');
      }
      const status = current.status();
      if (status !== 'NoError') {
        throw new Error(`Applying the cavity edits produced an invalid solid (${status}).`);
      }
      const result = current;
      current = null as unknown as Manifold;
      return result;
    } finally {
      // On a throw the working solid is released; on success it was handed out.
      (current as Manifold | null)?.delete();
    }
  }

  /**
   * Deterministic identity of an edit list, for the worker's edited-body memo:
   * plain JSON of the plain-data edits, which is deterministic because every
   * edit is built with its fields in the fixed literal order above.
   */
  export function cavityEditsKey(edits: CavityEdit[]): string {
    return JSON.stringify(edits);
  }
  ```
- [ ] Run to pass: `npx vitest run tests/cutout/cavityEdits.spec.ts`, then `npm run build`.
- [ ] Commit:
  ```
  git add -A && git commit -m "Add the cavity edit engine module with capsule strokes and flatten cylinders.

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

## Task 3: Wire edits into the cutout carve and the worker, with a single-entry prefix memo

**Files:**
- Modify: `web/src/engine/cutout/cutoutBin.ts` (`CutoutBinParams` ~line 165, `buildCutoutBinBody` ~line 844)
- Modify: `web/src/worker/cutoutModels.ts` (`CutoutBinRequest` ~line 70; new memo class and recipe key at the end)
- Modify: `web/src/worker/geometry.worker.ts` (`withCutoutCarve` ~line 151)
- Modify: `web/src/workerClient.ts` (no signature change needed; verify `CutoutBinRequest` re-export carries `edits`)
- Modify: `web/tests/cutout/cutoutBin.spec.ts` (or append a new `describe`), `web/tests/worker/cutoutModels.spec.ts`

**Interfaces:**
- In `cutoutBin.ts`, `CutoutBinParams` gains:
  ```ts
  /** Manual cavity edits applied after the model carve, before the label stage. Absent means none. */
  edits?: CavityEdit[];
  /**
   * Memo for the edited body, supplied by the worker so appending one edit to
   * an unchanged carve reuses the previous edited body. Absent for direct
   * callers, which fold every edit; the result is identical by construction.
   */
  editedMemo?: CavityEditedBodyMemo;
  /** Identity of the carve the edits apply to, required when editedMemo is set. */
  editedRecipeKey?: string;
  ```
- In `cavityEdits.ts` (Task 3 adds these beside Task 2's exports):
  ```ts
  export interface CavityEditedBodyMemo {
    /** The memoized edited body under this key, borrowed, or null. */
    get(key: string): Manifold | null;
    /** Stores the edited body under this key, taking ownership of the given handle. */
    put(key: string, body: Manifold): void;
  }
  export function cavityEditPrefixKey(recipeKey: string, edits: CavityEdit[], count: number): string;
  export function applyCavityEditsMemoized(
    m: ManifoldToplevel,
    body: Manifold,                 // ownership taken
    makeBinSolid: () => Manifold,   // called at most once; result owned here
    edits: CavityEdit[],
    binTopZMm: number,
    memo?: { store: CavityEditedBodyMemo; recipeKey: string },
  ): Manifold;
  ```
  `applyCavityEditsMemoized` semantics: with a memo, it first asks for the prefix key of `edits.length - 1`; on a hit it starts from a retained handle of the memoized body (`hit.translate([0, 0, 0])`, a new handle over the shared lazy CSG node, so the cache entry stays valid) and folds only the last edit; on a miss it folds all edits from the fresh carve body. Either way it stores the final body under the full-list prefix key as a retained handle (`result.translate([0, 0, 0])`), so the next append hits. Undo, reorder, radius change, or any carve recipe change misses and rebuilds fully, which is the spec's single-entry contract. `add` clamping needs the envelope, so `makeBinSolid` is invoked lazily only when a folded edit has kind `add`, and its result is deleted before returning.
- In `cutoutModels.ts`:
  ```ts
  export interface CutoutBinRequest extends SlottedBinParams {
    models: CutoutModelRequest[];
    /** Manual cavity edits, in application order. Empty means none. */
    edits: CavityEdit[];
  }
  /** Deterministic identity of a carve recipe without its edits, for the edited-body memo. */
  export function cutoutCarveRecipeKey(request: CutoutBinRequest): string;
  export class CavityEditedBodyCache implements CavityEditedBodyMemo {
    get(key: string): Manifold | null;
    put(key: string, body: Manifold): void; // single entry: deletes the superseded body
    clear(): void;
    get size(): number;
  }
  ```
  `cutoutCarveRecipeKey` is `JSON.stringify` over the request's bin fields plus, per model, `cutoutModelKey(modelSourceId, unitScale, clearanceMm)`, the placement, `sweepEnabled` and `draftAngleDeg`; edits excluded by construction. Lifetime note for the doc comment: the memoized body is only ever borrowed and replaced inside the synchronous eager carve (get, fold, put with no await between), so unlike the model and swept caches it needs no PinRegistry; a `clear()` is called from `releaseCutoutModels` so a plan mutation cannot strand a body derived from released solids.

**Steps:**

- [ ] Write failing engine-level test appended to `web/tests/cutout/cutoutBin.spec.ts` (reuse the file's existing `prism()` helper and `CutoutBinParams` construction; copy the params literal style from an existing test in that file):
  ```ts
  describe('cavity edits in the cutout carve', () => {
    it('a remove edit changes the generated body and keeps it watertight', () => {
      const params = baseParams(); // the file's existing params helper or literal
      const withoutEdits = buildCutoutBinBody(m, params);
      const withEdits = buildCutoutBinBody(m, {
        ...params,
        edits: [
          { kind: 'remove', points: [{ xMm: 10, yMm: 10, zMm: 10 }], radiusMm: 4 },
        ],
      });
      expect(withEdits.body.status()).toBe('NoError');
      expect(withEdits.body.volume()).toBeLessThan(withoutEdits.body.volume());
      withoutEdits.body.delete();
      withEdits.body.delete();
    });
  });
  ```
- [ ] Write failing memo unit test appended to `web/tests/worker/cutoutModels.spec.ts` (this file tests the caches without WASM where possible; the memo test needs a Manifold, so follow the pattern of any test there that loads it, or use `loadManifold` directly):
  ```ts
  describe('CavityEditedBodyCache and applyCavityEditsMemoized', () => {
    it('appending one edit reuses the memoized body; any other prefix rebuilds', async () => {
      const m = await loadManifold();
      const cache = new CavityEditedBodyCache();
      const recipeKey = 'recipe';
      const binTopZMm = 20;
      const freshBody = () => m.Manifold.cube([40, 40, 20], false);
      let binSolidBuilds = 0;
      const makeBinSolid = () => {
        binSolidBuilds += 1;
        return m.Manifold.cube([40, 40, 20], false);
      };
      const e1: CavityEdit = { kind: 'remove', points: [{ xMm: 5, yMm: 5, zMm: 18 }], radiusMm: 3 };
      const e2: CavityEdit = { kind: 'remove', points: [{ xMm: 30, yMm: 30, zMm: 18 }], radiusMm: 3 };
      const first = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1], binTopZMm, {
        store: cache, recipeKey,
      });
      expect(cache.size).toBe(1);
      const second = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1, e2], binTopZMm, {
        store: cache, recipeKey,
      });
      // The appended-edit path never rebuilds e1, so its result equals the full fold.
      const full = applyCavityEdits(m, freshBody(), makeBinSolid(), [e1, e2], binTopZMm);
      expect(Math.abs(second.volume() - full.volume())).toBeLessThan(1e-6);
      // An undo (shorter list) is a full rebuild, not a crash and not a stale hit.
      const undone = applyCavityEditsMemoized(m, freshBody(), makeBinSolid, [e1], binTopZMm, {
        store: cache, recipeKey,
      });
      expect(Math.abs(undone.volume() - first.volume())).toBeLessThan(1e-6);
      first.delete(); second.delete(); full.delete(); undone.delete();
      cache.clear();
      expect(binSolidBuilds).toBeGreaterThan(0);
    });
  });
  ```
- [ ] Run and confirm failure: `npx vitest run tests/cutout/cutoutBin.spec.ts -t "cavity edits"` and `npx vitest run tests/worker/cutoutModels.spec.ts -t "CavityEditedBodyCache"`.
- [ ] Implement `CavityEditedBodyMemo`, `cavityEditPrefixKey` (`` `${recipeKey}|${count}|${cavityEditsKey(edits.slice(0, count))}` ``), and `applyCavityEditsMemoized` in `cavityEdits.ts` per the Interfaces block. Internally `applyCavityEditsMemoized` shares the fold with `applyCavityEdits` by extracting the per-edit fold step into a private function both call, so the two paths cannot drift (rule 10); the empty/status checks stay in one place.
- [ ] In `cutoutBin.ts`: extend `CutoutBinParams` per Interfaces; in `buildCutoutBinBody`, after `buildCarvedBinBody` returns and before the `return`:
  ```ts
  let body = buildCarvedBinBody(m, params, placed.map(({ cutter }) => cutter), 'Cutout bin', ctx);
  const edits = params.edits ?? [];
  if (edits.length > 0) {
    const binTopZMm = sweptReachZ(params.heightUnits);
    // The un-carved solid bin body: the same carve stage with no cutters, so
    // the Add clamp envelope is derived where the carve already derives it.
    const makeBinSolid = (): Manifold =>
      buildCarvedBinBody(m, { ...params, edits: undefined }, [], 'Cutout bin');
    body =
      params.editedMemo !== undefined && params.editedRecipeKey !== undefined
        ? applyCavityEditsMemoized(m, body, makeBinSolid, edits, binTopZMm, {
            store: params.editedMemo,
            recipeKey: params.editedRecipeKey,
          })
        : applyCavityEditsMemoized(m, body, makeBinSolid, edits, binTopZMm);
  }
  return { body, warnings, footprints };
  ```
  (Label stage untouched: `generateCutoutBin` and `generateCutoutBinUnion` already build the label from the returned body, so edits land after the carve and before the label by construction.)
- [ ] In `cutoutModels.ts`: add `edits: CavityEdit[]` to `CutoutBinRequest`, implement `cutoutCarveRecipeKey` and `CavityEditedBodyCache` per Interfaces.
- [ ] In `geometry.worker.ts`: instantiate one module-level `const cavityEdited = new CavityEditedBodyCache();` beside the other caches; in `withCutoutCarve`, pass into the params it builds: `edits: request.edits`, `editedMemo: cavityEdited`, `editedRecipeKey: cutoutCarveRecipeKey(request)`; in `releaseCutoutModels`, call `cavityEdited.clear()` after the swept retention.
- [ ] In `workerClient.ts`: nothing structural; confirm `CutoutBinRequest` re-export compiles with the new field and that all three `generateCutoutBin*` wrappers pass the request through unchanged.
- [ ] Fix compile fallout: every place a `CutoutBinRequest` literal is built (`CutoutTab.vue` `carveRequest` ~line 150, download flows, tests) gains `edits: []` for now; Task 4 and 6 wire real values.
- [ ] Run to pass: the two test files above, then full `npx vitest run` and `npm run build`.
- [ ] Commit:
  ```
  git add -A && git commit -m "Fold cavity edits into the cutout carve with a single-entry prefix memo.

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

## Task 4: Store state, undo/redo, and persistence through the queue

**Files:**
- Modify: `web/src/stores/cutout.ts`
- Modify: `web/src/components/cutout/CutoutTab.vue` (only the plan-data plumbing: `designedProduct` ~line 831, the entry-load path, `carveRequest` ~line 150; toolbar UI is Task 6)
- Create: `web/tests/stores/cutout.spec.ts` (store tests exist: follow `web/tests/stores/toolTrace.spec.ts` for Pinia setup with `createPinia`/`setActivePinia`)

**Interfaces:**
- `stores/cutout.ts` state gains (plan data vs editor state split preserved):
  ```ts
  /** Manual cavity edits, in application order. Plan data. */
  edits: [] as CavityEdit[],
  /** Edits undone and available for redo. Editor state, never saved. */
  redoStack: [] as CavityEdit[],
  /** The active paint tool, or null when the gizmo owns the pointer. Editor state. */
  activeTool: null as CavityTool | null,
  /** Brush radius in mm for the next stroke. Editor state. */
  brushRadiusMm: 3,
  ```
  with `export type CavityTool = 'add' | 'remove' | 'flatten';` and actions:
  ```ts
  setActiveTool(tool: CavityTool | null): void   // toggling the active tool off passes null
  setBrushRadius(radiusMm: number): void         // clamped to the CAVITY_EDIT_RADIUS bounds
  appendEdit(edit: CavityEdit): void             // pushes and clears redoStack
  rollbackEdit(): void                            // pops the last edit WITHOUT pushing redo (rejected carve)
  undoEdit(): void                                // pops onto redoStack
  redoEdit(): void                                // pops redoStack back onto edits
  clearEdits(): void                              // empties edits and redoStack
  setEdits(edits: CavityEdit[]): void            // load path; deep copies, clears redoStack
  ```
  `reset()` additionally clears all four new fields (brush radius back to 3).
- `CutoutTab.vue`: `designedProduct()` bin literal gains `edits: cutout.edits.map(cloneEdit)`; the entry-load path (the function that populates the store from a `CutoutBin`, found by searching for `trackLoadedModel` in the file) calls `cutout.setEdits(bin.edits)`; `carveRequest` gains `edits: cutout.edits.map(cloneEdit)` where `cloneEdit` deep copies one `CavityEdit` (switch on `kind` ending in `assertNever`, so a new variant fails to compile here too), because Vue's reactive proxies do not survive the worker's structured clone (same reason the model records are copied there today).

**Steps:**

- [ ] Write failing tests in `web/tests/stores/cutout.spec.ts`:
  ```ts
  import { beforeEach, describe, expect, it } from 'vitest';
  import { createPinia, setActivePinia } from 'pinia';
  import { useCutout } from '../../src/stores/cutout';
  import type { CavityEdit } from '../../src/engine/plan/types';

  const stroke = (x: number): CavityEdit => ({
    kind: 'remove',
    points: [{ xMm: x, yMm: 0, zMm: 5 }],
    radiusMm: 3,
  });

  describe('cavity edit state', () => {
    beforeEach(() => setActivePinia(createPinia()));

    it('appendEdit clears the redo stack', () => {
      const store = useCutout();
      store.appendEdit(stroke(1));
      store.undoEdit();
      expect(store.redoStack).toHaveLength(1);
      store.appendEdit(stroke(2));
      expect(store.redoStack).toHaveLength(0);
      expect(store.edits).toHaveLength(1);
    });

    it('undo and redo walk the list one step at a time', () => {
      const store = useCutout();
      store.appendEdit(stroke(1));
      store.appendEdit(stroke(2));
      store.undoEdit();
      expect(store.edits).toHaveLength(1);
      store.redoEdit();
      expect(store.edits).toHaveLength(2);
      expect(store.edits[1]).toEqual(stroke(2));
    });

    it('undo on empty and redo on empty do nothing', () => {
      const store = useCutout();
      store.undoEdit();
      store.redoEdit();
      expect(store.edits).toHaveLength(0);
      expect(store.redoStack).toHaveLength(0);
    });

    it('rollbackEdit drops the last edit without making it redoable', () => {
      const store = useCutout();
      store.appendEdit(stroke(1));
      store.rollbackEdit();
      expect(store.edits).toHaveLength(0);
      expect(store.redoStack).toHaveLength(0);
    });

    it('clearEdits empties both the list and the redo stack', () => {
      const store = useCutout();
      store.appendEdit(stroke(1));
      store.undoEdit();
      store.appendEdit(stroke(2));
      store.clearEdits();
      expect(store.edits).toHaveLength(0);
      expect(store.redoStack).toHaveLength(0);
    });

    it('setBrushRadius clamps to the shared bounds', () => {
      const store = useCutout();
      store.setBrushRadius(0.05);
      expect(store.brushRadiusMm).toBe(0.2);
      store.setBrushRadius(500);
      expect(store.brushRadiusMm).toBe(50);
    });

    it('reset clears edits, redo, tool and radius', () => {
      const store = useCutout();
      store.appendEdit(stroke(1));
      store.setActiveTool('add');
      store.setBrushRadius(7);
      store.reset();
      expect(store.edits).toHaveLength(0);
      expect(store.redoStack).toHaveLength(0);
      expect(store.activeTool).toBeNull();
      expect(store.brushRadiusMm).toBe(3);
    });
  });
  ```
- [ ] Run and confirm failure: `npx vitest run tests/stores/cutout.spec.ts`.
- [ ] Implement the state, type and actions in `stores/cutout.ts` per Interfaces (import the radius bounds from `../engine/cutout/cavityEdits`; deep copy in `appendEdit`/`setEdits` with the same `cloneEdit` switch-plus-`assertNever` shape, defined once in the store and exported for the tab to reuse, so the copy logic has one home).
- [ ] In `CutoutTab.vue`: replace the Task 1/3 `edits: []` placeholders: `designedProduct()` uses `edits: cutout.edits.map(cloneEdit)`; `carveRequest` uses the same; the entry-load path calls `cutout.setEdits(bin.edits)`. Persistence needs no further work: `designedProduct` feeds the queue store, which serializes through `serializePlanFile` (round trip already proven by Task 1).
- [ ] Run to pass: `npx vitest run tests/stores/cutout.spec.ts`, full `npx vitest run`, `npm run build`.
- [ ] Commit:
  ```
  git add -A && git commit -m "Hold cavity edits with undo and redo in the cutout store.

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

## Task 5: Viewport paint mode (brush cursor, stroke sampling, ghost capsules)

**Files:**
- Modify: `web/src/components/cutout/CutoutViewport.vue`

**Interfaces:**
- New props on `CutoutViewport.vue`:
  ```ts
  /** The active paint tool, or null when the gizmo owns the pointer. */
  paintTool: 'add' | 'remove' | 'flatten' | null;
  /** Brush radius in mm, sizing the cursor and the ghost capsules. */
  brushRadiusMm: number;
  ```
- New emits:
  ```ts
  /** A brush stroke ended: the sampled hit points in bin-local mm. */
  strokeCommit: [points: Vec3Mm[]];
  /** A flatten click landed: the hit point supplies the centre and the plane height. */
  flattenCommit: [centerMm: Vec3Mm, planeZMm: number];
  /** The user pressed Escape inside the viewport while painting. */
  exitPaint: [];
  ```
- Behavior contract (each point below becomes code in this component):
  - While `paintTool` is not null, both `TransformControls` instances are detached and disabled (`enabled = false`), and ghost-selection raycasting on click is suppressed; when it returns to null, `syncSelection()` reattaches and both instances are re-enabled. A `watch` on `props.paintTool` owns this.
  - Cursor: one `THREE.Mesh` reused across frames; a translucent sphere (`SphereGeometry(1)` scaled to `brushRadiusMm`) for add/remove, and for flatten a flat disc (`CylinderGeometry(1, 1, 0.2)` rotated upright, scaled to the radius) plus a thin vertical line (`THREE.Line`) from the bed to the hit point as the height indicator. On `pointermove`, raycast (`THREE.Raycaster`, the component's existing `raycaster`) against `binMesh` (and `binLabelMesh` when present) only; cursor visible only while there is a hit. Switch on the three tool values plus null ends in `assertNever` (rule 13 binds in components too).
  - Add/Remove stroke: `pointerdown` with button 0 while the cursor has a hit starts a stroke (call `canvas.setPointerCapture(event.pointerId)`, and set `ctx.controls.enabled = false` so the left drag never orbits; right-drag and wheel orbiting are untouched because OrbitControls handles those buttons and is only disabled during the left-button stroke). Each `pointermove` raycasts and appends the hit as `{ xMm, yMm, zMm }` when it moved at least `brushRadiusMm / 4` mm from the last sampled point (the stroke tolerance figure, imported from `strokeToleranceMm`, not a new constant). During the drag, ghost geometry renders on the main thread with no CSG: one translucent sphere mesh per sampled point and a cylinder segment between consecutive points (positioned by midpoint and quaternion from the segment direction), all sharing one material per tool (reuse `createGhostMaterial(PRIMARY)` styling with the info color for add and the error color for remove, matching the existing tone palette). `pointerup` clears the ghosts, re-enables orbit, and emits `strokeCommit` with the sampled points when at least one point landed.
  - Flatten: a click (same `CLICK_TOLERANCE_PX` travel guard the selection click uses) with a hit emits `flattenCommit({ xMm, yMm, zMm }, zMm)`.
  - `keydown` Escape on the canvas (make it focusable or listen on `window` while painting) emits `exitPaint`; all listeners removed in `onTeardown`, cursor and ghost resources disposed there too.

**Steps:**

- [ ] Implement the props, emits, watch, cursor, stroke sampling, ghost capsule chain, flatten click and Escape handling in `CutoutViewport.vue` per the contract above, following the component's existing patterns (listeners added in `onReady`, removed in `onTeardown`; geometry disposed; no per-frame allocation in `pointermove` beyond the sampled points array).
- [ ] Typecheck and build: `npm run build` green. There is no Vitest coverage for pointer interaction in this repo; the ghost-mesh math that is testable already lives in `strokeToleranceMm` and Task 2's `simplifyStroke`.
- [ ] Manual check note for the owner (do not perform; record in the commit-adjacent PR/summary text): with a cutout bin on screen, activate each tool, confirm the cursor tracks the bin surface, a left drag paints a capsule ghost and commits on release, right drag still orbits, Escape leaves paint mode and the gizmo returns.
- [ ] Commit:
  ```
  git add -A && git commit -m "Add a brush paint mode to the cutout viewport.

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

## Task 6: Tab toolbar, commit wiring, rejection handling, clear-all dialog

**Files:**
- Modify: `web/src/components/cutout/CutoutTab.vue`

**Interfaces:**
- Consumes: everything from Tasks 4 and 5; `CAVITY_EDIT_RADIUS_MIN_MM` / `CAVITY_EDIT_RADIUS_MAX_MM` from the engine; the existing `useBinPreview` `errorMessage` and `generating` refs (~line 213); the v-dialog pattern from `web/src/components/IconPicker.vue`.
- Produces (template, above the viewport card):
  - Three `v-btn-toggle`-style tool buttons (Add, Remove, Flatten) bound to `cutout.activeTool`; clicking the active one passes null (the toggle group with `mandatory` off gives this for free).
  - A brush radius `v-text-field type="number"` with the same step/stepper styling as the clearance field (search the template for the clearance stepper near `CLEARANCE_STEP`; mirror its `density`, `suffix="mm"`, step and append/prepend controls), committing on blur/Enter through `cutout.setBrushRadius`, min/max from the shared bounds.
  - Undo (`disabled` when `cutout.edits.length === 0`), Redo (`disabled` when `cutout.redoStack.length === 0`), and a "Clear all edits" button (`disabled` when no edits) that opens a `v-dialog` with the text: "Remove all manual cavity edits from this bin? The models and their pockets are kept." and Cancel / "Remove all edits" actions; confirming calls `cutout.clearEdits()`.
- Event wiring on `<CutoutViewport>`:
  ```
  :paint-tool="cutout.activeTool"
  :brush-radius-mm="cutout.brushRadiusMm"
  @stroke-commit="onStrokeCommit"
  @flatten-commit="onFlattenCommit"
  @exit-paint="cutout.setActiveTool(null)"
  ```
  with:
  ```ts
  function onStrokeCommit(points: Vec3Mm[]): void {
    if (cutout.activeTool !== 'add' && cutout.activeTool !== 'remove') return;
    beginEditWatch();
    cutout.appendEdit({ kind: cutout.activeTool, points, radiusMm: cutout.brushRadiusMm });
  }
  function onFlattenCommit(centerMm: Vec3Mm, planeZMm: number): void {
    if (cutout.activeTool !== 'flatten') return;
    beginEditWatch();
    cutout.appendEdit({ kind: 'flatten', centerMm, radiusMm: cutout.brushRadiusMm, planeZMm });
  }
  ```
  Appending mutates `cutout.edits`, which `carveRequest` derives from, so the recarve starts through exactly the same reactive `useBinPreview` path a `placementCommit` uses today; no new carve trigger.
- Rejection handling (spec: a rejected edit is not committed and the previous body is kept): `beginEditWatch()` records `pendingEditCount = cutout.edits.length + 1`; a watcher on `generating` fires when it goes false; if at that moment `errorMessage.value !== null` and `cutout.edits.length === pendingEditCount` (nothing else changed the list meanwhile), it calls `cutout.rollbackEdit()`, sets a local `editError = errorMessage.value`, and clears the pending count; a successful settle just clears the pending count. `editError` renders in the tab's existing error surface, the `v-alert type="error"` block (~line 977), as its own alert row, and is cleared on the next append or tool change.

**Steps:**

- [ ] Implement the toolbar, dialog, event handlers and rejection watcher per Interfaces. All UI text as written above (complete sentences, no fragments beyond button labels).
- [ ] Verify the whole feature compiles and every suite is green: `npx vitest run` and `npm run build` from `web/`.
- [ ] Manual check note for the owner: paint an add and a remove stroke and a flatten on a carved bin, watch the recarve land after each commit; undo/redo walk the strokes; clear-all asks first; painting an edit that empties the bin (huge radius remove) shows the rejection sentence and the bin keeps its previous shape; queue the bin, reload the page, reopen the entry, and the edits are still applied; a plan exported before this feature still imports.
- [ ] Commit:
  ```
  git add -A && git commit -m "Add the cavity edit toolbar with undo, redo and clear-all.

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

## Self-review checklist (run after Task 6, fix inline)

- [ ] Spec coverage: every bullet of the design doc's data model, engine, worker, UI, errors and testing sections maps to a task step; out-of-scope items untouched.
- [ ] Placeholder scan: no TBD, no "similar to", no em-dash character anywhere in the diff (`git diff master --unified=0 | grep -P '\x{2014}'` must print nothing).
- [ ] Type consistency: `CavityEdit`, `Vec3Mm`, `CavityEditedBodyMemo`, `cavityEditsKey`, `cutoutCarveRecipeKey`, `applyCavityEditsMemoized` spelled and shaped identically at every use site.
- [ ] Every `switch` on `CavityEdit['kind']` (engine fold, store clone, tab clone, viewport cursor) ends in `assertNever`.
- [ ] `npm run build` and `npx vitest run` green from `web/`.
