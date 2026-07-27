# Sketch Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parametric 2D sketch workspace (lines, arcs, circles, constraints, dimensions) that produces the same millimeter outline a photo trace produces and feeds the existing tool pocket pipeline unchanged.

**Architecture:** A new framework-agnostic engine module `web/src/engine/sketch/` (model, PlaneGCS solver adapter, profile extraction), a dedicated Comlink worker owning the PlaneGCS WASM, an origin discriminator on `TracedTool` (photo vs sketch, sketched tools embed their editable `Sketch`), plan file version 11, and an SVG sketch editor inside the Tool trace tab behind an upload-or-draw toggle.

**Tech Stack:** Vue 3 + TypeScript + Vite + Pinia, Comlink workers, `@salusoft89/planegcs` (LGPL-2.1, WASM), Vitest.

## Global Constraints

- Engine code (`web/src/engine/`) must not import Vue or Pinia or touch the DOM (CLAUDE.md convention 3). Modules that need WASM take the loaded instance as a parameter.
- No silently swallowed errors; user-fixable problems are returned as user-worded messages, never raw exceptions (convention 2).
- Every branch on a discriminated union handles every member and ends in `assertNever` from `web/src/engine/plan/types.ts` (convention 13).
- Never use the em-dash character anywhere, including comments and UI text (convention 6).
- UI text is plain technical prose in complete sentences; diagnostic readouts are labeled rows (conventions 7, 8).
- Validation messages in `planFile.ts` follow the file's documented convention: optional lowercase subject prefix, then exactly one complete sentence ending in a full stop.
- Geometry math must be established methods, named as such; no hand-tuned fudge factors (conventions 1, 12).
- Arc flattening uses the trace pipeline's existing 0.2 mm tolerance (single source, convention 10).
- Never compute a value the codebase already derives elsewhere (convention 10).
- Commit messages: a single short sentence, `Co-Authored-By: Claude <noreply@anthropic.com>` trailer allowed, no other AI attribution (convention 4).
- All commands run from `web/`. Verification bar: `npm run build` and `npm test` green.
- Splines and ellipses are out of scope (spec V1 scope).

## Shared type reference

These names are used across tasks; Task 2 defines them in `web/src/engine/sketch/model.ts`:

- `SKETCH_SCHEMA_VERSION = 1`
- `Sketch { schemaVersion: number; entities: SketchEntity[]; constraints: SketchConstraint[] }`
- `SketchEntity = SketchPoint | SketchLine | SketchArc | SketchCircle` (discriminated on `kind`)
- `SketchConstraint` (discriminated on `kind`): `coincident`, `horizontal`, `vertical`, `parallel`, `perpendicular`, `tangent`, `symmetric`, `length`, `distance`, `radius`, `diameter`, `angle`
- `validateSketch(raw: unknown, subject: string): string | null`
- `deserializeSketch(raw: unknown): { ok: true; sketch: Sketch } | { ok: false; error: string }`
- `cloneSketch(sketch: Sketch): Sketch`
- `arcFromThreePoints(start, mid, end): { center: MmPoint; ccw: boolean } | null`

Task 3 defines in `web/src/engine/sketch/solve.ts`:

- `DragTarget { pointId: string; xMm: number; yMm: number }`
- `SketchSolveResult = { status: 'solved'; sketch: Sketch; dof: number } | { status: 'conflicting'; conflictingConstraintIds: string[] } | { status: 'failed'; message: string }`
- `solveSketch(wrapper: GcsWrapper, sketch: Sketch, drag?: DragTarget): SketchSolveResult`

Task 4 defines in `web/src/engine/sketch/profile.ts`:

- `ProfileResult = { ok: true; outline: TracedOutline } | { ok: false; error: string }`
- `extractProfile(sketch: Sketch): ProfileResult`

Task 6 defines in `web/src/engine/trace/types.ts`:

- `ToolSource = { kind: 'photo' } | { kind: 'sketch'; sketch: Sketch }` and a required `source: ToolSource` field on `TracedTool`.

---

### Task 1: PlaneGCS dependency, node smoke test, LGPL attribution

**Files:**
- Modify: `web/package.json` (add dependency)
- Create: `web/tests/helpers/planegcs.ts`
- Test: `web/tests/sketch/planegcsSmoke.spec.ts`
- Modify: `README.md` (attribution paragraph next to the existing kennetek attribution at lines 65-66)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `loadGcsWrapper(): Promise<GcsWrapper>` in `web/tests/helpers/planegcs.ts`, used by Task 3 tests. Confirms the exact import names `init_planegcs_module`, `GcsWrapper` resolve from the package root.

- [ ] **Step 1: Install the dependency**

Run from `web/`:

```bash
npm install @salusoft89/planegcs
```

Expected: `package.json` gains `"@salusoft89/planegcs"` under `dependencies`.

- [ ] **Step 2: Write the failing smoke test and its helper**

Create `web/tests/helpers/planegcs.ts`:

```typescript
import { fileURLToPath } from 'node:url';
import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs';

/**
 * Loads the PlaneGCS WASM from node_modules for node-side tests, the same
 * disk-loading pattern tests/vision/visionSmoke.spec.ts uses for the
 * MobileSAM models. In the browser the sketch worker resolves the wasm with
 * a Vite ?url import instead.
 */
export async function loadGcsWrapper(): Promise<GcsWrapper> {
  const wasmPath = fileURLToPath(
    new URL(
      '../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm',
      import.meta.url,
    ),
  );
  const mod = await init_planegcs_module({ locateFile: () => wasmPath });
  return new GcsWrapper(new mod.GcsSystem());
}
```

Create `web/tests/sketch/planegcsSmoke.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadGcsWrapper } from '../helpers/planegcs';

// The sketch worker itself cannot run under node (Comlink), so this smoke
// test exercises the same library it loads, following the vision smoke test
// pattern in tests/vision/visionSmoke.spec.ts.

describe('planegcs wasm', () => {
  it('loads the wasm and solves a one-constraint system', async () => {
    const wrapper = await loadGcsWrapper();
    wrapper.push_primitives_and_params([
      { id: '1', type: 'point', x: 0, y: 0, fixed: true },
      { id: '2', type: 'point', x: 3, y: 4, fixed: false },
      { id: '3', type: 'p2p_distance', p1_id: '1', p2_id: '2', distance: 10 },
    ]);
    const status = wrapper.solve();
    expect(status).toBeLessThanOrEqual(1); // Success (0) or Converged (1)
    wrapper.apply_solution();
    const p2 = wrapper.sketch_index.get_primitive_or_fail('2') as {
      x: number;
      y: number;
    };
    expect(Math.hypot(p2.x, p2.y)).toBeCloseTo(10, 6);
    expect(wrapper.gcs.dof()).toBe(1); // a point on a circle has one dof left
    wrapper.destroy_gcs_module();
  });
});
```

Note: if `init_planegcs_module` or `GcsWrapper` fail to resolve from the package root, import them from `@salusoft89/planegcs/dist/index` instead; check `node_modules/@salusoft89/planegcs/package.json` `exports` and use the documented entry. Do not vendor the files.

- [ ] **Step 3: Run the test to verify current behavior**

Run: `npx vitest run tests/sketch/planegcsSmoke.spec.ts`
Expected: PASS (the test fails only if the install or the API names are wrong; fix the import path per the note above until it passes).

- [ ] **Step 4: Add the LGPL attribution**

In `README.md`, directly after the kennetek attribution paragraph (currently lines 65-66), add:

```markdown
The 2D sketch workspace is powered by the FreeCAD PlaneGCS constraint solver, compiled to
WebAssembly by the LGPL-2.1-licensed
[Salusoft89/planegcs](https://github.com/Salusoft89/planegcs). The `planegcs.wasm` binary
ships as a separate, replaceable asset, as the LGPL requires.
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/helpers/planegcs.ts tests/sketch/planegcsSmoke.spec.ts ../README.md
git commit -m "Add the PlaneGCS solver dependency with a node smoke test and LGPL attribution."
```

---

### Task 2: Sketch datatype, validation, serialization

**Files:**
- Create: `web/src/engine/sketch/model.ts`
- Test: `web/tests/sketch/model.spec.ts`

**Interfaces:**
- Consumes: `MmPoint` from `web/src/engine/trace/types.ts`, `assertNever` from `web/src/engine/plan/types.ts`.
- Produces: everything in the "Shared type reference" block for model.ts, used by Tasks 3, 4, 5, 6, 7, 8.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/sketch/model.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  SKETCH_SCHEMA_VERSION,
  arcFromThreePoints,
  cloneSketch,
  deserializeSketch,
  validateSketch,
  type Sketch,
} from '../../src/engine/sketch/model';

/** A valid dimensioned unit square sketch used across the model tests. */
export function squareSketch(): Sketch {
  return {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      { kind: 'point', id: 'pA', x: 0, y: 0, construction: false },
      { kind: 'point', id: 'pB', x: 10, y: 0, construction: false },
      { kind: 'point', id: 'pC', x: 10, y: 10, construction: false },
      { kind: 'point', id: 'pD', x: 0, y: 10, construction: false },
      { kind: 'line', id: 'lAB', p1Id: 'pA', p2Id: 'pB', construction: false },
      { kind: 'line', id: 'lBC', p1Id: 'pB', p2Id: 'pC', construction: false },
      { kind: 'line', id: 'lCD', p1Id: 'pC', p2Id: 'pD', construction: false },
      { kind: 'line', id: 'lDA', p1Id: 'pD', p2Id: 'pA', construction: false },
    ],
    constraints: [
      { kind: 'horizontal', id: 'c1', lineId: 'lAB' },
      { kind: 'vertical', id: 'c2', lineId: 'lBC' },
      { kind: 'length', id: 'c3', lineId: 'lAB', mm: 10 },
      { kind: 'length', id: 'c4', lineId: 'lBC', mm: 10 },
    ],
  };
}

describe('validateSketch', () => {
  it('accepts a valid sketch', () => {
    expect(validateSketch(squareSketch(), 'sketch')).toBeNull();
  });

  it('rejects a duplicate entity id with a user-worded message', () => {
    const sketch = squareSketch();
    sketch.entities.push({ kind: 'point', id: 'pA', x: 1, y: 1, construction: false });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The sketch id pA appears twice.',
    );
  });

  it('rejects a line whose endpoint is not a point', () => {
    const sketch = squareSketch();
    sketch.entities.push({ kind: 'line', id: 'lX', p1Id: 'lAB', p2Id: 'pA', construction: false });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The line lX must connect two sketch points.',
    );
  });

  it('rejects a constraint referring to a missing entity', () => {
    const sketch = squareSketch();
    sketch.constraints.push({ kind: 'horizontal', id: 'cX', lineId: 'nope' });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The constraint cX refers to geometry that is not in the sketch.',
    );
  });

  it('rejects a tangent constraint between two lines', () => {
    const sketch = squareSketch();
    sketch.constraints.push({ kind: 'tangent', id: 'cT', aId: 'lAB', bId: 'lBC' });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The tangent constraint cT needs an arc or circle on at least one side.',
    );
  });

  it('rejects a non-positive dimension', () => {
    const sketch = squareSketch();
    sketch.constraints.push({ kind: 'radius', id: 'cR', entityId: 'lAB', mm: -1 });
    expect(validateSketch(sketch, 'sketch')).toBe(
      'sketch: The radius constraint cR needs an arc or a circle.',
    );
  });

  it('rejects an unknown schema version', () => {
    const sketch = { ...squareSketch(), schemaVersion: 999 };
    expect(validateSketch(sketch, 'sketch')).toBe(
      `sketch: The sketch has schema version 999, but this app reads version ${SKETCH_SCHEMA_VERSION}.`,
    );
  });
});

describe('deserializeSketch', () => {
  it('round-trips through JSON', () => {
    const original = squareSketch();
    const result = deserializeSketch(JSON.parse(JSON.stringify(original)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sketch).toEqual(original);
  });

  it('returns the validation message for a broken value', () => {
    const result = deserializeSketch({ schemaVersion: SKETCH_SCHEMA_VERSION });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('sketch: The entities must be a list.');
  });
});

describe('cloneSketch', () => {
  it('produces an equal sketch sharing no objects', () => {
    const original = squareSketch();
    const copy = cloneSketch(original);
    expect(copy).toEqual(original);
    expect(copy.entities[0]).not.toBe(original.entities[0]);
    expect(copy.constraints[0]).not.toBe(original.constraints[0]);
  });
});

describe('arcFromThreePoints', () => {
  it('finds the circumcenter and orientation of a counterclockwise arc', () => {
    const arc = arcFromThreePoints({ x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 });
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 9);
    expect(arc!.center.y).toBeCloseTo(0, 9);
    expect(arc!.ccw).toBe(false);
  });

  it('reports clockwise for the mirrored point order', () => {
    const arc = arcFromThreePoints({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 });
    expect(arc!.ccw).toBe(true);
  });

  it('returns null for collinear points', () => {
    expect(arcFromThreePoints({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toBeNull();
  });
});
```

Note on orientation: sketch coordinates follow the trace convention (y increases downward, see `MmPoint` in `engine/trace/types.ts`), so a positive cross product is a clockwise turn on screen; `ccw` here means mathematically counterclockwise in the y-down frame, i.e. cross product of (mid-start) x (end-start) is negative. The test values above encode exactly that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sketch/model.spec.ts`
Expected: FAIL with "Cannot find module '../../src/engine/sketch/model'".

- [ ] **Step 3: Implement model.ts**

Create `web/src/engine/sketch/model.ts`:

```typescript
// The parametric 2D sketch datatype of the sketch workspace. Plain JSON
// throughout so a sketch serializes inside a plan file. All coordinates are
// millimeters in the trace frame (y increasing downward). The sketch carries
// its own schema version so the format can evolve without a plan version
// bump each time.
import type { MmPoint } from '../trace/types';
import { assertNever } from '../plan/types';

export const SKETCH_SCHEMA_VERSION = 1;

/** A sketch point, the only entity carrying coordinates. */
export interface SketchPoint {
  kind: 'point';
  id: string;
  x: number;
  y: number;
  construction: boolean;
}

/** A line segment between two sketch points. */
export interface SketchLine {
  kind: 'line';
  id: string;
  p1Id: string;
  p2Id: string;
  construction: boolean;
}

/**
 * A circular arc running counterclockwise (in the y-down mm frame) from the
 * start point to the end point about the center point. Radius and angles are
 * deliberately not stored: they are derived from the three points when the
 * solver needs them, so there is a single source for the arc's shape.
 */
export interface SketchArc {
  kind: 'arc';
  id: string;
  centerId: string;
  startId: string;
  endId: string;
  construction: boolean;
}

/** A full circle about a center point. */
export interface SketchCircle {
  kind: 'circle';
  id: string;
  centerId: string;
  radiusMm: number;
  construction: boolean;
}

export type SketchEntity = SketchPoint | SketchLine | SketchArc | SketchCircle;

export interface CoincidentConstraint {
  kind: 'coincident';
  id: string;
  p1Id: string;
  p2Id: string;
}
export interface HorizontalConstraint {
  kind: 'horizontal';
  id: string;
  lineId: string;
}
export interface VerticalConstraint {
  kind: 'vertical';
  id: string;
  lineId: string;
}
export interface ParallelConstraint {
  kind: 'parallel';
  id: string;
  l1Id: string;
  l2Id: string;
}
export interface PerpendicularConstraint {
  kind: 'perpendicular';
  id: string;
  l1Id: string;
  l2Id: string;
}
/** Tangency between a line, arc or circle pair; at most one side may be a line. */
export interface TangentConstraint {
  kind: 'tangent';
  id: string;
  aId: string;
  bId: string;
}
/** Two points mirrored across a line (usually a construction line). */
export interface SymmetricConstraint {
  kind: 'symmetric';
  id: string;
  p1Id: string;
  p2Id: string;
  mirrorLineId: string;
}
export interface LengthDimension {
  kind: 'length';
  id: string;
  lineId: string;
  mm: number;
}
export interface DistanceDimension {
  kind: 'distance';
  id: string;
  p1Id: string;
  p2Id: string;
  mm: number;
}
export interface RadiusDimension {
  kind: 'radius';
  id: string;
  entityId: string;
  mm: number;
}
export interface DiameterDimension {
  kind: 'diameter';
  id: string;
  entityId: string;
  mm: number;
}
export interface AngleDimension {
  kind: 'angle';
  id: string;
  l1Id: string;
  l2Id: string;
  degrees: number;
}

export type SketchConstraint =
  | CoincidentConstraint
  | HorizontalConstraint
  | VerticalConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | TangentConstraint
  | SymmetricConstraint
  | LengthDimension
  | DistanceDimension
  | RadiusDimension
  | DiameterDimension
  | AngleDimension;

/** The dimension subset of the constraints, for the click-to-edit labels. */
export type SketchDimension =
  | LengthDimension
  | DistanceDimension
  | RadiusDimension
  | DiameterDimension
  | AngleDimension;

export interface Sketch {
  schemaVersion: number;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

/** An empty sketch at the current schema version. */
export function emptySketch(): Sketch {
  return { schemaVersion: SKETCH_SCHEMA_VERSION, entities: [], constraints: [] };
}

/** Deep copy through JSON; a Sketch is plain JSON by construction. */
export function cloneSketch(sketch: Sketch): Sketch {
  return JSON.parse(JSON.stringify(sketch)) as Sketch;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates a raw value as a Sketch. Returns null when valid, otherwise one
 * user-worded sentence prefixed with the given subject, following the plan
 * file's validation message convention.
 */
export function validateSketch(raw: unknown, subject: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${subject}: The sketch must be an object.`;
  }
  const sketch = raw as Record<string, unknown>;
  if (sketch.schemaVersion !== SKETCH_SCHEMA_VERSION) {
    return (
      `${subject}: The sketch has schema version ${String(sketch.schemaVersion)}, ` +
      `but this app reads version ${SKETCH_SCHEMA_VERSION}.`
    );
  }
  if (!Array.isArray(sketch.entities)) {
    return `${subject}: The entities must be a list.`;
  }
  if (!Array.isArray(sketch.constraints)) {
    return `${subject}: The constraints must be a list.`;
  }
  const kinds = new Map<string, SketchEntity['kind']>();
  for (const rawEntity of sketch.entities) {
    if (typeof rawEntity !== 'object' || rawEntity === null || Array.isArray(rawEntity)) {
      return `${subject}: A sketch entity is not an object.`;
    }
    const entity = rawEntity as Record<string, unknown>;
    if (!isId(entity.id)) {
      return `${subject}: A sketch entity is missing its id.`;
    }
    if (kinds.has(entity.id)) {
      return `${subject}: The sketch id ${entity.id} appears twice.`;
    }
    if (typeof entity.construction !== 'boolean') {
      return `${subject}: The entity ${entity.id} is missing its construction flag.`;
    }
    const kind = entity.kind as SketchEntity['kind'];
    switch (kind) {
      case 'point':
        if (!isFiniteNumber(entity.x) || !isFiniteNumber(entity.y)) {
          return `${subject}: The point ${entity.id} needs finite x and y coordinates in mm.`;
        }
        break;
      case 'line':
        if (!isId(entity.p1Id) || !isId(entity.p2Id)) {
          return `${subject}: The line ${entity.id} must connect two sketch points.`;
        }
        break;
      case 'arc':
        if (!isId(entity.centerId) || !isId(entity.startId) || !isId(entity.endId)) {
          return `${subject}: The arc ${entity.id} needs a center, a start and an end point.`;
        }
        break;
      case 'circle':
        if (!isId(entity.centerId)) {
          return `${subject}: The circle ${entity.id} needs a center point.`;
        }
        if (!isFiniteNumber(entity.radiusMm) || entity.radiusMm <= 0) {
          return `${subject}: The circle ${entity.id} needs a radius above 0 mm.`;
        }
        break;
      default:
        return `${subject}: The entity kind must be point, line, arc or circle.`;
    }
    kinds.set(entity.id, kind);
  }
  const isPoint = (id: unknown): boolean => isId(id) && kinds.get(id) === 'point';
  const isLine = (id: unknown): boolean => isId(id) && kinds.get(id) === 'line';
  const isCurveOrCircle = (id: unknown): boolean =>
    isId(id) && (kinds.get(id) === 'arc' || kinds.get(id) === 'circle');
  // Second pass: entity references resolve to the right kinds.
  for (const entity of sketch.entities as Record<string, unknown>[]) {
    const kind = entity.kind as SketchEntity['kind'];
    switch (kind) {
      case 'point':
        break;
      case 'line':
        if (!isPoint(entity.p1Id) || !isPoint(entity.p2Id)) {
          return `${subject}: The line ${entity.id} must connect two sketch points.`;
        }
        break;
      case 'arc':
        if (!isPoint(entity.centerId) || !isPoint(entity.startId) || !isPoint(entity.endId)) {
          return `${subject}: The arc ${entity.id} needs a center, a start and an end point.`;
        }
        break;
      case 'circle':
        if (!isPoint(entity.centerId)) {
          return `${subject}: The circle ${entity.id} needs a center point.`;
        }
        break;
      default:
        return assertNever(kind);
    }
  }
  const constraintIds = new Set<string>();
  for (const rawConstraint of sketch.constraints) {
    if (
      typeof rawConstraint !== 'object' ||
      rawConstraint === null ||
      Array.isArray(rawConstraint)
    ) {
      return `${subject}: A sketch constraint is not an object.`;
    }
    const c = rawConstraint as Record<string, unknown>;
    if (!isId(c.id)) {
      return `${subject}: A sketch constraint is missing its id.`;
    }
    if (constraintIds.has(c.id) || kinds.has(c.id)) {
      return `${subject}: The sketch id ${c.id} appears twice.`;
    }
    constraintIds.add(c.id);
    const missing = `${subject}: The constraint ${c.id} refers to geometry that is not in the sketch.`;
    const kind = c.kind as SketchConstraint['kind'];
    switch (kind) {
      case 'coincident':
        if (!kinds.has(c.p1Id as string) || !kinds.has(c.p2Id as string)) return missing;
        if (!isPoint(c.p1Id) || !isPoint(c.p2Id)) {
          return `${subject}: The coincident constraint ${c.id} needs two points.`;
        }
        break;
      case 'horizontal':
      case 'vertical':
        if (!kinds.has(c.lineId as string)) return missing;
        if (!isLine(c.lineId)) {
          return `${subject}: The ${kind} constraint ${c.id} needs a line.`;
        }
        break;
      case 'parallel':
      case 'perpendicular':
        if (!kinds.has(c.l1Id as string) || !kinds.has(c.l2Id as string)) return missing;
        if (!isLine(c.l1Id) || !isLine(c.l2Id)) {
          return `${subject}: The ${kind} constraint ${c.id} needs two lines.`;
        }
        break;
      case 'tangent': {
        if (!kinds.has(c.aId as string) || !kinds.has(c.bId as string)) return missing;
        const aCurve = isCurveOrCircle(c.aId);
        const bCurve = isCurveOrCircle(c.bId);
        const aLine = isLine(c.aId);
        const bLine = isLine(c.bId);
        if (!((aCurve && (bCurve || bLine)) || (aLine && bCurve))) {
          return `${subject}: The tangent constraint ${c.id} needs an arc or circle on at least one side.`;
        }
        break;
      }
      case 'symmetric':
        if (
          !kinds.has(c.p1Id as string) ||
          !kinds.has(c.p2Id as string) ||
          !kinds.has(c.mirrorLineId as string)
        ) {
          return missing;
        }
        if (!isPoint(c.p1Id) || !isPoint(c.p2Id) || !isLine(c.mirrorLineId)) {
          return `${subject}: The symmetric constraint ${c.id} needs two points and a mirror line.`;
        }
        break;
      case 'length':
        if (!kinds.has(c.lineId as string)) return missing;
        if (!isLine(c.lineId)) {
          return `${subject}: The length constraint ${c.id} needs a line.`;
        }
        if (!isFiniteNumber(c.mm) || c.mm <= 0) {
          return `${subject}: The length constraint ${c.id} needs a value above 0 mm.`;
        }
        break;
      case 'distance':
        if (!kinds.has(c.p1Id as string) || !kinds.has(c.p2Id as string)) return missing;
        if (!isPoint(c.p1Id) || !isPoint(c.p2Id)) {
          return `${subject}: The distance constraint ${c.id} needs two points.`;
        }
        if (!isFiniteNumber(c.mm) || c.mm <= 0) {
          return `${subject}: The distance constraint ${c.id} needs a value above 0 mm.`;
        }
        break;
      case 'radius':
      case 'diameter':
        if (!kinds.has(c.entityId as string)) return missing;
        if (!isCurveOrCircle(c.entityId)) {
          return `${subject}: The ${kind} constraint ${c.id} needs an arc or a circle.`;
        }
        if (!isFiniteNumber(c.mm) || c.mm <= 0) {
          return `${subject}: The ${kind} constraint ${c.id} needs a value above 0 mm.`;
        }
        break;
      case 'angle':
        if (!kinds.has(c.l1Id as string) || !kinds.has(c.l2Id as string)) return missing;
        if (!isLine(c.l1Id) || !isLine(c.l2Id)) {
          return `${subject}: The angle constraint ${c.id} needs two lines.`;
        }
        if (!isFiniteNumber(c.degrees)) {
          return `${subject}: The angle constraint ${c.id} needs a finite angle in degrees.`;
        }
        break;
      default:
        return `${subject}: The constraint kind of ${c.id} is not one this app knows.`;
    }
  }
  return null;
}

/** Result of reading a sketch from untrusted JSON. */
export type SketchParseResult =
  | { ok: true; sketch: Sketch }
  | { ok: false; error: string };

/**
 * Validates and deep-copies a raw value into a Sketch, so an imported plan
 * cannot smuggle extra fields into memory. The copy is field-by-field via the
 * validated shape; validateSketch has already proven every field.
 */
export function deserializeSketch(raw: unknown): SketchParseResult {
  const problem = validateSketch(raw, 'sketch');
  if (problem !== null) return { ok: false, error: problem };
  const source = raw as Sketch;
  const entities: SketchEntity[] = source.entities.map((e) => {
    switch (e.kind) {
      case 'point':
        return { kind: 'point', id: e.id, x: e.x, y: e.y, construction: e.construction };
      case 'line':
        return { kind: 'line', id: e.id, p1Id: e.p1Id, p2Id: e.p2Id, construction: e.construction };
      case 'arc':
        return {
          kind: 'arc',
          id: e.id,
          centerId: e.centerId,
          startId: e.startId,
          endId: e.endId,
          construction: e.construction,
        };
      case 'circle':
        return {
          kind: 'circle',
          id: e.id,
          centerId: e.centerId,
          radiusMm: e.radiusMm,
          construction: e.construction,
        };
      default:
        return assertNever(e);
    }
  });
  const constraints: SketchConstraint[] = source.constraints.map((c) => {
    switch (c.kind) {
      case 'coincident':
        return { kind: 'coincident', id: c.id, p1Id: c.p1Id, p2Id: c.p2Id };
      case 'horizontal':
        return { kind: 'horizontal', id: c.id, lineId: c.lineId };
      case 'vertical':
        return { kind: 'vertical', id: c.id, lineId: c.lineId };
      case 'parallel':
        return { kind: 'parallel', id: c.id, l1Id: c.l1Id, l2Id: c.l2Id };
      case 'perpendicular':
        return { kind: 'perpendicular', id: c.id, l1Id: c.l1Id, l2Id: c.l2Id };
      case 'tangent':
        return { kind: 'tangent', id: c.id, aId: c.aId, bId: c.bId };
      case 'symmetric':
        return {
          kind: 'symmetric',
          id: c.id,
          p1Id: c.p1Id,
          p2Id: c.p2Id,
          mirrorLineId: c.mirrorLineId,
        };
      case 'length':
        return { kind: 'length', id: c.id, lineId: c.lineId, mm: c.mm };
      case 'distance':
        return { kind: 'distance', id: c.id, p1Id: c.p1Id, p2Id: c.p2Id, mm: c.mm };
      case 'radius':
        return { kind: 'radius', id: c.id, entityId: c.entityId, mm: c.mm };
      case 'diameter':
        return { kind: 'diameter', id: c.id, entityId: c.entityId, mm: c.mm };
      case 'angle':
        return { kind: 'angle', id: c.id, l1Id: c.l1Id, l2Id: c.l2Id, degrees: c.degrees };
      default:
        return assertNever(c);
    }
  });
  return {
    ok: true,
    sketch: { schemaVersion: SKETCH_SCHEMA_VERSION, entities, constraints },
  };
}

/**
 * Center and orientation of the circle through three points, by the standard
 * circumcenter formula (perpendicular bisector intersection). Returns null
 * for (near-)collinear points. ccw refers to the mathematical orientation in
 * the y-down mm frame: the cross product (mid-start) x (end-start) negative.
 */
export function arcFromThreePoints(
  start: MmPoint,
  mid: MmPoint,
  end: MmPoint,
): { center: MmPoint; ccw: boolean } | null {
  const ax = start.x;
  const ay = start.y;
  const bx = mid.x;
  const by = mid.y;
  const cx = end.x;
  const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d;
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return { center: { x: ux, y: uy }, ccw: cross < 0 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sketch/model.spec.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/sketch/model.ts tests/sketch/model.spec.ts
git commit -m "Add the sketch datatype with validation and serialization."
```

---

### Task 3: Solver adapter (solve.ts)

**Files:**
- Create: `web/src/engine/sketch/solve.ts`
- Test: `web/tests/sketch/solve.spec.ts`

**Interfaces:**
- Consumes: `Sketch`, `SketchEntity`, `SketchConstraint`, `cloneSketch` from Task 2; `GcsWrapper` type from `@salusoft89/planegcs`; `loadGcsWrapper` test helper from Task 1; `assertNever` from `web/src/engine/plan/types.ts`.
- Produces: `solveSketch(wrapper, sketch, drag?)`, `DragTarget`, `SketchSolveResult` (shapes in the shared reference), used by Tasks 5 and 7.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/sketch/solve.spec.ts`:

```typescript
import { beforeAll, describe, expect, it } from 'vitest';
import type { GcsWrapper } from '@salusoft89/planegcs';
import { loadGcsWrapper } from '../helpers/planegcs';
import { SKETCH_SCHEMA_VERSION, type Sketch } from '../../src/engine/sketch/model';
import { solveSketch } from '../../src/engine/sketch/solve';

let wrapper: GcsWrapper;
beforeAll(async () => {
  wrapper = await loadGcsWrapper();
});

function point(id: string, x: number, y: number, construction = false) {
  return { kind: 'point' as const, id, x, y, construction };
}
function line(id: string, p1Id: string, p2Id: string, construction = false) {
  return { kind: 'line' as const, id, p1Id, p2Id, construction };
}

/** A 30 by 20 rectangle drawn slightly off so the solver has work to do. */
function rectangleSketch(): Sketch {
  return {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    entities: [
      point('pA', 0.3, -0.2),
      point('pB', 29, 1),
      point('pC', 31, 21),
      point('pD', -1, 19),
      line('lAB', 'pA', 'pB'),
      line('lBC', 'pB', 'pC'),
      line('lCD', 'pC', 'pD'),
      line('lDA', 'pD', 'pA'),
    ],
    constraints: [
      { kind: 'horizontal', id: 'cH1', lineId: 'lAB' },
      { kind: 'horizontal', id: 'cH2', lineId: 'lCD' },
      { kind: 'vertical', id: 'cV1', lineId: 'lBC' },
      { kind: 'vertical', id: 'cV2', lineId: 'lDA' },
      { kind: 'length', id: 'cLen', lineId: 'lAB', mm: 30 },
      { kind: 'distance', id: 'cDist', p1Id: 'pB', p2Id: 'pC', mm: 20 },
    ],
  };
}

function solvedPoint(sketch: Sketch, id: string): { x: number; y: number } {
  const p = sketch.entities.find((e) => e.id === id);
  if (p === undefined || p.kind !== 'point') throw new Error(`missing point ${id}`);
  return p;
}

describe('solveSketch', () => {
  it('solves the dimensioned rectangle and reports the free dof', () => {
    const result = solveSketch(wrapper, rectangleSketch());
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const a = solvedPoint(result.sketch, 'pA');
    const b = solvedPoint(result.sketch, 'pB');
    const c = solvedPoint(result.sketch, 'pC');
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(30, 5);
    expect(Math.hypot(c.x - b.x, c.y - b.y)).toBeCloseTo(20, 5);
    expect(a.y).toBeCloseTo(b.y, 5);
    // The rectangle can still translate freely: two degrees of freedom.
    expect(result.dof).toBe(2);
  });

  it('solves a line with a tangent arc continuation', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        point('p1', 0, 0),
        point('p2', 20, 0),
        point('pc', 20, 10.5),
        point('p3', 30.5, 10),
        line('l1', 'p1', 'p2'),
        { kind: 'arc', id: 'a1', centerId: 'pc', startId: 'p2', endId: 'p3', construction: false },
      ],
      constraints: [
        { kind: 'horizontal', id: 'cH', lineId: 'l1' },
        { kind: 'tangent', id: 'cT', aId: 'l1', bId: 'a1' },
        { kind: 'radius', id: 'cR', entityId: 'a1', mm: 10 },
        { kind: 'distance', id: 'cD', p1Id: 'p1', p2Id: 'p2', mm: 20 },
      ],
    };
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const p2 = solvedPoint(result.sketch, 'p2');
    const pc = solvedPoint(result.sketch, 'pc');
    // Tangency at p2: the center sits perpendicular to the horizontal line.
    expect(Math.abs(pc.x - p2.x)).toBeLessThan(1e-4);
    expect(Math.hypot(pc.x - p2.x, pc.y - p2.y)).toBeCloseTo(10, 4);
  });

  it('keeps two points symmetric about a construction mirror line', () => {
    const sketch: Sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        point('m1', 10, -5, true),
        point('m2', 10, 25, true),
        point('pl', 2, 8),
        point('pr', 17, 9),
        line('mirror', 'm1', 'm2', true),
        line('span', 'pl', 'pr'),
      ],
      constraints: [
        { kind: 'vertical', id: 'cV', lineId: 'mirror' },
        { kind: 'symmetric', id: 'cS', p1Id: 'pl', p2Id: 'pr', mirrorLineId: 'mirror' },
        { kind: 'distance', id: 'cD', p1Id: 'pl', p2Id: 'pr', mm: 16 },
      ],
    };
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const pl = solvedPoint(result.sketch, 'pl');
    const pr = solvedPoint(result.sketch, 'pr');
    const m1 = solvedPoint(result.sketch, 'm1');
    expect((pl.x + pr.x) / 2).toBeCloseTo(m1.x, 4);
    expect(pr.x - pl.x).toBeCloseTo(16, 4);
  });

  it('reports the offending constraints of an over-constrained sketch', () => {
    const sketch = rectangleSketch();
    sketch.constraints.push({ kind: 'length', id: 'cClash', lineId: 'lAB', mm: 40 });
    const result = solveSketch(wrapper, sketch);
    expect(result.status).toBe('conflicting');
    if (result.status !== 'conflicting') return;
    expect(result.conflictingConstraintIds.length).toBeGreaterThan(0);
    for (const id of result.conflictingConstraintIds) {
      expect(sketch.constraints.some((c) => c.id === id)).toBe(true);
    }
  });

  it('moves a dragged point toward the target without breaking constraints', () => {
    const result = solveSketch(wrapper, rectangleSketch(), {
      pointId: 'pA',
      xMm: 100,
      yMm: 50,
    });
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    const a = solvedPoint(result.sketch, 'pA');
    const b = solvedPoint(result.sketch, 'pB');
    expect(a.x).toBeCloseTo(100, 3);
    expect(a.y).toBeCloseTo(50, 3);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(30, 4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sketch/solve.spec.ts`
Expected: FAIL with "Cannot find module '../../src/engine/sketch/solve'".

- [ ] **Step 3: Implement solve.ts**

Create `web/src/engine/sketch/solve.ts`:

```typescript
// Adapter between the Sketch datatype and the FreeCAD PlaneGCS solver
// (@salusoft89/planegcs). Framework-agnostic: the caller (worker or test)
// passes in the loaded GcsWrapper, the same injection pattern the gridfinity
// engine uses for the manifold instance. The adapter maps entities and
// constraints onto PlaneGCS primitives, runs the solver, and writes solved
// coordinates back into a copy of the sketch.
import type { GcsWrapper } from '@salusoft89/planegcs';
import { assertNever } from '../plan/types';
import { cloneSketch, type Sketch, type SketchEntity } from './model';

/** The solver's driven-point drag: pull pointId toward the target. */
export interface DragTarget {
  pointId: string;
  xMm: number;
  yMm: number;
}

export type SketchSolveResult =
  | { status: 'solved'; sketch: Sketch; dof: number }
  | { status: 'conflicting'; conflictingConstraintIds: string[] }
  | { status: 'failed'; message: string };

// PlaneGCS SolveStatus values (planegcs_dist/enums): Success 0, Converged 1,
// Failed 2, SuccessfulSolutionInvalid 3.
const SOLVE_SUCCESS = 0;
const SOLVE_CONVERGED = 1;

/** Internal ids the adapter adds; never reported back as user constraints. */
const DRAG_POINT_ID = '__drag_target';
const DRAG_CONSTRAINT_ID = '__drag_pin';

function arcAngles(
  center: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): { radius: number; startAngle: number; endAngle: number } {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  let endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  // The sketch arc runs counterclockwise from start to end; PlaneGCS expects
  // end_angle >= start_angle along that direction.
  if (endAngle <= startAngle) endAngle += 2 * Math.PI;
  return { radius, startAngle, endAngle };
}

/**
 * Runs the constraint solver over the sketch and returns the solved copy,
 * the remaining degrees of freedom (0 means fully constrained), the
 * conflicting constraint ids, or a user-worded failure. A drag is expressed
 * as PlaneGCS's standard interactive workflow: a fixed target point plus a
 * temporary coincidence, which the solver satisfies as well as the driving
 * constraints allow without reducing the reported dof.
 */
export function solveSketch(
  wrapper: GcsWrapper,
  sketch: Sketch,
  drag?: DragTarget,
): SketchSolveResult {
  const byId = new Map<string, SketchEntity>(sketch.entities.map((e) => [e.id, e]));
  const primitives: Record<string, unknown>[] = [];
  // Points first: PlaneGCS requires referenced primitives to be pushed
  // before the primitives and constraints that use them.
  for (const entity of sketch.entities) {
    if (entity.kind === 'point') {
      primitives.push({
        id: entity.id,
        type: 'point',
        x: entity.x,
        y: entity.y,
        fixed: false,
      });
    }
  }
  for (const entity of sketch.entities) {
    switch (entity.kind) {
      case 'point':
        break;
      case 'line':
        primitives.push({ id: entity.id, type: 'line', p1_id: entity.p1Id, p2_id: entity.p2Id });
        break;
      case 'arc': {
        const center = byId.get(entity.centerId) as { x: number; y: number };
        const start = byId.get(entity.startId) as { x: number; y: number };
        const end = byId.get(entity.endId) as { x: number; y: number };
        const derived = arcAngles(center, start, end);
        primitives.push({
          id: entity.id,
          type: 'arc',
          c_id: entity.centerId,
          start_id: entity.startId,
          end_id: entity.endId,
          radius: derived.radius,
          start_angle: derived.startAngle,
          end_angle: derived.endAngle,
        });
        // arc_rules keeps the arc's endpoints, angles and radius consistent.
        primitives.push({ id: `${entity.id}__rules`, type: 'arc_rules', a_id: entity.id });
        break;
      }
      case 'circle':
        primitives.push({
          id: entity.id,
          type: 'circle',
          c_id: entity.centerId,
          radius: entity.radiusMm,
        });
        break;
      default:
        return assertNever(entity);
    }
  }
  for (const c of sketch.constraints) {
    switch (c.kind) {
      case 'coincident':
        primitives.push({ id: c.id, type: 'p2p_coincident', p1_id: c.p1Id, p2_id: c.p2Id });
        break;
      case 'horizontal':
        primitives.push({ id: c.id, type: 'horizontal_l', l_id: c.lineId });
        break;
      case 'vertical':
        primitives.push({ id: c.id, type: 'vertical_l', l_id: c.lineId });
        break;
      case 'parallel':
        primitives.push({ id: c.id, type: 'parallel', l1_id: c.l1Id, l2_id: c.l2Id });
        break;
      case 'perpendicular':
        primitives.push({ id: c.id, type: 'perpendicular_ll', l1_id: c.l1Id, l2_id: c.l2Id });
        break;
      case 'tangent': {
        const a = byId.get(c.aId);
        const b = byId.get(c.bId);
        if (a === undefined || b === undefined) {
          return {
            status: 'failed',
            message: 'A tangent constraint refers to geometry that is not in the sketch.',
          };
        }
        // Normalize so a line, if present, is on the l side. Kind pairs map
        // onto PlaneGCS's typed tangency constraints.
        const [first, second] = a.kind === 'line' ? [a, b] : [b, a];
        if (first.kind === 'line' && second.kind === 'arc') {
          primitives.push({ id: c.id, type: 'tangent_la', l_id: first.id, a_id: second.id });
        } else if (first.kind === 'line' && second.kind === 'circle') {
          primitives.push({ id: c.id, type: 'tangent_lc', l_id: first.id, c_id: second.id });
        } else if (first.kind === 'arc' && second.kind === 'arc') {
          primitives.push({ id: c.id, type: 'tangent_aa', a1_id: first.id, a2_id: second.id });
        } else if (first.kind === 'circle' && second.kind === 'circle') {
          primitives.push({ id: c.id, type: 'tangent_cc', c1_id: first.id, c2_id: second.id });
        } else if (first.kind === 'circle' && second.kind === 'arc') {
          primitives.push({ id: c.id, type: 'tangent_ca', c_id: first.id, a_id: second.id });
        } else if (first.kind === 'arc' && second.kind === 'circle') {
          primitives.push({ id: c.id, type: 'tangent_ca', c_id: second.id, a_id: first.id });
        } else {
          return {
            status: 'failed',
            message: 'A tangent constraint needs an arc or circle on at least one side.',
          };
        }
        break;
      }
      case 'symmetric':
        primitives.push({
          id: c.id,
          type: 'p2p_symmetric_ppl',
          p1_id: c.p1Id,
          p2_id: c.p2Id,
          l_id: c.mirrorLineId,
        });
        break;
      case 'length': {
        const lineEntity = byId.get(c.lineId);
        if (lineEntity === undefined || lineEntity.kind !== 'line') {
          return {
            status: 'failed',
            message: 'A length dimension refers to a line that is not in the sketch.',
          };
        }
        primitives.push({
          id: c.id,
          type: 'p2p_distance',
          p1_id: lineEntity.p1Id,
          p2_id: lineEntity.p2Id,
          distance: c.mm,
        });
        break;
      }
      case 'distance':
        primitives.push({
          id: c.id,
          type: 'p2p_distance',
          p1_id: c.p1Id,
          p2_id: c.p2Id,
          distance: c.mm,
        });
        break;
      case 'radius':
      case 'diameter': {
        const target = byId.get(c.entityId);
        if (target === undefined || (target.kind !== 'arc' && target.kind !== 'circle')) {
          return {
            status: 'failed',
            message: 'A radius or diameter dimension needs an arc or a circle.',
          };
        }
        const radiusMm = c.kind === 'diameter' ? c.mm / 2 : c.mm;
        if (target.kind === 'arc') {
          primitives.push({ id: c.id, type: 'arc_radius', a_id: target.id, radius: radiusMm });
        } else {
          primitives.push({ id: c.id, type: 'circle_radius', c_id: target.id, radius: radiusMm });
        }
        break;
      }
      case 'angle':
        primitives.push({
          id: c.id,
          type: 'l2l_angle_ll',
          l1_id: c.l1Id,
          l2_id: c.l2Id,
          angle: (c.degrees * Math.PI) / 180,
        });
        break;
      default:
        return assertNever(c);
    }
  }
  if (drag !== undefined) {
    primitives.push({ id: DRAG_POINT_ID, type: 'point', x: drag.xMm, y: drag.yMm, fixed: true });
    primitives.push({
      id: DRAG_CONSTRAINT_ID,
      type: 'p2p_coincident',
      p1_id: drag.pointId,
      p2_id: DRAG_POINT_ID,
      temporary: true,
    });
  }

  wrapper.clear_data();
  wrapper.push_primitives_and_params(
    primitives as Parameters<GcsWrapper['push_primitives_and_params']>[0],
  );
  const status = wrapper.solve();
  const userConstraintIds = new Set(sketch.constraints.map((c) => c.id));
  if (wrapper.has_gcs_conflicting_constraints()) {
    const offending = wrapper
      .get_gcs_conflicting_constraints()
      .filter((id) => userConstraintIds.has(id));
    if (offending.length > 0) {
      return { status: 'conflicting', conflictingConstraintIds: offending };
    }
  }
  if (status !== SOLVE_SUCCESS && status !== SOLVE_CONVERGED) {
    return {
      status: 'failed',
      message:
        'The sketch could not be solved from its current positions. Move the geometry closer to the intended shape and try again.',
    };
  }
  wrapper.apply_solution();
  const dof = wrapper.gcs.dof();
  const solved = cloneSketch(sketch);
  for (const entity of solved.entities) {
    switch (entity.kind) {
      case 'point': {
        const p = wrapper.sketch_index.get_primitive_or_fail(entity.id) as unknown as {
          x: number;
          y: number;
        };
        entity.x = p.x;
        entity.y = p.y;
        break;
      }
      case 'circle': {
        const circle = wrapper.sketch_index.get_primitive_or_fail(entity.id) as unknown as {
          radius: number;
        };
        entity.radiusMm = circle.radius;
        break;
      }
      case 'line':
      case 'arc':
        // Lines and arcs are fully determined by their points; arcs also by
        // arc_rules, which keeps endpoints authoritative.
        break;
      default:
        return assertNever(entity);
    }
  }
  return { status: 'solved', sketch: solved, dof };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sketch/solve.spec.ts`
Expected: PASS. If the conflict test reports `conflicting` ids that include the internal `__rules` ids, that is a bug in the filter; only ids present in `sketch.constraints` may be returned. If the dof assertion is off by the drag point's params, verify the drag point is pushed with `fixed: true` (fixed points add no params).

- [ ] **Step 5: Commit**

```bash
git add src/engine/sketch/solve.ts tests/sketch/solve.spec.ts
git commit -m "Add the PlaneGCS solver adapter with dof, conflict and drag support."
```

---

### Task 4: Profile extraction (profile.ts) and the shared outline tolerance

**Files:**
- Modify: `web/src/engine/trace/contour.ts` (export the tolerance; currently the private `DEFAULT_TOLERANCE_MM = 0.2` at line 64)
- Create: `web/src/engine/sketch/profile.ts`
- Test: `web/tests/sketch/profile.spec.ts`

**Interfaces:**
- Consumes: `Sketch`, `SketchEntity` from Task 2; `TracedOutline`, `MmPoint` from `web/src/engine/trace/types.ts`; `assertNever` from `web/src/engine/plan/types.ts`.
- Produces: `OUTLINE_TOLERANCE_MM` exported from `web/src/engine/trace/contour.ts`; `extractProfile(sketch): ProfileResult` and `ProfileResult` from `web/src/engine/sketch/profile.ts`, used by Tasks 7 and 10.

- [ ] **Step 1: Export the trace tolerance from its existing home**

In `web/src/engine/trace/contour.ts`, replace the private constant (line 64):

```typescript
const DEFAULT_TOLERANCE_MM = 0.2;
```

with an exported one, keeping the existing default wiring:

```typescript
/**
 * Polygon simplification and arc flattening tolerance in mm, shared by the
 * photo trace (approxPolyDP epsilon) and the sketch profile extraction, so a
 * sketched outline and a traced outline are faithful to the same figure.
 */
export const OUTLINE_TOLERANCE_MM = 0.2;
```

and update the one usage at line 177 from `options.toleranceMm ?? DEFAULT_TOLERANCE_MM` to `options.toleranceMm ?? OUTLINE_TOLERANCE_MM`.

- [ ] **Step 2: Write the failing tests**

Create `web/tests/sketch/profile.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { SKETCH_SCHEMA_VERSION, type Sketch } from '../../src/engine/sketch/model';
import { extractProfile } from '../../src/engine/sketch/profile';
import { OUTLINE_TOLERANCE_MM } from '../../src/engine/trace/contour';
import type { MmPoint } from '../../src/engine/trace/types';

function point(id: string, x: number, y: number, construction = false) {
  return { kind: 'point' as const, id, x, y, construction };
}
function line(id: string, p1Id: string, p2Id: string, construction = false) {
  return { kind: 'line' as const, id, p1Id, p2Id, construction };
}
function sketchOf(entities: Sketch['entities'], constraints: Sketch['constraints'] = []): Sketch {
  return { schemaVersion: SKETCH_SCHEMA_VERSION, entities, constraints };
}

function shoelace(loop: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

describe('extractProfile', () => {
  it('extracts a closed rectangle as a positive-area outer loop', () => {
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 30, 0),
        point('pC', 30, 20),
        point('pD', 0, 20),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
        line('l3', 'pC', 'pD'),
        line('l4', 'pD', 'pA'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.holes).toEqual([]);
    expect(result.outline.outer).toHaveLength(4);
    expect(shoelace(result.outline.outer)).toBeGreaterThan(0);
    expect(Math.abs(shoelace(result.outline.outer))).toBeCloseTo(600, 6);
  });

  it('closes a chain through coincident constraints between distinct points', () => {
    const result = extractProfile(
      sketchOf(
        [
          point('pA', 0, 0),
          point('pB', 30, 0),
          point('pC', 30, 20),
          point('pD', 0, 20),
          point('pA2', 0, 0),
          line('l1', 'pA', 'pB'),
          line('l2', 'pB', 'pC'),
          line('l3', 'pC', 'pD'),
          line('l4', 'pD', 'pA2'),
        ],
        [{ kind: 'coincident', id: 'cW', p1Id: 'pA', p2Id: 'pA2' }],
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('flattens a standalone circle within the shared tolerance', () => {
    const result = extractProfile(
      sketchOf([
        point('pc', 5, 5),
        { kind: 'circle', id: 'c1', centerId: 'pc', radiusMm: 12, construction: false },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.holes).toEqual([]);
    for (const p of result.outline.outer) {
      expect(Math.hypot(p.x - 5, p.y - 5)).toBeCloseTo(12, 9);
    }
    // Chord sagitta stays within the shared trace tolerance.
    const pts = result.outline.outer;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const midDist = Math.hypot((a.x + b.x) / 2 - 5, (a.y + b.y) / 2 - 5);
      expect(12 - midDist).toBeLessThanOrEqual(OUTLINE_TOLERANCE_MM + 1e-9);
    }
  });

  it('flattens arcs in a chain', () => {
    // A 20 wide stadium-ish profile: bottom line, right semicircular arc,
    // top line, left semicircular arc (all counterclockwise in y-down mm).
    const result = extractProfile(
      sketchOf([
        point('p1', 0, 0),
        point('p2', 20, 0),
        point('cR', 20, 5),
        point('p3', 20, 10),
        point('p4', 0, 10),
        point('cL', 0, 5),
        line('lB', 'p1', 'p2'),
        { kind: 'arc', id: 'aR', centerId: 'cR', startId: 'p2', endId: 'p3', construction: false },
        line('lT', 'p3', 'p4'),
        { kind: 'arc', id: 'aL', centerId: 'cL', startId: 'p4', endId: 'p1', construction: false },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.outer.length).toBeGreaterThan(8);
    // Area of a 20x10 rectangle plus a radius-5 disc, within flattening error.
    expect(Math.abs(shoelace(result.outline.outer))).toBeGreaterThan(270);
    expect(Math.abs(shoelace(result.outline.outer))).toBeLessThan(280);
  });

  it('rejects an open chain with a user-worded message', () => {
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 30, 0),
        point('pC', 30, 20),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The outline is not closed. Connect every line and arc end to end into one loop.',
    );
  });

  it('rejects a construction-only sketch', () => {
    const result = extractProfile(
      sketchOf([point('pA', 0, 0, true), point('pB', 10, 0, true), line('l1', 'pA', 'pB', true)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The sketch has only construction geometry. Draw the shape with regular lines, arcs or a circle.',
    );
  });

  it('rejects multiple disjoint loops', () => {
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 10, 0),
        point('pC', 5, 8),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
        line('l3', 'pC', 'pA'),
        point('qc', 40, 0),
        { kind: 'circle', id: 'c1', centerId: 'qc', radiusMm: 5, construction: false },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The sketch contains more than one separate shape. Keep exactly one closed outline.',
    );
  });

  it('rejects a self-intersecting outline', () => {
    // A bowtie: the two diagonals cross.
    const result = extractProfile(
      sketchOf([
        point('pA', 0, 0),
        point('pB', 10, 10),
        point('pC', 10, 0),
        point('pD', 0, 10),
        line('l1', 'pA', 'pB'),
        line('l2', 'pB', 'pC'),
        line('l3', 'pC', 'pD'),
        line('l4', 'pD', 'pA'),
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'The outline crosses itself. Adjust the shape so its boundary does not intersect.',
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/sketch/profile.spec.ts`
Expected: FAIL with "Cannot find module '../../src/engine/sketch/profile'".

- [ ] **Step 4: Implement profile.ts**

Create `web/src/engine/sketch/profile.ts`:

```typescript
// Extracts the closed outer loop of a solved sketch as the trace pipeline's
// outline type. Arcs and circles are flattened by the standard sagitta bound
// (segment angle chosen so the chord-to-arc deviation stays within the shared
// outline tolerance). Failures are user-worded messages the UI shows verbatim.
import type { MmPoint, TracedOutline } from '../trace/types';
import { OUTLINE_TOLERANCE_MM } from '../trace/contour';
import { assertNever } from '../plan/types';
import type { Sketch, SketchArc, SketchCircle, SketchEntity, SketchPoint } from './model';

export type ProfileResult =
  | { ok: true; outline: TracedOutline }
  | { ok: false; error: string };

const OPEN_CHAIN =
  'The outline is not closed. Connect every line and arc end to end into one loop.';
const SELF_INTERSECTING =
  'The outline crosses itself. Adjust the shape so its boundary does not intersect.';
const CONSTRUCTION_ONLY =
  'The sketch has only construction geometry. Draw the shape with regular lines, arcs or a circle.';
const MULTIPLE_LOOPS =
  'The sketch contains more than one separate shape. Keep exactly one closed outline.';

/**
 * Union-find over point ids: points joined by coincident constraints count
 * as the same chain node, matching what the solver enforces.
 */
class PointGroups {
  private parent = new Map<string, string>();

  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined || p === id) return p ?? id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Number of segments flattening an arc of the given radius and sweep. */
function segmentCount(radiusMm: number, sweepRad: number): number {
  // Sagitta bound: a chord spanning angle t deviates r * (1 - cos(t / 2)),
  // so the largest allowed step is 2 * acos(1 - tolerance / r).
  const ratio = 1 - OUTLINE_TOLERANCE_MM / Math.max(radiusMm, OUTLINE_TOLERANCE_MM);
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, ratio)));
  return Math.max(2, Math.ceil(sweepRad / Math.max(maxStep, 1e-6)));
}

/** Flattened arc points from start toward end, excluding the end point. */
function flattenArc(
  center: SketchPoint,
  start: SketchPoint,
  end: SketchPoint,
  reversed: boolean,
): MmPoint[] {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let a1 = Math.atan2(end.y - center.y, end.x - center.x);
  if (a1 <= a0) a1 += 2 * Math.PI; // stored arcs run counterclockwise start to end
  const from = reversed ? a1 : a0;
  const to = reversed ? a0 : a1;
  const n = segmentCount(radius, Math.abs(to - from));
  const points: MmPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = from + ((to - from) * i) / n;
    points.push({ x: center.x + radius * Math.cos(t), y: center.y + radius * Math.sin(t) });
  }
  return points;
}

/** Full-circle flattening, counterclockwise, closed implicitly. */
function flattenCircle(center: SketchPoint, radiusMm: number): MmPoint[] {
  const n = Math.max(8, segmentCount(radiusMm, 2 * Math.PI));
  const points: MmPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = (2 * Math.PI * i) / n;
    points.push({ x: center.x + radiusMm * Math.cos(t), y: center.y + radiusMm * Math.sin(t) });
  }
  return points;
}

function shoelaceArea(loop: MmPoint[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Proper (interior) intersection test of two segments, standard orientation test. */
function segmentsCross(a1: MmPoint, a2: MmPoint, b1: MmPoint, b2: MmPoint): boolean {
  const orient = (p: MmPoint, q: MmPoint, r: MmPoint): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function selfIntersects(loop: MmPoint[]): boolean {
  const n = loop.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // Skip adjacent segments (they share an endpoint by construction).
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(loop[i], loop[(i + 1) % n], loop[j], loop[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Extracts the single closed outer loop of the sketch's non-construction
 * geometry as a TracedOutline (positive shoelace area, no holes in v1). A
 * lone non-construction circle stands alone as the whole outline.
 */
export function extractProfile(sketch: Sketch): ProfileResult {
  const byId = new Map<string, SketchEntity>(sketch.entities.map((e) => [e.id, e]));
  const pointOf = (id: string): SketchPoint => byId.get(id) as SketchPoint;
  const curves = sketch.entities.filter(
    (e): e is Extract<SketchEntity, { kind: 'line' | 'arc' }> =>
      (e.kind === 'line' || e.kind === 'arc') && !e.construction,
  );
  const circles = sketch.entities.filter(
    (e): e is SketchCircle => e.kind === 'circle' && !e.construction,
  );
  if (curves.length === 0 && circles.length === 0) {
    return { ok: false, error: CONSTRUCTION_ONLY };
  }
  if (circles.length > 0) {
    if (circles.length > 1 || curves.length > 0) {
      return { ok: false, error: MULTIPLE_LOOPS };
    }
    const circle = circles[0];
    return {
      ok: true,
      outline: { outer: orientPositive(flattenCircle(pointOf(circle.centerId), circle.radiusMm)), holes: [] },
    };
  }
  // Merge endpoints joined by coincident constraints.
  const groups = new PointGroups();
  for (const c of sketch.constraints) {
    if (c.kind === 'coincident') groups.union(c.p1Id, c.p2Id);
  }
  const endsOf = (curve: (typeof curves)[number]): [string, string] => {
    switch (curve.kind) {
      case 'line':
        return [groups.find(curve.p1Id), groups.find(curve.p2Id)];
      case 'arc':
        return [groups.find(curve.startId), groups.find(curve.endId)];
      default:
        return assertNever(curve);
    }
  };
  // Every merged endpoint must join exactly two curves for one closed loop.
  const adjacency = new Map<string, { curve: (typeof curves)[number]; other: string }[]>();
  for (const curve of curves) {
    const [a, b] = endsOf(curve);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = adjacency.get(from) ?? [];
      list.push({ curve, other: to });
      adjacency.set(from, list);
    }
  }
  for (const list of adjacency.values()) {
    if (list.length !== 2) return { ok: false, error: OPEN_CHAIN };
  }
  // Walk the loop from the first curve; every curve must be visited once.
  const visited = new Set<string>();
  const loop: MmPoint[] = [];
  const startNode = endsOf(curves[0])[0];
  let node = startNode;
  let previousCurveId: string | null = null;
  for (;;) {
    const nextEdge = (adjacency.get(node) ?? []).find(
      (edge) => edge.curve.id !== previousCurveId && !visited.has(edge.curve.id),
    );
    if (nextEdge === undefined) break;
    const curve = nextEdge.curve;
    visited.add(curve.id);
    switch (curve.kind) {
      case 'line': {
        const from =
          groups.find(curve.p1Id) === node ? pointOf(curve.p1Id) : pointOf(curve.p2Id);
        loop.push({ x: from.x, y: from.y });
        break;
      }
      case 'arc': {
        const reversed = groups.find(curve.startId) !== node;
        loop.push(
          ...flattenArc(
            pointOf((curve as SketchArc).centerId),
            pointOf((curve as SketchArc).startId),
            pointOf((curve as SketchArc).endId),
            reversed,
          ),
        );
        break;
      }
      default:
        return assertNever(curve);
    }
    previousCurveId = curve.id;
    node = nextEdge.other;
    if (node === startNode) break;
  }
  if (visited.size !== curves.length) {
    return { ok: false, error: MULTIPLE_LOOPS };
  }
  if (node !== startNode || loop.length < 3) {
    return { ok: false, error: OPEN_CHAIN };
  }
  if (selfIntersects(loop)) {
    return { ok: false, error: SELF_INTERSECTING };
  }
  return { ok: true, outline: { outer: orientPositive(loop), holes: [] } };
}

/** Ensures positive shoelace area, the TracedOutline outer-loop convention. */
function orientPositive(loop: MmPoint[]): MmPoint[] {
  return shoelaceArea(loop) >= 0 ? loop : [...loop].reverse();
}
```

Note: `flattenArc` reversed traversal emits points from the arc's end back toward its start (excluding the destination point), which is exactly what the loop walk needs since each step pushes the segment's departure points and the next curve supplies the arrival point.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/sketch/profile.spec.ts tests/trace/contour.spec.ts`
Expected: PASS, including the untouched contour tests (only the constant was renamed and exported).

- [ ] **Step 6: Commit**

```bash
git add src/engine/trace/contour.ts src/engine/sketch/profile.ts tests/sketch/profile.spec.ts
git commit -m "Add sketch profile extraction sharing the trace outline tolerance."
```

---

### Task 5: Sketch worker and client

**Files:**
- Create: `web/src/worker/sketch.worker.ts`
- Create: `web/src/sketchClient.ts`

**Interfaces:**
- Consumes: `solveSketch`, `DragTarget`, `SketchSolveResult` from Task 3; `Sketch` from Task 2; `sanitizeForWorker` from `web/src/workerSanitize.ts`; Comlink.
- Produces: `solveSketchInWorker(sketch: Sketch, drag?: DragTarget): Promise<SketchSolveResult>` from `web/src/sketchClient.ts`, used by Task 7. No unit test: the worker cannot run under node (Comlink), matching the vision worker; the WASM itself is smoke-tested in Task 1 and the adapter in Task 3.

- [ ] **Step 1: Implement the worker**

Create `web/src/worker/sketch.worker.ts`:

```typescript
import * as Comlink from 'comlink';
import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs';
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { Sketch } from '../engine/sketch/model';
import { solveSketch, type DragTarget, type SketchSolveResult } from '../engine/sketch/solve';

// The sketch worker owns the PlaneGCS WASM so constraint solving never blocks
// the page or the geometry worker's carves, and the LGPL-licensed wasm ships
// as its own replaceable asset (the ?url import), following the manifold
// pattern in geometry.worker.ts.

let wrapperPromise: Promise<GcsWrapper> | null = null;

function getWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) {
    wrapperPromise = init_planegcs_module({ locateFile: () => wasmUrl }).then(
      (mod) => new GcsWrapper(new mod.GcsSystem()),
    );
  }
  return wrapperPromise;
}

const api = {
  /** Runs the constraint solver over a sketch; see solveSketch. */
  async solve(sketch: Sketch, drag?: DragTarget): Promise<SketchSolveResult> {
    const wrapper = await getWrapper();
    return solveSketch(wrapper, sketch, drag);
  },
};

export type SketchWorkerApi = typeof api;

Comlink.expose(api);
```

- [ ] **Step 2: Implement the client**

Create `web/src/sketchClient.ts`:

```typescript
import * as Comlink from 'comlink';
import type { SketchWorkerApi } from './worker/sketch.worker';
import type { Sketch } from './engine/sketch/model';
import type { DragTarget, SketchSolveResult } from './engine/sketch/solve';
import { sanitizeForWorker } from './workerSanitize';

// The only thing the UI calls for sketch solving, mirroring visionClient.ts.

let remote: Comlink.Remote<SketchWorkerApi> | null = null;

function getWorker(): Comlink.Remote<SketchWorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL('./worker/sketch.worker.ts', import.meta.url), {
      type: 'module',
    });
    remote = Comlink.wrap<SketchWorkerApi>(worker);
  }
  return remote;
}

/**
 * Solves a sketch in the sketch worker. Arguments cross the worker boundary,
 * so they are sanitized into plain structured-cloneable values here.
 */
export async function solveSketchInWorker(
  sketch: Sketch,
  drag?: DragTarget,
): Promise<SketchSolveResult> {
  const worker = getWorker();
  return worker.solve(
    sanitizeForWorker(sketch),
    drag === undefined ? undefined : sanitizeForWorker(drag),
  );
}
```

- [ ] **Step 3: Verify the build bundles the wasm as a separate asset**

Run: `npm run build`
Expected: build succeeds; `dist/assets/` contains a `planegcs-*.wasm` file separate from the JS chunks (the LGPL replaceable-asset requirement). If `vue-tsc` cannot type the `?url` import, add the line `/// <reference types="vite/client" />` is already provided by the project's env types; check `web/src/vite-env.d.ts` exists (it does for the manifold wasm import) and mirror whatever declaration `geometry.worker.ts` relies on.

- [ ] **Step 4: Commit**

```bash
git add src/worker/sketch.worker.ts src/sketchClient.ts
git commit -m "Add the sketch worker and client owning the PlaneGCS wasm."
```

---

### Task 6: Tool origin discriminator and plan file version 11

**Files:**
- Modify: `web/src/engine/trace/types.ts` (add `ToolSource`, add `source` to `TracedTool`)
- Modify: `web/src/engine/trace/layoutModel.ts` (`addTool` gains a source parameter; `TracedTool` literals gain `source`)
- Modify: `web/src/engine/plan/types.ts` (`PLAN_FILE_VERSION` 10 to 11, line 675)
- Modify: `web/src/engine/plan/planFile.ts` (`validatePockets` validates `source`, `pickPockets` picks and defaults it, version comment in `parsePlanFile`)
- Test: `web/tests/plan/planFile.spec.ts` (add cases), `web/tests/trace/layoutModel.spec.ts` (add case)

**Interfaces:**
- Consumes: `Sketch`, `validateSketch`, `deserializeSketch`, `cloneSketch` from Task 2.
- Produces: `ToolSource = { kind: 'photo' } | { kind: 'sketch'; sketch: Sketch }` and required `TracedTool.source`, used by Tasks 7, 8, 10. Plan files of version 11.

- [ ] **Step 1: Write the failing tests**

In `web/tests/plan/planFile.spec.ts`, add (adapt the existing helper the file uses for building a valid traced entry; the file already has fixtures for traced bins, follow its local naming):

```typescript
import { SKETCH_SCHEMA_VERSION } from '../../src/engine/sketch/model';

describe('plan version 11: pocket tool source', () => {
  it('defaults an absent source to photo on load', () => {
    const plan = writeAndReparseTracedEntry((tool) => {
      delete (tool as Record<string, unknown>).source;
    });
    const tool = firstPocketTool(plan);
    expect(tool.source).toEqual({ kind: 'photo' });
  });

  it('round-trips a sketch source', () => {
    const sketch = {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      entities: [
        { kind: 'point', id: 'pc', x: 0, y: 0, construction: false },
        { kind: 'circle', id: 'c1', centerId: 'pc', radiusMm: 12, construction: false },
      ],
      constraints: [],
    };
    const plan = writeAndReparseTracedEntry((tool) => {
      (tool as Record<string, unknown>).source = { kind: 'sketch', sketch };
    });
    const tool = firstPocketTool(plan);
    expect(tool.source.kind).toBe('sketch');
    if (tool.source.kind === 'sketch') expect(tool.source.sketch).toEqual(sketch);
  });

  it('rejects a sketch source with a broken sketch', () => {
    const result = parseTracedEntryWith((tool) => {
      (tool as Record<string, unknown>).source = { kind: 'sketch', sketch: { schemaVersion: 1 } };
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('entities must be a list');
    }
  });

  it('rejects an unknown source kind', () => {
    const result = parseTracedEntryWith((tool) => {
      (tool as Record<string, unknown>).source = { kind: 'scan' };
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('source must be a photo trace or a sketch');
    }
  });
});
```

Concrete instructions for the two helpers, since the implementer sees only this task: `writeAndReparseTracedEntry(mutate)` builds a valid plan with one traced entry the way the file's existing traced-bin tests do, runs `JSON.parse(JSON.stringify(plan))`, applies `mutate` to `raw.entries[0].product.bin.pockets.tools[0]`, calls `parsePlanFile` (the file's existing entry point, already imported at the top of the spec), asserts `ok` is true and returns the plan. `parseTracedEntryWith(mutate)` is the same but returns the raw `PlanParseResult` without asserting. `firstPocketTool(plan)` digs out `plan.entries[0]`'s bin pockets tool 0 through `binOf` as the existing tests do. Reuse the file's existing fixture builders rather than writing new ones if equivalents exist.

In `web/tests/trace/layoutModel.spec.ts`, add:

```typescript
it('stamps a new tool with the photo source by default', () => {
  const state = freshState(); // the file's existing empty LayoutState helper
  const tool = addTool(state, squareOutline(), 'Tool', 20);
  expect(tool.source).toEqual({ kind: 'photo' });
});
```

(where `freshState` and `squareOutline` are the spec file's existing helpers; use their actual names, they exist because every layoutModel test builds the same state).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/plan/planFile.spec.ts tests/trace/layoutModel.spec.ts`
Expected: FAIL: the plan tests fail on the missing `source` handling (absent field is currently dropped silently, so `tool.source` is `undefined`) and the layoutModel test fails with `source` being `undefined`. Type errors also surface once types change; that is Step 3.

- [ ] **Step 3: Implement the type and engine changes**

In `web/src/engine/trace/types.ts`, after the `TracedOutline` interface, add:

```typescript
import type { Sketch } from '../sketch/model';

/**
 * Where a tool's outline came from. A photo-traced tool is re-editable
 * through its stored clicks and photo; a sketched tool embeds its editable
 * Sketch so it can be reopened and changed later. Discriminated on kind and
 * always branched exhaustively (assertNever), mirroring Bin.origin.
 */
export type ToolSource = { kind: 'photo' } | { kind: 'sketch'; sketch: Sketch };
```

(place the `import type` with the file's imports; the file currently has none, so it becomes the first line) and add to `TracedTool` (after `fingerHoles`):

```typescript
  /** Where the outline came from: a photo trace or an embedded sketch. */
  source: ToolSource;
```

In `web/src/engine/trace/layoutModel.ts`:

- import the type: add `ToolSource` to the existing type import from `./types`;
- change `addTool`'s signature to append a parameter `source: ToolSource = { kind: 'photo' }` after `brushStrokes` and set `source` in the constructed `TracedTool` literal (after `fingerHoles: []`). `duplicateTool` needs no change: its JSON deep copy carries the source, including an embedded sketch.
- `replaceToolOutline` needs no change: re-tracing only applies to photo tools and does not alter the source.

In `web/src/stores/toolTrace.ts`, thread the parameter through the store's `addTool` (append `source: ToolSource = { kind: 'photo' }` to its parameters and pass it to `layout.addTool`); import `ToolSource` in the type import from `../engine/trace/types`.

Fix every remaining compile error where a `TracedTool` literal is constructed (search for `fingerHoles: []` and `fingerHoles: (` across `web/src`): each constructor site gains `source: { kind: 'photo' }` except `pickPockets`, handled next.

In `web/src/engine/plan/planFile.ts`:

- Import at the top:

```typescript
import { validateSketch, deserializeSketch, type Sketch } from '../sketch/model';
import type { ToolSource } from '../trace/types';
```

- In `validatePockets`, after the `fingerHoles` loop (before the closing of the per-tool loop), add:

```typescript
    // source was added in plan version 11; older plans omit it, so undefined
    // is accepted and defaulted to a photo trace on pick.
    if (tool.source !== undefined) {
      const source = tool.source as Record<string, unknown> | null;
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        return `${subject}: pocket tool ${tool.id}: The outline source must be an object.`;
      }
      if (source.kind === 'photo') {
        // A photo source carries no further fields.
      } else if (source.kind === 'sketch') {
        const sketchProblem = validateSketch(
          source.sketch,
          `${subject}: pocket tool ${tool.id}`,
        );
        if (sketchProblem !== null) return sketchProblem;
      } else {
        return `${subject}: pocket tool ${tool.id}: The outline source must be a photo trace or a sketch.`;
      }
    }
```

- In `pickPockets`, add to the returned tool literal (after `fingerHoles`):

```typescript
      source: pickToolSource(tool.source),
```

and add next to `pickPockets`:

```typescript
/**
 * Copies a validated tool source; absent (pre-version-11) means the tool was
 * photo-traced, which is what every earlier plan's tools were.
 */
function pickToolSource(raw: unknown): ToolSource {
  if (raw === undefined) return { kind: 'photo' };
  const source = raw as Record<string, unknown>;
  if (source.kind === 'sketch') {
    const parsed = deserializeSketch(source.sketch);
    if (!parsed.ok) {
      // validatePockets already proved the sketch valid; reaching here is a
      // programming error, not a user problem.
      throw new Error(`A validated sketch failed to deserialize: ${parsed.error}`);
    }
    return { kind: 'sketch', sketch: parsed.sketch };
  }
  return { kind: 'photo' };
}
```

- In `web/src/engine/plan/types.ts` line 675, change `export const PLAN_FILE_VERSION = 10;` to `export const PLAN_FILE_VERSION = 11;`.
- In `parsePlanFile`'s version-history comment block (planFile.ts around lines 1875-1885), append one sentence: `Version 11 adds the outline source on pocket tools (photo trace or embedded sketch), absent in earlier versions and defaulted to a photo trace on pick.`

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/plan tests/trace tests/stores && npx vue-tsc --noEmit`
Expected: PASS with no type errors. The typecheck is the enforcement that every `TracedTool` construction site got its `source`.

- [ ] **Step 5: Commit**

```bash
git add src/engine/trace/types.ts src/engine/trace/layoutModel.ts src/stores/toolTrace.ts src/engine/plan/types.ts src/engine/plan/planFile.ts tests/plan/planFile.spec.ts tests/trace/layoutModel.spec.ts
git commit -m "Add the tool outline source discriminator and plan version 11."
```

---

### Task 7: Sketch editor store

**Files:**
- Create: `web/src/stores/sketchEditor.ts`
- Test: `web/tests/stores/sketchEditor.spec.ts`

**Interfaces:**
- Consumes: `emptySketch`, `cloneSketch`, `arcFromThreePoints`, `Sketch`, `SketchEntity`, `SketchConstraint`, `SketchDimension` from Task 2; `solveSketchInWorker` from Task 5 (mocked in tests); `extractProfile` from Task 4; `SketchSolveResult`, `DragTarget` from Task 3.
- Produces: the `useSketchEditor` Pinia store used by Tasks 8, 9, 10 with the state and actions shown below.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/stores/sketchEditor.spec.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const solveMock = vi.fn();
vi.mock('../../src/sketchClient', () => ({
  solveSketchInWorker: (...args: unknown[]) => solveMock(...args),
}));

import { useSketchEditor } from '../../src/stores/sketchEditor';

beforeEach(() => {
  setActivePinia(createPinia());
  solveMock.mockReset();
  solveMock.mockImplementation(async (sketch) => ({ status: 'solved', sketch, dof: 4 }));
});

describe('useSketchEditor', () => {
  it('starts empty and adds a line chain sharing intermediate points', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const first = editor.appendChainPoint({ x: 0, y: 0 });
    const second = editor.appendChainPoint({ x: 30, y: 0 });
    const third = editor.appendChainPoint({ x: 30, y: 20 });
    expect(first).not.toBeNull();
    const lines = editor.sketch.entities.filter((e) => e.kind === 'line');
    const points = editor.sketch.entities.filter((e) => e.kind === 'point');
    expect(lines).toHaveLength(2);
    expect(points).toHaveLength(3);
    // Chained lines share the middle point instead of duplicating it.
    expect((lines[0] as { p2Id: string }).p2Id).toBe((lines[1] as { p1Id: string }).p1Id);
    expect(second).toBe((lines[1] as { p1Id: string }).p1Id);
    expect(third).toBe((lines[1] as { p2Id: string }).p2Id);
  });

  it('closes the chain onto its first point when finishing at it', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    const first = editor.appendChainPoint({ x: 0, y: 0 })!;
    editor.appendChainPoint({ x: 30, y: 0 });
    editor.appendChainPoint({ x: 30, y: 20 });
    editor.closeChainTo(first);
    const lines = editor.sketch.entities.filter((e) => e.kind === 'line');
    expect(lines).toHaveLength(3);
    expect((lines[2] as { p2Id: string }).p2Id).toBe(first);
  });

  it('adds a circle with center and radius', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.addCircle({ x: 10, y: 10 }, 12.5);
    const circle = editor.sketch.entities.find((e) => e.kind === 'circle');
    expect(circle).toBeDefined();
    expect((circle as { radiusMm: number }).radiusMm).toBeCloseTo(12.5);
  });

  it('adds a dimension and solves after the edit', async () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 28, y: 3 });
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    editor.addDimension({ kind: 'length', id: editor.nextId(), lineId: line.id, mm: 30 });
    await editor.solveNow();
    expect(solveMock).toHaveBeenCalled();
    expect(editor.solveState.status).toBe('solved');
  });

  it('keeps the conflicting constraint ids for the diagnostics rows', async () => {
    solveMock.mockResolvedValue({ status: 'conflicting', conflictingConstraintIds: ['cX'] });
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 10, y: 0 });
    await editor.solveNow();
    expect(editor.solveState.status).toBe('conflicting');
    if (editor.solveState.status === 'conflicting') {
      expect(editor.solveState.conflictingConstraintIds).toEqual(['cX']);
    }
  });

  it('toggles the construction flag on a selected entity', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.appendChainPoint({ x: 0, y: 0 });
    editor.appendChainPoint({ x: 10, y: 0 });
    const line = editor.sketch.entities.find((e) => e.kind === 'line')!;
    editor.toggleConstruction(line.id);
    expect(line.construction).toBe(true);
  });

  it('loads an existing sketch for editing a sketched tool', () => {
    const editor = useSketchEditor();
    editor.startNewSketch();
    editor.addCircle({ x: 0, y: 0 }, 5);
    const saved = JSON.parse(JSON.stringify(editor.sketch));
    editor.startNewSketch();
    expect(editor.sketch.entities).toHaveLength(0);
    editor.loadSketch(saved, 'tool-1');
    expect(editor.sketch.entities).toHaveLength(2);
    expect(editor.editingToolId).toBe('tool-1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/stores/sketchEditor.spec.ts`
Expected: FAIL with "Cannot find module '../../src/stores/sketchEditor'".

- [ ] **Step 3: Implement the store**

Create `web/src/stores/sketchEditor.ts`:

```typescript
import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import {
  arcFromThreePoints,
  cloneSketch,
  emptySketch,
  type Sketch,
  type SketchConstraint,
  type SketchDimension,
} from '../engine/sketch/model';
import type { DragTarget, SketchSolveResult } from '../engine/sketch/solve';
import type { MmPoint } from '../engine/trace/types';
import { solveSketchInWorker } from '../sketchClient';

/** The drawing tool active on the sketch canvas. */
export type SketchTool =
  | 'select'
  | 'line'
  | 'arcThreePoint'
  | 'arcTangent'
  | 'circle'
  | 'mirror'
  | 'dimension';

/** Solver state shown on the canvas; idle before the first run. */
export type SolveState =
  | { status: 'idle' }
  | SketchSolveResult;

/**
 * State of the sketch workspace inside the Tool trace tab. All geometry
 * mutations edit the Sketch (engine data); the canvas only renders it. Every
 * mutation marks the sketch dirty and the workspace schedules a solve; the
 * store never solves implicitly so tests stay deterministic.
 */
export const useSketchEditor = defineStore('sketchEditor', () => {
  const sketch = ref<Sketch>(emptySketch());
  const activeTool = ref<SketchTool>('select');
  const selectedIds = ref<string[]>([]);
  const solveState = shallowRef<SolveState>({ status: 'idle' });
  /** Id of the sketched tool being re-edited, or null for a new shape. */
  const editingToolId = ref<string | null>(null);
  /** The open line/arc chain's last point id, or null when no chain is open. */
  const chainTailId = ref<string | null>(null);
  /** Photo underlay: display only, never enters geometry. */
  const underlayUrl = ref<string | null>(null);
  const underlayOpacityPct = ref(40);
  /** Millimeters per underlay image pixel from the calibration line, or null. */
  const underlayMmPerPixel = ref<number | null>(null);

  let idCounter = 0;
  /** Sketch-unique id; sequential so saved sketches diff readably. */
  function nextId(): string {
    idCounter += 1;
    return `s${idCounter}`;
  }

  function startNewSketch(): void {
    sketch.value = emptySketch();
    activeTool.value = 'select';
    selectedIds.value = [];
    solveState.value = { status: 'idle' };
    editingToolId.value = null;
    chainTailId.value = null;
    underlayUrl.value = null;
    underlayOpacityPct.value = 40;
    underlayMmPerPixel.value = null;
    idCounter = 0;
  }

  /** Opens an existing sketch (deep-copied) for editing a sketched tool. */
  function loadSketch(source: Sketch, toolId: string): void {
    startNewSketch();
    sketch.value = cloneSketch(source);
    editingToolId.value = toolId;
    // Continue id numbering above any existing s<N> ids.
    for (const entity of sketch.value.entities) {
      const match = /^s(\d+)$/.exec(entity.id);
      if (match) idCounter = Math.max(idCounter, Number(match[1]));
    }
    for (const constraint of sketch.value.constraints) {
      const match = /^s(\d+)$/.exec(constraint.id);
      if (match) idCounter = Math.max(idCounter, Number(match[1]));
    }
  }

  function addPoint(at: MmPoint, construction = false): string {
    const id = nextId();
    sketch.value.entities.push({ kind: 'point', id, x: at.x, y: at.y, construction });
    return id;
  }

  /**
   * Appends a point to the open line chain, creating a line from the chain
   * tail when one exists. Returns the new point id.
   */
  function appendChainPoint(at: MmPoint): string | null {
    const pointId = addPoint(at);
    if (chainTailId.value !== null) {
      sketch.value.entities.push({
        kind: 'line',
        id: nextId(),
        p1Id: chainTailId.value,
        p2Id: pointId,
        construction: false,
      });
    }
    chainTailId.value = pointId;
    return pointId;
  }

  /** Closes the open chain onto an existing point and ends the chain. */
  function closeChainTo(pointId: string): void {
    if (chainTailId.value === null || chainTailId.value === pointId) return;
    sketch.value.entities.push({
      kind: 'line',
      id: nextId(),
      p1Id: chainTailId.value,
      p2Id: pointId,
      construction: false,
    });
    chainTailId.value = null;
  }

  /** Ends the open chain without closing it. */
  function endChain(): void {
    chainTailId.value = null;
  }

  function addCircle(center: MmPoint, radiusMm: number): void {
    const centerId = addPoint(center);
    sketch.value.entities.push({
      kind: 'circle',
      id: nextId(),
      centerId,
      radiusMm,
      construction: false,
    });
  }

  /**
   * Adds a three-point arc. Point order start, end, then a point the arc
   * passes through, matching the canvas tool. Returns false for collinear
   * picks, which the workspace reports as a status row.
   */
  function addThreePointArc(start: MmPoint, end: MmPoint, through: MmPoint): boolean {
    const derived = arcFromThreePoints(start, through, end);
    if (derived === null) return false;
    const centerId = addPoint(derived.center);
    const startId = addPoint(start);
    const endId = addPoint(end);
    // The stored arc always runs counterclockwise from start to end; a
    // clockwise pick stores the endpoints swapped.
    sketch.value.entities.push({
      kind: 'arc',
      id: nextId(),
      centerId,
      startId: derived.ccw ? startId : endId,
      endId: derived.ccw ? endId : startId,
      construction: false,
    });
    return true;
  }

  /**
   * Adds a mirror (construction) line plus a symmetric constraint between two
   * selected points, the spec's mirror-line workflow.
   */
  function addMirrorLine(a: MmPoint, b: MmPoint): string {
    const p1 = addPoint(a, true);
    const p2 = addPoint(b, true);
    const lineId = nextId();
    sketch.value.entities.push({
      kind: 'line',
      id: lineId,
      p1Id: p1,
      p2Id: p2,
      construction: true,
    });
    return lineId;
  }

  function addConstraint(constraint: SketchConstraint): void {
    sketch.value.constraints.push(constraint);
  }

  function addDimension(dimension: SketchDimension): void {
    sketch.value.constraints.push(dimension);
  }

  /** Rewrites a dimension's value in place (click-to-edit label). */
  function setDimensionValue(constraintId: string, value: number): void {
    const dimension = sketch.value.constraints.find((c) => c.id === constraintId);
    if (dimension === undefined) return;
    switch (dimension.kind) {
      case 'length':
      case 'distance':
      case 'radius':
      case 'diameter':
        dimension.mm = value;
        break;
      case 'angle':
        dimension.degrees = value;
        break;
      case 'coincident':
      case 'horizontal':
      case 'vertical':
      case 'parallel':
      case 'perpendicular':
      case 'tangent':
      case 'symmetric':
        // Not dimensions; nothing to edit.
        break;
      default: {
        const exhaustive: never = dimension;
        throw new Error(`Unhandled constraint kind: ${String(exhaustive)}`);
      }
    }
  }

  function removeConstraint(constraintId: string): void {
    sketch.value.constraints = sketch.value.constraints.filter((c) => c.id !== constraintId);
  }

  function toggleConstruction(entityId: string): void {
    const entity = sketch.value.entities.find((e) => e.id === entityId);
    if (entity === undefined) return;
    entity.construction = !entity.construction;
  }

  /**
   * Runs the solver in the sketch worker over the current sketch, writing
   * solved coordinates back on success. With a drag target this is the
   * driven-point workflow used while a point is dragged.
   */
  async function solveNow(drag?: DragTarget): Promise<void> {
    const result = await solveSketchInWorker(
      JSON.parse(JSON.stringify(sketch.value)) as Sketch,
      drag,
    );
    solveState.value = result;
    if (result.status === 'solved') {
      sketch.value = result.sketch;
    }
  }

  return {
    sketch,
    activeTool,
    selectedIds,
    solveState,
    editingToolId,
    chainTailId,
    underlayUrl,
    underlayOpacityPct,
    underlayMmPerPixel,
    nextId,
    startNewSketch,
    loadSketch,
    addPoint,
    appendChainPoint,
    closeChainTo,
    endChain,
    addCircle,
    addThreePointArc,
    addMirrorLine,
    addConstraint,
    addDimension,
    setDimensionValue,
    removeConstraint,
    toggleConstruction,
    solveNow,
  };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/stores/sketchEditor.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/sketchEditor.ts tests/stores/sketchEditor.spec.ts
git commit -m "Add the sketch editor store."
```

---

### Task 8: Sketch canvas and workspace, input toggle

The repo has no component tests (no `@vue/test-utils` anywhere under `web/tests`), so this UI task carries no new spec files; the engine behavior underneath is already tested. Verification is the typecheck plus the build.

**Files:**
- Create: `web/src/components/trace/sketch/SketchCanvas.vue`
- Create: `web/src/components/trace/sketch/SketchWorkspace.vue`
- Modify: `web/src/components/trace/TraceTab.vue` (input toggle on stage 1)

**Interfaces:**
- Consumes: `useSketchEditor` (Task 7), `Sketch` types (Task 2), `viewTransform` helpers from `web/src/components/trace/viewTransform.ts` (`ViewTransform`, `zoomToCursor`, `screenToImage`).
- Produces: `SketchWorkspace.vue` emitting `finish` (handled in Task 10) and `cancel`; a `traceInput` toggle (`'photo' | 'sketch'`) in `TraceTab.vue`.

- [ ] **Step 1: Implement SketchCanvas.vue**

Create `web/src/components/trace/sketch/SketchCanvas.vue`. The canvas is an SVG in mm coordinates: the `viewBox` derives from a pan/zoom `ViewTransform` reused from the trace canvas math (`zoomToCursor`, `screenToImage`), with a 10 mm grid, an entity layer, a dimension-label layer and an optional underlay image. All geometry lives in the store's `Sketch`; the canvas renders and forwards pointer events.

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor } from '../../../stores/sketchEditor';
import {
  screenToImage,
  zoomToCursor,
  type ViewTransform,
} from '../viewTransform';
import { assertNever } from '../../../engine/plan/types';
import type { MmPoint } from '../../../engine/trace/types';
import type { SketchEntity } from '../../../engine/sketch/model';

const emit = defineEmits<{
  /** A canvas click in mm, for the active drawing tool. */
  (e: 'canvasClick', at: MmPoint, hitPointId: string | null): void;
  /** A drag of an existing point to a new mm position (driven point). */
  (e: 'pointDrag', pointId: string, at: MmPoint): void;
  (e: 'pointDragEnd'): void;
  /** A click on a dimension label, for click-to-edit. */
  (e: 'dimensionClick', constraintId: string, at: MmPoint): void;
  (e: 'entityClick', entityId: string): void;
}>();

const editor = useSketchEditor();
const { sketch, solveState, selectedIds, underlayUrl, underlayOpacityPct, underlayMmPerPixel } =
  storeToRefs(editor);

const svgEl = ref<SVGSVGElement | null>(null);
/** Pan/zoom over a fixed 200 mm design window; same math as the trace canvas. */
const WINDOW_MM = 200;
const view = ref<ViewTransform>({ zoom: 1, panX: 0, panY: 0 });

const viewBox = computed(() => {
  const size = WINDOW_MM / view.value.zoom;
  const minX = -view.value.panX / view.value.zoom - size / 4;
  const minY = -view.value.panY / view.value.zoom - size / 4;
  return `${minX} ${minY} ${size} ${size}`;
});

/** Grid lines every 10 mm across the visible window. */
const gridLines = computed(() => {
  const size = WINDOW_MM / view.value.zoom;
  const minX = -view.value.panX / view.value.zoom - size / 4;
  const minY = -view.value.panY / view.value.zoom - size / 4;
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const start = (v: number) => Math.floor(v / 10) * 10;
  for (let x = start(minX); x <= minX + size; x += 10) {
    lines.push({ x1: x, y1: minY, x2: x, y2: minY + size });
  }
  for (let y = start(minY); y <= minY + size; y += 10) {
    lines.push({ x1: minX, y1: y, x2: minX + size, y2: y });
  }
  return lines;
});

function clientToMm(event: PointerEvent | WheelEvent): MmPoint {
  const svg = svgEl.value!;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const mm = point.matrixTransform(svg.getScreenCTM()!.inverse());
  return { x: mm.x, y: mm.y };
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
  const anchorMm = clientToMm(event);
  const next = zoomToCursor(
    view.value,
    view.value.zoom * factor,
    { x: anchorMm.x * view.value.zoom + view.value.panX, y: anchorMm.y * view.value.zoom + view.value.panY },
    WINDOW_MM,
    WINDOW_MM,
  );
  view.value = next;
}

const points = computed(() =>
  sketch.value.entities.filter((e): e is Extract<SketchEntity, { kind: 'point' }> => e.kind === 'point'),
);
const pointById = computed(() => new Map(points.value.map((p) => [p.id, p])));

/** SVG path data of every non-point entity, keyed by entity id. */
const entityPaths = computed(() =>
  sketch.value.entities
    .filter((e) => e.kind !== 'point')
    .map((entity) => {
      switch (entity.kind) {
        case 'line': {
          const a = pointById.value.get(entity.p1Id)!;
          const b = pointById.value.get(entity.p2Id)!;
          return { entity, d: `M ${a.x} ${a.y} L ${b.x} ${b.y}` };
        }
        case 'arc': {
          const c = pointById.value.get(entity.centerId)!;
          const s = pointById.value.get(entity.startId)!;
          const e2 = pointById.value.get(entity.endId)!;
          const r = Math.hypot(s.x - c.x, s.y - c.y);
          const a0 = Math.atan2(s.y - c.y, s.x - c.x);
          let a1 = Math.atan2(e2.y - c.y, e2.x - c.x);
          if (a1 <= a0) a1 += 2 * Math.PI;
          const largeArc = a1 - a0 > Math.PI ? 1 : 0;
          return { entity, d: `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e2.x} ${e2.y}` };
        }
        case 'circle': {
          const c = pointById.value.get(entity.centerId)!;
          return {
            entity,
            d:
              `M ${c.x + entity.radiusMm} ${c.y} ` +
              `A ${entity.radiusMm} ${entity.radiusMm} 0 1 1 ${c.x - entity.radiusMm} ${c.y} ` +
              `A ${entity.radiusMm} ${entity.radiusMm} 0 1 1 ${c.x + entity.radiusMm} ${c.y}`,
          };
        }
        case 'point':
          throw new Error('points are rendered separately');
        default:
          return assertNever(entity);
      }
    }),
);

/**
 * Stroke color by solver state: fully constrained geometry green, movable
 * (under-constrained) geometry blue, conflicting sketches red. The solver
 * reports dof for the whole sketch, so the color applies sketch-wide.
 */
function strokeOf(entity: SketchEntity): string {
  if (selectedIds.value.includes(entity.id)) return '#ff9800';
  if (entity.kind !== 'point' && entity.construction) return '#9e9e9e';
  const state = solveState.value;
  if (state.status === 'conflicting' || state.status === 'failed') return '#e53935';
  if (state.status === 'solved' && state.dof === 0) return '#2e7d32';
  return '#1e88e5';
}

const draggingPointId = ref<string | null>(null);

function onPointerDown(event: PointerEvent): void {
  const at = clientToMm(event);
  const hit = hitPoint(at);
  if (editor.activeTool === 'select' && hit !== null) {
    draggingPointId.value = hit;
    (event.target as Element).setPointerCapture(event.pointerId);
    return;
  }
  emit('canvasClick', at, hit);
}

function onPointerMove(event: PointerEvent): void {
  if (draggingPointId.value === null) return;
  emit('pointDrag', draggingPointId.value, clientToMm(event));
}

function onPointerUp(): void {
  if (draggingPointId.value !== null) {
    draggingPointId.value = null;
    emit('pointDragEnd');
  }
}

/** The point id within a 2 mm (screen-scaled) pick radius, or null. */
function hitPoint(at: MmPoint): string | null {
  const radius = 2 / view.value.zoom;
  for (const p of points.value) {
    if (Math.hypot(p.x - at.x, p.y - at.y) <= radius) return p.id;
  }
  return null;
}

/** Anchor position of a dimension label, midway along its geometry. */
const dimensionLabels = computed(() =>
  sketch.value.constraints
    .map((c) => {
      switch (c.kind) {
        case 'length': {
          const line = sketch.value.entities.find((e) => e.id === c.lineId);
          if (line === undefined || line.kind !== 'line') return null;
          const a = pointById.value.get(line.p1Id)!;
          const b = pointById.value.get(line.p2Id)!;
          return { id: c.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${c.mm} mm` };
        }
        case 'distance': {
          const a = pointById.value.get(c.p1Id)!;
          const b = pointById.value.get(c.p2Id)!;
          return { id: c.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${c.mm} mm` };
        }
        case 'radius':
        case 'diameter': {
          const entity = sketch.value.entities.find((e) => e.id === c.entityId);
          if (entity === undefined || (entity.kind !== 'arc' && entity.kind !== 'circle')) return null;
          const center = pointById.value.get(entity.centerId)!;
          const prefix = c.kind === 'radius' ? 'R' : 'D';
          return { id: c.id, x: center.x, y: center.y, text: `${prefix} ${c.mm} mm` };
        }
        case 'angle': {
          const line = sketch.value.entities.find((e) => e.id === c.l1Id);
          if (line === undefined || line.kind !== 'line') return null;
          const a = pointById.value.get(line.p1Id)!;
          return { id: c.id, x: a.x, y: a.y, text: `${c.degrees} deg` };
        }
        case 'coincident':
        case 'horizontal':
        case 'vertical':
        case 'parallel':
        case 'perpendicular':
        case 'tangent':
        case 'symmetric':
          return null;
        default:
          return assertNever(c);
      }
    })
    .filter((label): label is NonNullable<typeof label> => label !== null),
);
</script>

<template>
  <svg
    ref="svgEl"
    class="sketch-canvas"
    :viewBox="viewBox"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  >
    <image
      v-if="underlayUrl !== null && underlayMmPerPixel !== null"
      :href="underlayUrl"
      x="0"
      y="0"
      :opacity="underlayOpacityPct / 100"
      :style="{ transform: `scale(${underlayMmPerPixel})` }"
    />
    <g class="grid">
      <line
        v-for="(g, i) in gridLines"
        :key="i"
        :x1="g.x1"
        :y1="g.y1"
        :x2="g.x2"
        :y2="g.y2"
        stroke="#e0e0e0"
        stroke-width="0.15"
      />
    </g>
    <g class="entities">
      <path
        v-for="{ entity, d } in entityPaths"
        :key="entity.id"
        :d="d"
        fill="none"
        :stroke="strokeOf(entity)"
        :stroke-width="0.6"
        :stroke-dasharray="entity.kind !== 'point' && entity.construction ? '1.5 1' : undefined"
        @click.stop="emit('entityClick', entity.id)"
      />
      <circle
        v-for="p in points"
        :key="p.id"
        :cx="p.x"
        :cy="p.y"
        r="0.9"
        :fill="strokeOf(p)"
      />
    </g>
    <g class="dimensions">
      <text
        v-for="label in dimensionLabels"
        :key="label.id"
        :x="label.x"
        :y="label.y - 1.5"
        font-size="3"
        text-anchor="middle"
        fill="#6a1b9a"
        style="cursor: pointer"
        @click.stop="emit('dimensionClick', label.id, { x: label.x, y: label.y })"
      >
        {{ label.text }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.sketch-canvas {
  width: 100%;
  height: 100%;
  touch-action: none;
  background: #fafafa;
}
</style>
```

- [ ] **Step 2: Implement SketchWorkspace.vue**

Create `web/src/components/trace/sketch/SketchWorkspace.vue`: the toolbar, the tool state machine over canvas clicks, the solver scheduling, and the finish/cancel buttons. The dimension input and status rows are extended in Task 9; this step wires the drawing tools.

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSketchEditor, type SketchTool } from '../../../stores/sketchEditor';
import SketchCanvas from './SketchCanvas.vue';
import type { MmPoint } from '../../../engine/trace/types';
import { assertNever } from '../../../engine/plan/types';

const emit = defineEmits<{
  (e: 'finish'): void;
  (e: 'cancel'): void;
}>();

const editor = useSketchEditor();
const { activeTool, sketch, solveState, chainTailId } = storeToRefs(editor);

/** Multi-click tool buffers: picked mm points awaiting the tool's next click. */
const pendingClicks = ref<MmPoint[]>([]);
/** A one-line hint under the toolbar naming the tool's next expected click. */
const toolHint = ref('');

function selectTool(tool: SketchTool): void {
  activeTool.value = tool;
  pendingClicks.value = [];
  editor.endChain();
  switch (tool) {
    case 'select':
      toolHint.value = 'Click an entity to select it, or drag a point to move the geometry.';
      break;
    case 'line':
      toolHint.value = 'Click to place each corner. Click the first point again to close the outline.';
      break;
    case 'arcThreePoint':
      toolHint.value = 'Click the arc start, then the arc end, then a point the arc passes through.';
      break;
    case 'arcTangent':
      toolHint.value = 'Click the end point of the arc; it continues tangent from the last chain point.';
      break;
    case 'circle':
      toolHint.value = 'Click the circle center, then a point on the circle.';
      break;
    case 'mirror':
      toolHint.value = 'Click the two ends of the mirror line, then the two points to keep symmetric.';
      break;
    case 'dimension':
      toolHint.value = 'Click one or two entities, then type the value.';
      break;
    default:
      assertNever(tool);
  }
}
selectTool('select');

let solveTimer: ReturnType<typeof setTimeout> | null = null;
/** Runs the solver shortly after every edit, coalescing rapid changes. */
function scheduleSolve(): void {
  if (solveTimer !== null) clearTimeout(solveTimer);
  solveTimer = setTimeout(() => {
    void editor.solveNow();
  }, 150);
}

function onCanvasClick(at: MmPoint, hitPointId: string | null): void {
  switch (activeTool.value) {
    case 'select':
      break;
    case 'line': {
      if (hitPointId !== null && chainTailId.value !== null) {
        editor.closeChainTo(hitPointId);
      } else {
        editor.appendChainPoint(at);
      }
      scheduleSolve();
      break;
    }
    case 'arcThreePoint': {
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 3) {
        const [start, end, through] = pendingClicks.value;
        const added = editor.addThreePointArc(start, end, through);
        if (!added) toolHint.value = 'Those three points are on one line; an arc needs a curve. Pick again.';
        pendingClicks.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'arcTangent': {
      // Tangent continuation: a three-point arc from the chain tail whose
      // tangency is then enforced by a tangent constraint added in Task 9's
      // constraint toolbar; the drawing click places start and end.
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 2) {
        const [end, through] = pendingClicks.value;
        const tail = sketch.value.entities.find((e) => e.id === chainTailId.value);
        if (tail !== undefined && tail.kind === 'point') {
          editor.addThreePointArc({ x: tail.x, y: tail.y }, end, through);
        }
        pendingClicks.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'circle': {
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 2) {
        const [center, rim] = pendingClicks.value;
        editor.addCircle(center, Math.hypot(rim.x - center.x, rim.y - center.y));
        pendingClicks.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'mirror': {
      pendingClicks.value.push(at);
      if (pendingClicks.value.length === 2) {
        const [a, b] = pendingClicks.value;
        editor.addMirrorLine(a, b);
        pendingClicks.value = [];
        scheduleSolve();
      }
      break;
    }
    case 'dimension':
      // Entity clicks drive dimensioning (Task 9); a bare canvas click does nothing.
      break;
    default:
      assertNever(activeTool.value);
  }
}

function onPointDrag(pointId: string, at: MmPoint): void {
  void editor.solveNow({ pointId, xMm: at.x, yMm: at.y });
}

function onPointDragEnd(): void {
  void editor.solveNow();
}
</script>

<template>
  <div class="sketch-workspace">
    <v-toolbar density="compact">
      <v-btn-toggle :model-value="activeTool" mandatory>
        <v-btn value="select" @click="selectTool('select')">Select</v-btn>
        <v-btn value="line" @click="selectTool('line')">Line</v-btn>
        <v-btn value="arcThreePoint" @click="selectTool('arcThreePoint')">Arc</v-btn>
        <v-btn value="arcTangent" @click="selectTool('arcTangent')">Tangent arc</v-btn>
        <v-btn value="circle" @click="selectTool('circle')">Circle</v-btn>
        <v-btn value="mirror" @click="selectTool('mirror')">Mirror line</v-btn>
        <v-btn value="dimension" @click="selectTool('dimension')">Dimension</v-btn>
      </v-btn-toggle>
      <v-spacer />
      <v-btn variant="text" @click="emit('cancel')">Cancel</v-btn>
      <v-btn color="primary" @click="emit('finish')">Use this shape</v-btn>
    </v-toolbar>
    <p class="tool-hint">{{ toolHint }}</p>
    <div class="canvas-holder">
      <SketchCanvas
        @canvas-click="onCanvasClick"
        @point-drag="onPointDrag"
        @point-drag-end="onPointDragEnd"
        @entity-click="(id: string) => editor.selectedIds.push(id)"
        @dimension-click="() => {}"
      />
    </div>
  </div>
</template>

<style scoped>
.sketch-workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.canvas-holder {
  flex: 1;
  min-height: 320px;
}
.tool-hint {
  margin: 4px 12px;
  font-size: 0.85rem;
  color: rgba(0, 0, 0, 0.6);
}
</style>
```

- [ ] **Step 3: Add the input toggle to TraceTab.vue**

In `web/src/components/trace/TraceTab.vue`:

- Add to the script setup, near the existing `stage` ref (line 36):

```typescript
import SketchWorkspace from './sketch/SketchWorkspace.vue';
import { useSketchEditor } from '../../stores/sketchEditor';

/** How the tool outline is produced on stage 1: a photo trace or a drawn sketch. */
const traceInput = ref<'photo' | 'sketch'>('photo');
const sketchEditor = useSketchEditor();

function startSketch(): void {
  traceInput.value = 'sketch';
  sketchEditor.startNewSketch();
}
```

- In the template's stage-1 block (the part that renders `PhotoStage`), wrap it with the toggle so the user picks between uploading and drawing. The exact markup around `PhotoStage` stays; add above it:

```html
<v-btn-toggle v-model="traceInput" mandatory class="mb-2">
  <v-btn value="photo">Upload a photo</v-btn>
  <v-btn value="sketch" @click="startSketch">Draw the shape</v-btn>
</v-btn-toggle>
```

and render `PhotoStage` only `v-if="traceInput === 'photo'"`, with:

```html
<SketchWorkspace
  v-else
  @cancel="traceInput = 'photo'"
  @finish="finishSketch"
/>
```

`finishSketch` is defined in Task 10; for this task add a stub that only closes the workspace so the file compiles:

```typescript
function finishSketch(): void {
  // Wired to profile extraction and the layout step in the finish task.
  traceInput.value = 'photo';
}
```

(The stub is replaced within this same feature branch by Task 10; it ships nowhere.)

- [ ] **Step 4: Typecheck and build**

Run: `npm run build`
Expected: success, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/trace/sketch/SketchCanvas.vue src/components/trace/sketch/SketchWorkspace.vue src/components/trace/TraceTab.vue
git commit -m "Add the sketch canvas and workspace behind an upload-or-draw toggle."
```

---

### Task 9: Dimensions UI, solver diagnostics, photo underlay

**Files:**
- Modify: `web/src/components/trace/sketch/SketchWorkspace.vue`

**Interfaces:**
- Consumes: `useSketchEditor` actions `addDimension`, `setDimensionValue`, `addConstraint`, `nextId`, store refs `solveState`, `selectedIds`, `underlayUrl`, `underlayOpacityPct`, `underlayMmPerPixel` (Task 7); `SketchDimension` kinds (Task 2).
- Produces: the complete editor UI Task 10 finishes from.

- [ ] **Step 1: Add dimensioning (click entities, then type a value)**

In `SketchWorkspace.vue` script, add:

```typescript
import { computed } from 'vue';
import type { SketchEntity } from '../../../engine/sketch/model';

/** The dimension entry field: which constraint is being typed, and its text. */
const dimensionDraft = ref<{ constraintId: string | null; text: string } | null>(null);

function entityById(id: string): SketchEntity | undefined {
  return sketch.value.entities.find((e) => e.id === id);
}

/**
 * With the dimension tool active, a selection of one or two entities decides
 * the dimension kind: one line is a length, one arc or circle is a radius
 * (Shift for diameter is deliberately not offered; a diameter is typed by
 * picking Diameter in the field's kind menu), two points are a distance, two
 * lines are an angle.
 */
function beginDimensionFromSelection(): void {
  const picked = editor.selectedIds.map(entityById).filter((e): e is SketchEntity => e !== undefined);
  let created: string | null = null;
  if (picked.length === 1 && picked[0].kind === 'line') {
    const id = editor.nextId();
    editor.addDimension({ kind: 'length', id, lineId: picked[0].id, mm: 10 });
    created = id;
  } else if (picked.length === 1 && (picked[0].kind === 'arc' || picked[0].kind === 'circle')) {
    const id = editor.nextId();
    editor.addDimension({ kind: 'radius', id, entityId: picked[0].id, mm: 10 });
    created = id;
  } else if (picked.length === 2 && picked.every((e) => e.kind === 'point')) {
    const id = editor.nextId();
    editor.addDimension({ kind: 'distance', id, p1Id: picked[0].id, p2Id: picked[1].id, mm: 10 });
    created = id;
  } else if (picked.length === 2 && picked.every((e) => e.kind === 'line')) {
    const id = editor.nextId();
    editor.addDimension({
      kind: 'angle',
      id,
      l1Id: picked[0].id,
      l2Id: picked[1].id,
      degrees: 90,
    });
    created = id;
  } else {
    toolHint.value =
      'Select one line for a length, an arc or circle for a radius, two points for a distance, or two lines for an angle.';
    return;
  }
  dimensionDraft.value = { constraintId: created, text: '' };
  editor.selectedIds = [];
}

function commitDimensionDraft(): void {
  if (dimensionDraft.value === null || dimensionDraft.value.constraintId === null) return;
  const value = Number(dimensionDraft.value.text);
  if (!Number.isFinite(value) || value <= 0) {
    toolHint.value = 'The dimension value must be a number above 0.';
    return;
  }
  editor.setDimensionValue(dimensionDraft.value.constraintId, value);
  dimensionDraft.value = null;
  scheduleSolve();
}

/** Click-to-edit on an existing on-canvas dimension label. */
function onDimensionClick(constraintId: string): void {
  const c = sketch.value.constraints.find((k) => k.id === constraintId);
  if (c === undefined) return;
  const current =
    c.kind === 'angle' ? c.degrees : 'mm' in c ? c.mm : null;
  dimensionDraft.value = { constraintId, text: current === null ? '' : String(current) };
}
```

Change the canvas `@dimension-click` binding from the Task 8 no-op to `@dimension-click="(id: string) => onDimensionClick(id)"`, and change the `entityClick` handler to toggle selection and, when the dimension tool is active, call `beginDimensionFromSelection()` once the selection suffices:

```typescript
function onEntityClick(entityId: string): void {
  const at = editor.selectedIds.indexOf(entityId);
  if (at === -1) editor.selectedIds.push(entityId);
  else editor.selectedIds.splice(at, 1);
  if (activeTool.value === 'dimension' && editor.selectedIds.length > 0) {
    beginDimensionFromSelection();
  }
}
```

Add the entry field to the template, under the hint line:

```html
<v-text-field
  v-if="dimensionDraft !== null"
  v-model="dimensionDraft.text"
  label="Dimension value"
  density="compact"
  autofocus
  style="max-width: 200px"
  @keyup.enter="commitDimensionDraft"
/>
```

- [ ] **Step 2: Add the constraint buttons and the construction toggle**

Constraint application follows the same select-then-apply pattern. Add to the script:

```typescript
/** Applies a constraint to the current selection; each row names its need. */
function applyConstraint(kind: 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'coincident' | 'symmetric'): void {
  const picked = editor.selectedIds.map(entityById).filter((e): e is SketchEntity => e !== undefined);
  const id = editor.nextId();
  switch (kind) {
    case 'horizontal':
    case 'vertical':
      if (picked.length === 1 && picked[0].kind === 'line') {
        editor.addConstraint({ kind, id, lineId: picked[0].id });
      } else {
        toolHint.value = 'Select one line first.';
        return;
      }
      break;
    case 'parallel':
    case 'perpendicular':
      if (picked.length === 2 && picked.every((e) => e.kind === 'line')) {
        editor.addConstraint({ kind, id, l1Id: picked[0].id, l2Id: picked[1].id });
      } else {
        toolHint.value = 'Select two lines first.';
        return;
      }
      break;
    case 'tangent':
      if (picked.length === 2) {
        editor.addConstraint({ kind: 'tangent', id, aId: picked[0].id, bId: picked[1].id });
      } else {
        toolHint.value = 'Select the two entities to make tangent first.';
        return;
      }
      break;
    case 'coincident':
      if (picked.length === 2 && picked.every((e) => e.kind === 'point')) {
        editor.addConstraint({ kind: 'coincident', id, p1Id: picked[0].id, p2Id: picked[1].id });
      } else {
        toolHint.value = 'Select two points first.';
        return;
      }
      break;
    case 'symmetric':
      if (
        picked.length === 3 &&
        picked.filter((e) => e.kind === 'point').length === 2 &&
        picked.filter((e) => e.kind === 'line').length === 1
      ) {
        const pts = picked.filter((e) => e.kind === 'point');
        const mirror = picked.find((e) => e.kind === 'line')!;
        editor.addConstraint({
          kind: 'symmetric',
          id,
          p1Id: pts[0].id,
          p2Id: pts[1].id,
          mirrorLineId: mirror.id,
        });
      } else {
        toolHint.value = 'Select two points and the mirror line first.';
        return;
      }
      break;
    default:
      assertNever(kind);
  }
  editor.selectedIds = [];
  scheduleSolve();
}

function toggleConstructionOnSelection(): void {
  for (const id of editor.selectedIds) editor.toggleConstruction(id);
  scheduleSolve();
}
```

Add a second toolbar row to the template:

```html
<v-toolbar density="compact">
  <v-btn size="small" @click="applyConstraint('horizontal')">Horizontal</v-btn>
  <v-btn size="small" @click="applyConstraint('vertical')">Vertical</v-btn>
  <v-btn size="small" @click="applyConstraint('parallel')">Parallel</v-btn>
  <v-btn size="small" @click="applyConstraint('perpendicular')">Perpendicular</v-btn>
  <v-btn size="small" @click="applyConstraint('tangent')">Tangent</v-btn>
  <v-btn size="small" @click="applyConstraint('coincident')">Coincident</v-btn>
  <v-btn size="small" @click="applyConstraint('symmetric')">Symmetric</v-btn>
  <v-btn size="small" @click="toggleConstructionOnSelection">Construction</v-btn>
</v-toolbar>
```

- [ ] **Step 3: Add the solver status rows**

Diagnostic readouts are labeled rows (convention 8). Add to the script:

```typescript
/** The solver readout as labeled rows, not prose. */
const statusRows = computed<{ label: string; value: string }[]>(() => {
  const state = solveState.value;
  switch (state.status) {
    case 'idle':
      return [{ label: 'Solver', value: 'not yet run' }];
    case 'solved':
      return [
        { label: 'Solver', value: state.dof === 0 ? 'fully constrained' : 'under-constrained' },
        { label: 'Degrees of freedom', value: String(state.dof) },
      ];
    case 'conflicting':
      return [
        { label: 'Solver', value: 'conflicting constraints' },
        ...state.conflictingConstraintIds.map((id) => ({ label: 'Conflicting constraint', value: id })),
      ];
    case 'failed':
      return [{ label: 'Solver', value: state.message }];
    default:
      return assertNever(state);
  }
});

/** Removes one conflicting constraint from its diagnostics row. */
function removeConflicting(constraintId: string): void {
  editor.removeConstraint(constraintId);
  scheduleSolve();
}
```

Template, under the canvas:

```html
<div class="status-rows">
  <div v-for="(row, i) in statusRows" :key="i" class="status-row">
    <span class="status-label">{{ row.label }}</span>
    <span class="status-value">{{ row.value }}</span>
    <v-btn
      v-if="row.label === 'Conflicting constraint'"
      size="x-small"
      variant="text"
      @click="removeConflicting(row.value)"
    >
      Remove
    </v-btn>
  </div>
</div>
```

with styles:

```css
.status-rows {
  padding: 4px 12px;
  font-size: 0.85rem;
}
.status-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.status-label {
  color: rgba(0, 0, 0, 0.6);
  min-width: 170px;
}
```

- [ ] **Step 4: Add the photo underlay controls**

Add to the script:

```typescript
/** The two clicked ends of the calibration line over the underlay, in image px. */
const calibrationClicks = ref<MmPoint[]>([]);
const calibrationLengthText = ref('');
const calibrating = ref(false);

function onUnderlayFile(file: File | null): void {
  if (editor.underlayUrl !== null) URL.revokeObjectURL(editor.underlayUrl);
  editor.underlayUrl = file === null ? null : URL.createObjectURL(file);
  editor.underlayMmPerPixel = file === null ? null : 1;
  calibrationClicks.value = [];
}

/**
 * One-line scale calibration: the user draws one line over the photo and
 * types its real length. Display only; the figure scales the underlay image
 * and never enters the sketch geometry.
 */
function commitCalibration(): void {
  const lengthMm = Number(calibrationLengthText.value);
  if (calibrationClicks.value.length !== 2 || !Number.isFinite(lengthMm) || lengthMm <= 0) {
    toolHint.value = 'Click the two ends of a known distance on the photo, then type its length in mm.';
    return;
  }
  const [a, b] = calibrationClicks.value;
  const drawnMm = Math.hypot(b.x - a.x, b.y - a.y);
  const currentScale = editor.underlayMmPerPixel ?? 1;
  // The clicks are in current display mm; rescale so the drawn span reads lengthMm.
  editor.underlayMmPerPixel = (currentScale * lengthMm) / drawnMm;
  calibrating.value = false;
  calibrationClicks.value = [];
}
```

In `onCanvasClick`, before the tool switch, intercept calibration clicks:

```typescript
  if (calibrating.value) {
    pendingClicks.value = [];
    calibrationClicks.value.push(at);
    if (calibrationClicks.value.length > 2) calibrationClicks.value = [at];
    return;
  }
```

Template, in the second toolbar row's right side:

```html
<v-spacer />
<v-file-input
  label="Reference photo"
  density="compact"
  hide-details
  style="max-width: 220px"
  accept="image/*"
  @update:model-value="(f: File | File[] | null) => onUnderlayFile(Array.isArray(f) ? (f[0] ?? null) : f)"
/>
<v-slider
  v-if="editor.underlayUrl !== null"
  v-model="editor.underlayOpacityPct"
  min="0"
  max="100"
  step="5"
  hide-details
  style="max-width: 140px"
  label="Opacity"
/>
<v-btn v-if="editor.underlayUrl !== null" size="small" @click="calibrating = true; calibrationClicks = []">
  Set photo scale
</v-btn>
<v-text-field
  v-if="calibrating"
  v-model="calibrationLengthText"
  label="Line length in mm"
  density="compact"
  hide-details
  style="max-width: 150px"
  @keyup.enter="commitCalibration"
/>
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src/components/trace/sketch/SketchWorkspace.vue
git commit -m "Add dimensioning, constraints, solver diagnostics and the photo underlay."
```

---

### Task 10: Finish flow, reopening sketched tools, final verification

**Files:**
- Modify: `web/src/components/trace/TraceTab.vue` (real `finishSketch`, reopen path)
- Modify: `web/src/components/trace/LayoutWorkspace.vue` (the tool rail's re-trace affordance branches on `tool.source`)
- Test: `web/tests/stores/toolTrace.spec.ts` (sketched tool lands in the layout with its sketch)

**Interfaces:**
- Consumes: `extractProfile` (Task 4), `solveSketchInWorker` via `editor.solveNow` (Tasks 5, 7), `useToolTrace().addTool` with the `source` parameter (Task 6), `useSketchEditor().loadSketch` (Task 7).
- Produces: the finished feature; nothing downstream.

- [ ] **Step 1: Write the failing store test**

Add to `web/tests/stores/toolTrace.spec.ts` (following the file's existing setup helpers):

```typescript
import { SKETCH_SCHEMA_VERSION } from '../../src/engine/sketch/model';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/stores/toolTrace.spec.ts`
Expected: FAIL if Task 6 did not yet thread `source` through the store's `addTool` signature exactly as specified there (parameter after `brushStrokes`); otherwise it passes immediately, which is acceptable: it then pins the contract this task relies on.

- [ ] **Step 3: Implement the finish flow in TraceTab.vue**

Replace the Task 8 stub:

```typescript
import { extractProfile } from '../../engine/sketch/profile';
import { cloneSketch } from '../../engine/sketch/model';

/** Error from the last finish attempt, shown as an alert over the workspace. */
const sketchFinishError = ref<string | null>(null);

/**
 * Validates the sketch through the profile extractor and drops the resulting
 * outline into the normal tool placement step. The sketch itself travels on
 * the tool so it can be reopened and edited later.
 */
async function finishSketch(): Promise<void> {
  sketchFinishError.value = null;
  // One final solve so the extracted profile is the solved geometry.
  await sketchEditor.solveNow();
  const state = sketchEditor.solveState;
  if (state.status === 'conflicting') {
    sketchFinishError.value =
      'The sketch has conflicting constraints. Remove one of the constraints listed under the canvas.';
    return;
  }
  if (state.status === 'failed') {
    sketchFinishError.value = state.message;
    return;
  }
  const profile = extractProfile(sketchEditor.sketch);
  if (!profile.ok) {
    sketchFinishError.value = profile.error;
    return;
  }
  const source = { kind: 'sketch' as const, sketch: cloneSketch(sketchEditor.sketch) };
  if (sketchEditor.editingToolId !== null) {
    // Re-editing a sketched tool: replace its outline and sketch in place.
    const tool = trace.tools.find((t) => t.id === sketchEditor.editingToolId);
    if (tool !== undefined) {
      trace.replaceToolOutline(tool.id, profile.outline, []);
      tool.source = source;
    }
  } else {
    trace.addTool(profile.outline, 'Sketched shape', [], false, [], source);
  }
  traceInput.value = 'photo';
  stage.value = 2;
  trace.workspaceMode = 'layout';
}
```

and surface the error above the workspace in the template:

```html
<v-alert v-if="sketchFinishError !== null" type="error" density="compact" class="mb-2">
  {{ sketchFinishError }}
</v-alert>
```

Also add the reopen path: when the layout rail asks to edit a sketched tool (Step 4 emits it), handle:

```typescript
/** Opens a sketched tool's stored sketch back in the sketch workspace. */
function editSketchedTool(toolId: string): void {
  const tool = trace.tools.find((t) => t.id === toolId);
  if (tool === undefined) return;
  switch (tool.source.kind) {
    case 'photo':
      return; // photo tools re-trace through the existing path
    case 'sketch':
      sketchEditor.loadSketch(tool.source.sketch, toolId);
      stage.value = 1;
      traceInput.value = 'sketch';
      return;
    default:
      return assertNever(tool.source);
  }
}
```

(import `assertNever` from `../../engine/plan/types`), and pass it to `LayoutWorkspace` as a prop or event handler per that component's existing pattern (it already emits or calls the re-trace request through `trace.retraceRequestId`; wire `edit-sketch` alongside).

- [ ] **Step 4: Branch the tool rail on the tool source**

In `web/src/components/trace/LayoutWorkspace.vue`, find the tool rail's re-trace button (it sets `trace.retraceRequestId`). Replace its unconditional rendering with an exhaustive branch on `tool.source.kind` computed per tool:

```typescript
import { assertNever } from '../../engine/plan/types';
import type { TracedTool } from '../../engine/trace/types';

/** The edit affordance a tool row shows, by outline source. */
function editActionOf(tool: TracedTool): 'retrace' | 'editSketch' {
  switch (tool.source.kind) {
    case 'photo':
      return 'retrace';
    case 'sketch':
      return 'editSketch';
    default:
      return assertNever(tool.source);
  }
}
```

In the template, where the re-trace button renders, branch:

```html
<v-btn v-if="editActionOf(tool) === 'retrace'" size="small" @click="requestRetrace(tool.id)">
  Re-trace
</v-btn>
<v-btn v-else size="small" @click="emit('editSketch', tool.id)">
  Edit sketch
</v-btn>
```

adding `editSketch` to the component's `defineEmits` and `requestRetrace` being whatever the existing button already called (keep its current handler name). Wire `@edit-sketch="editSketchedTool"` where `TraceTab.vue` renders `LayoutWorkspace`.

- [ ] **Step 5: Run the full verification**

Run: `npx vitest run` then `npm run build`
Expected: every test green, build clean.

Then run: `npm test`
Expected: green (same suite through the project's own script, the CI bar).

- [ ] **Step 6: Commit**

```bash
git add src/components/trace/TraceTab.vue src/components/trace/LayoutWorkspace.vue tests/stores/toolTrace.spec.ts
git commit -m "Wire the sketch finish flow into tool placement and sketch re-editing."
```

---

## Spec coverage self-review

- Engine `model.ts` with schema version, entities (point/line/arc/circle, construction flag), all listed constraints and dimensions, exhaustive unions, validation, serialization round-trip: Task 2.
- `solve.ts` adapter with status fully constrained / under-constrained with DOF / conflicting with offending ids, driven-point drag: Task 3.
- `profile.ts` closed loop extraction, arc flattening at the shared 0.2 mm trace tolerance, returns `TracedOutline`, all four user-worded failures: Task 4.
- Dedicated `sketch.worker.ts` and `sketchClient.ts` on the Comlink pattern, WASM as a separate asset: Task 5; LGPL attribution: Task 1.
- Tool origin discriminator mirroring `Bin.origin`, embedded editable sketch, plan version 11 with validators and default-on-pick migration, exhaustive switches: Task 6 (data), Task 10 (UI branch).
- Upload-or-draw toggle at the input step, SVG mm-grid canvas with pan/zoom, select/drag, line chain, three-point arc, tangent continuation, center-plus-diameter circle (center plus rim click stores the radius; the diameter dimension types the exact figure), construction toggle, mirror line: Task 8.
- Click-then-type dimensions with click-to-edit on-canvas labels, solver runs after every edit, distinct colors for under-constrained vs fully constrained vs conflicting, conflicts as labeled rows, photo underlay with opacity and one-line display-only calibration: Task 9.
- Finish button validating through `profile.ts` into the normal placement and depth step, reopening sketched tools: Task 10.
- Testing section: model round-trips (Task 2), solve against dimensioned rectangle, tangent arc chain, symmetric profile, over-constrained conflict (Task 3), profile extraction with every failure (Task 4), plan version migration (Task 6), node WASM smoke test on the vision pattern (Task 1). UI carries no component tests because the repo has none.
