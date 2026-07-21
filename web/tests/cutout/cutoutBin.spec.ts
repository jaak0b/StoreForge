import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ExecutionContext, Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Font } from 'opentype.js';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import { componentVolumes } from '../helpers/components';
import { meshToManifold } from '../../src/engine/cutout/cutoutMesh';
import {
  buildCutoutBinBody,
  cutoutModelKey,
  generateCutoutBin,
  generateCutoutBinUnion,
  DEFAULT_CUTOUT_CLEARANCE_MM,
  maxClearanceMm,
  placeCutter,
  prepareCutoutModel,
  simplifyToleranceMm,
  validateClearanceMm,
} from '../../src/engine/cutout/cutoutBin';
import type {
  CutoutBinParams,
  CutoutModelSpec,
  ModelPlacement,
} from '../../src/engine/cutout/cutoutBin';
import { CarveCancelledError } from '../../src/engine/gridfinity/carvedBin';
import { circleSegments } from '../../src/engine/geometry/circleSegments';
import {
  binInteriorSizeMm,
  binOuterSizeMm,
  FLOOR_TOP,
  HEIGHT_UNIT,
  LIP_HEIGHT,
} from '../../src/engine/gridfinity/constants';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

/**
 * A right triangular prism, centred on its own bounding box exactly as the
 * import stage centres a model. Asymmetric about all three axes, which is what
 * makes the two Euler conventions land it in different places.
 *
 * Its triangular cross-section has the right angle at the origin corner, legs
 * of 12 mm along X and 6 mm along Y, and it is 20 mm long in Z.
 */
const PRISM_LEG_X = 12;
const PRISM_LEG_Y = 6;
const PRISM_LENGTH_Z = 20;

function prism(): Manifold {
  const section = new m.CrossSection(
    [
      [
        [0, 0],
        [PRISM_LEG_X, 0],
        [0, PRISM_LEG_Y],
      ],
    ],
    'NonZero',
  );
  const solid = section
    .extrude(PRISM_LENGTH_Z)
    .translate(-PRISM_LEG_X / 2, -PRISM_LEG_Y / 2, -PRISM_LENGTH_Z / 2);
  section.delete();
  return solid;
}

/** The prism's six corners, in the same centred frame the solid uses. */
function prismCorners(): THREE.Vector3[] {
  const corners: THREE.Vector3[] = [];
  for (const [x, y] of [
    [0, 0],
    [PRISM_LEG_X, 0],
    [0, PRISM_LEG_Y],
  ]) {
    for (const z of [0, PRISM_LENGTH_Z]) {
      corners.push(
        new THREE.Vector3(
          x - PRISM_LEG_X / 2,
          y - PRISM_LEG_Y / 2,
          z - PRISM_LENGTH_Z / 2,
        ),
      );
    }
  }
  return corners;
}

/**
 * Points strictly inside the prism, in its centred frame, each at least 1 mm
 * clear of every face so a 0.2 mm probe cube placed at one is wholly inside
 * the solid. Their positions after a rotation are what distinguishes one Euler
 * convention from the other for a shape, rather than only for its bounds.
 */
function prismInteriorPoints(): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (const [x, y] of [
    [4, 2],
    [2, 1.5],
    [8, 1.2],
    [1.5, 3.5],
  ]) {
    for (const z of [4, 10, 16]) {
      points.push(
        new THREE.Vector3(
          x - PRISM_LEG_X / 2,
          y - PRISM_LEG_Y / 2,
          z - PRISM_LENGTH_Z / 2,
        ),
      );
    }
  }
  return points;
}

/**
 * The placement as a three.js matrix under a stated Euler order, composed the
 * way three composes an Object3D: scale, then rotation, then position. This is
 * computed from three's own Euler and Matrix4 code, never from the manifold
 * result, so it is an independent statement of where the solid should land.
 */
function threeMatrix(placement: ModelPlacement, order: THREE.EulerOrder): THREE.Matrix4 {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const euler = new THREE.Euler(
    rad(placement.rotXDeg),
    rad(placement.rotYDeg),
    rad(placement.rotZDeg),
    order,
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(placement.xMm, placement.yMm, placement.zMm),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Bounds of a point set as manifold reports bounds, for direct comparison. */
function pointsBox(points: THREE.Vector3[]): { min: number[]; max: number[] } {
  const box = new THREE.Box3().setFromPoints(points);
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

/** True when a 0.2 mm probe cube centred on the point is wholly inside the solid. */
function containsPoint(solid: Manifold, point: THREE.Vector3): boolean {
  const size = 0.2;
  const probe = m.Manifold.cube([size, size, size], true).translate(
    point.x,
    point.y,
    point.z,
  );
  const overlap = solid.intersect(probe);
  const volume = overlap.volume();
  probe.delete();
  overlap.delete();
  return Math.abs(volume - size ** 3) < 1e-6;
}

describe('placeCutter rotation order', () => {
  /**
   * The convention trap this exists for: manifold rotates in extrinsic x-y-z
   * order, while a three.js Euler defaults to intrinsic 'XYZ', which is
   * extrinsic ZYX. The two agree for a rotation about one axis and disagree
   * for any compound one, so the gizmo ghost and the carved pocket would part
   * company the moment a user rotated about two axes. The gizmo target's Euler
   * order is therefore 'ZYX', and this asserts the geometry matches that.
   */
  const placement: ModelPlacement = {
    xMm: 3,
    yMm: -4,
    zMm: 5,
    rotXDeg: 90,
    rotYDeg: 90,
    rotZDeg: 0,
  };

  it('puts an asymmetric solid where the three.js ZYX Euler matrix puts it', () => {
    const expected = pointsBox(
      prismCorners().map((corner) =>
        corner.clone().applyMatrix4(threeMatrix(placement, 'ZYX')),
      ),
    );

    const solid = prism();
    const placed = placeCutter(solid, placement);
    const box = placed.boundingBox();

    for (let axis = 0; axis < 3; axis += 1) {
      expect(box.min[axis]).toBeCloseTo(expected.min[axis], 6);
      expect(box.max[axis]).toBeCloseTo(expected.max[axis], 6);
    }

    placed.delete();
    solid.delete();
  });

  it('carries every interior point to where the ZYX matrix carries it', () => {
    // Bounds alone would pass for any solid with the same bounding box, so the
    // shape itself is checked: each interior sample point, moved by three's own
    // ZYX matrix, must land inside the placed solid.
    const matrix = threeMatrix(placement, 'ZYX');
    const solid = prism();
    const placed = placeCutter(solid, placement);

    for (const point of prismInteriorPoints()) {
      expect(containsPoint(placed, point.clone().applyMatrix4(matrix))).toBe(true);
    }

    placed.delete();
    solid.delete();
  });

  it('does not put it where the three.js default XYZ Euler matrix puts it', () => {
    // Without this the two tests above would pass against an implementation
    // using the wrong convention if the two conventions happened to agree.
    const expected = pointsBox(
      prismCorners().map((corner) =>
        corner.clone().applyMatrix4(threeMatrix(placement, 'XYZ')),
      ),
    );

    const solid = prism();
    const placed = placeCutter(solid, placement);
    const box = placed.boundingBox();

    const sizes = [0, 1, 2].map((axis) => box.max[axis] - box.min[axis]);
    const expectedSizes = [0, 1, 2].map((axis) => expected.max[axis] - expected.min[axis]);
    expect(sizes).not.toEqual(expectedSizes);

    const matrix = threeMatrix(placement, 'XYZ');
    const inside = prismInteriorPoints().map((point) =>
      containsPoint(placed, point.clone().applyMatrix4(matrix)),
    );
    expect(inside.every((hit) => hit)).toBe(false);

    placed.delete();
    solid.delete();
  });
});

/**
 * A 2x2x6 bin with magnet holes. The holes are on deliberately: they are the
 * legitimate exception to "nothing below the container floor", so every
 * differential base comparison here exercises them rather than avoiding them.
 */
function params(overrides: Partial<CutoutBinParams> = {}): CutoutBinParams {
  return {
    gridX: 2,
    gridY: 2,
    heightUnits: 6,
    magnetHoles: true,
    walls: [],
    labelSlot: true,
    insert: null,
    models: [],
    ...overrides,
  };
}

/** Nominal bin top of the shared test bin: 6 height units of 7 mm. */
const BODY_TOP = 6 * HEIGHT_UNIT;

/** Mid-height of the interior cavity, where a buried model clears both ends. */
const INTERIOR_MID_Z = (FLOOR_TOP + BODY_TOP) / 2;

/** A placement at a point, with no rotation. */
function at(xMm: number, yMm: number, zMm: number): ModelPlacement {
  return { xMm, yMm, zMm, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 };
}

/**
 * A model prepared from a manifold primitive rather than from a file, which is
 * what the import stage hands the carve. The primitive stands in for the
 * parsed and welded STL; everything downstream of that point is under test.
 */
function prepared(
  solid: Manifold,
  clearanceMm: number,
  unitScale = 1,
  name = 'part.stl',
): Manifold {
  return prepareCutoutModel(m, solid, { name, unitScale, clearanceMm }).solid;
}

/** A prepared cube model with a placement, ready to hand to a carve. */
function cubeModel(
  sizeMm: number,
  clearanceMm: number,
  placement: ModelPlacement,
  name = 'cube.stl',
): CutoutModelSpec {
  return {
    name,
    solid: prepared(m.Manifold.cube([sizeMm, sizeMm, sizeMm], true), clearanceMm, 1, name),
    placement,
    clearanceMm,
    sweepEnabled: false,
    draftAngleDeg: 0,
  };
}

/** The uncarved bin these tests compare a carve against. */
function uncarvedBin(overrides: Partial<CutoutBinParams> = {}): Manifold {
  return buildCutoutBinBody(m, params(overrides)).body;
}

/**
 * The material a carve removed, as its own solid: the same bin with no models
 * minus the carved one. This is the pocket, measured rather than assumed.
 */
function pocketOf(models: CutoutModelSpec[]): Manifold {
  const uncarved = uncarvedBin();
  const carved = buildCutoutBinBody(m, params({ models })).body;
  const pocket = m.Manifold.difference(uncarved, carved);
  uncarved.delete();
  carved.delete();
  return pocket;
}

/** Size of a solid's bounding box along the three axes. */
function sizeOf(solid: Manifold): [number, number, number] {
  const box = solid.boundingBox();
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

/** Intersection volume of a solid with an axis-aligned probe box. */
function probeVolume(
  body: Manifold,
  center: [number, number, number],
  size: [number, number, number],
): number {
  const probe = m.Manifold.cube(size, true).translate(...center);
  const overlap = body.intersect(probe);
  const volume = overlap.volume();
  probe.delete();
  overlap.delete();
  return volume;
}

describe('buildCutoutBinBody', () => {
  it('carves a 10 mm cube at the interior centre into one sound solid', () => {
    // status() alone calls a bin with a loose island of plastic rattling in it
    // perfectly valid geometry, so connectedness is asserted directly. Whole
    // solid genus is deliberately not asserted: a cutter can seal a void in
    // the hollow base, which drives the genus negative on correct geometry.
    const models = [cubeModel(10, DEFAULT_CUTOUT_CLEARANCE_MM, at(0, 5, INTERIOR_MID_Z))];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(result.body.status()).toBe('NoError');
    expect(componentVolumes(result.body).solids).toHaveLength(1);
    expect(result.warnings).toEqual([]);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('makes the pocket 10 mm plus twice the clearance on each axis', () => {
    // The clearance is a radius applied all round, so it costs twice on each
    // axis. Applying it as a diameter, or skipping the offset, shows up here.
    const clearanceMm = DEFAULT_CUTOUT_CLEARANCE_MM;
    const models = [cubeModel(10, clearanceMm, at(0, 5, INTERIOR_MID_Z))];
    const pocket = pocketOf(models);

    for (const extent of sizeOf(pocket)) {
      expect(extent).toBeCloseTo(10 + 2 * clearanceMm, 6);
    }

    pocket.delete();
    for (const model of models) model.solid.delete();
  });

  it('makes a zero clearance pocket exactly the model size', () => {
    // The zero clearance fast path skips both the simplify and the Minkowski
    // sum; still offsetting would show as a pocket larger than the model.
    const models = [cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z))];
    const pocket = pocketOf(models);

    for (const extent of sizeOf(pocket)) {
      expect(extent).toBeCloseTo(10, 6);
    }

    pocket.delete();
    for (const model of models) model.solid.delete();
  });

  it('takes the footprint from the rotated mesh, not the raw bounding box', () => {
    // A 10x20x30 box turned 90 degrees about X stands 20 mm tall and 30 mm
    // deep. Reading the footprint off the unrotated bounds would report 10x20.
    const solid = prepared(m.Manifold.cube([10, 20, 30], true), 0);
    const models: CutoutModelSpec[] = [
      {
        name: 'box.stl',
        solid,
        placement: { ...at(0, 0, INTERIOR_MID_Z), rotXDeg: 90 },
        clearanceMm: 0,
        sweepEnabled: false,
        draftAngleDeg: 0,
      },
    ];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(result.footprints).toHaveLength(1);
    expect(result.footprints[0].sizeMm.x).toBeCloseTo(10, 6);
    expect(result.footprints[0].sizeMm.y).toBeCloseTo(30, 6);
    expect(result.footprints[0].sizeMm.z).toBeCloseTo(20, 6);

    result.body.delete();
    solid.delete();
  });
});

describe('cavity edits in the cutout carve', () => {
  it('a remove edit changes the generated body and keeps it watertight', () => {
    const withoutEdits = buildCutoutBinBody(m, params());
    const withEdits = buildCutoutBinBody(m, {
      ...params(),
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

describe('placeCutter transform order', () => {
  it('rotates about the model centre and then translates, not the other way round', () => {
    // Silent for a centred model left at the origin, and wrong everywhere
    // else: translating first would swing the model about the bin's centre.
    const placement: ModelPlacement = { ...at(7, -3, 20), rotZDeg: 90 };
    const solid = m.Manifold.cube([10, 20, 30], true);
    const placed = placeCutter(solid, placement);
    const box = placed.boundingBox();
    const centre = [0, 1, 2].map((axis) => (box.min[axis] + box.max[axis]) / 2);

    expect(centre[0]).toBeCloseTo(placement.xMm, 6);
    expect(centre[1]).toBeCloseTo(placement.yMm, 6);
    expect(centre[2]).toBeCloseTo(placement.zMm, 6);

    // Translate first and the same 90 degree turn about Z carries the centre
    // to (3, 7, 20) instead, which is where a swapped order would land it.
    const swapped = solid
      .translate([placement.xMm, placement.yMm, placement.zMm])
      .rotate([0, 0, placement.rotZDeg]);
    const swappedBox = swapped.boundingBox();
    expect((swappedBox.min[0] + swappedBox.max[0]) / 2).not.toBeCloseTo(placement.xMm, 6);

    swapped.delete();
    placed.delete();
    solid.delete();
  });
});

describe('the cached offset assumption', () => {
  it('gives the same solid whether the offset or the rotation runs first', () => {
    // The whole caching design rests on this: the dilation is computed once in
    // the model's own frame and reused for every placement. If it were not
    // rotation invariant, every cached carve would be subtly wrong.
    //
    // A true sphere is isotropic and the invariance is exact. The offset
    // sphere is a facet approximation of one, so the two orders agree only to
    // within its faceting error, and that error is what the bound below is:
    // the inscribed facets fall short of the true sphere by at most
    // clearanceMm * (1 - cos(pi / n)), so the two solids can differ by a shell
    // no thicker than that over the surface they share.
    const clearanceMm = DEFAULT_CUTOUT_CLEARANCE_MM;
    const segments = circleSegments(clearanceMm, simplifyToleranceMm(clearanceMm));
    const facetShiftMm = clearanceMm * (1 - Math.cos(Math.PI / segments));
    const rotation: ModelPlacement = {
      ...at(0, 0, 0),
      rotXDeg: 30,
      rotYDeg: 40,
      rotZDeg: 50,
    };

    const offsetFirst = placeCutter(
      prepared(m.Manifold.cube([10, 14, 18], true), clearanceMm),
      rotation,
    );
    const rotatedFirst = prepared(
      placeCutter(m.Manifold.cube([10, 14, 18], true), rotation),
      clearanceMm,
    );

    const sliver = offsetFirst.subtract(rotatedFirst);
    const otherSliver = rotatedFirst.subtract(offsetFirst);
    expect(sliver.volume()).toBeLessThanOrEqual(offsetFirst.surfaceArea() * facetShiftMm);
    expect(otherSliver.volume()).toBeLessThanOrEqual(
      rotatedFirst.surfaceArea() * facetShiftMm,
    );

    for (const part of [sliver, otherSliver, offsetFirst, rotatedFirst]) part.delete();
  });
});

describe('overlapping models', () => {
  it('merges two overlapping models into one pocket without complaint', () => {
    // Deliberately different from the traced pocket flow, which rejects
    // overlapping pockets. Intersecting two models to compose a pocket shape
    // is a legitimate technique here, so copying that rule would remove
    // capability for no safety gain.
    const models = [
      cubeModel(10, 0, at(-2, 5, INTERIOR_MID_Z), 'a.stl'),
      cubeModel(10, 0, at(2, 5, INTERIOR_MID_Z), 'b.stl'),
    ];
    const result = buildCutoutBinBody(m, params({ models }));
    const pocket = pocketOf(models);

    expect(result.warnings).toEqual([]);
    expect(result.body.status()).toBe('NoError');
    expect(componentVolumes(pocket).solids).toHaveLength(1);
    expect(sizeOf(pocket)[0]).toBeCloseTo(14, 6);

    pocket.delete();
    result.body.delete();
    for (const model of models) model.solid.delete();
  });
});

describe('models at and through the rim', () => {
  it('opens the pocket through the top face for a model raised through the rim', () => {
    // The cutout flow deliberately does not extend cutters past the bin top: a
    // model is a cutter wherever the user put it. Clamping it to the bin top
    // would reintroduce an always-open-at-the-top pocket by accident.
    const models = [cubeModel(20, 0, at(0, 5, BODY_TOP), 'raised.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    // Just under the nominal bin top, inside the model's column: open.
    expect(probeVolume(result.body, [0, 5, BODY_TOP - 0.5], [4, 4, 0.5])).toBe(0);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('leaves the top face closed over a model sunk fully below the rim', () => {
    const models = [cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z), 'sunk.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    // The same probe, over a buried model: solid material all the way across.
    expect(probeVolume(result.body, [0, 5, BODY_TOP - 0.5], [4, 4, 0.5])).toBeCloseTo(8, 5);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });
});

describe('placement warnings', () => {
  it('reports a model outside the interior and still produces a valid solid', () => {
    // Warnings are returned, never thrown: a legal design must not be blocked.
    const models = [cubeModel(10, 0, at(300, 0, INTERIOR_MID_Z), 'away.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(result.warnings).toEqual([
      {
        modelIndex: 0,
        message:
          'The model "away.stl" sits entirely outside the bin interior, so it carves ' +
          'nothing. Move it into the bin.',
      },
    ]);
    expect(result.body.status()).toBe('NoError');
    expect(componentVolumes(result.body).solids).toHaveLength(1);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('says nothing about a model straddling a wall, and still carves a valid solid', () => {
    // Opening a pocket through the side of a bin is a design decision, not a
    // mistake, and a model buried entirely inside the interior is unreachable,
    // so a warning here would fire on almost every useful placement and mean
    // nothing. The carve stays silent and still has to produce sound geometry.
    const wallX = binInteriorSizeMm(2) / 2;
    const models = [cubeModel(10, 0, at(wallX, 5, INTERIOR_MID_Z), 'wall.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(result.warnings).toEqual([]);
    expect(result.body.status()).toBe('NoError');
    expect(componentVolumes(result.body).solids).toHaveLength(1);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('reports a model reaching under the label insert slot', () => {
    // The insert rests on the slot floor, so a carve into the strip undercuts
    // its seat. The protection belongs to the shared carve stage; this asserts
    // the cutout flow is actually wired into it.
    const frontY = -binInteriorSizeMm(2) / 2;
    const models = [cubeModel(10, 0, at(0, frontY + 6, INTERIOR_MID_Z), 'front.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(result.warnings).toEqual([
      {
        modelIndex: 0,
        message:
          'The model "front.stl" reaches under the label insert slot, which needs to stay ' +
          'solid for the insert to rest on. Move it away from the front wall.',
      },
    ]);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('points each warning at the model it is about, by its place in the carve', () => {
    // What the editor attaches a warning to a model row by, and what decides
    // which ghost turns red. The name in the message cannot do it: two uploads
    // of the same file share one, so an index off by a single model would put
    // the warning on an innocent row and leave the offending one looking fine.
    const models = [
      cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z), 'inside.stl'),
      cubeModel(10, 0, at(300, 0, INTERIOR_MID_Z), 'away.stl'),
    ];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].modelIndex).toBe(1);
    expect(result.warnings[0].message).toContain('"away.stl"');

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('names the fused shelf on a bin that carries one', () => {
    const frontY = -binInteriorSizeMm(2) / 2;
    const models = [cubeModel(10, 0, at(0, frontY + 6, INTERIOR_MID_Z), 'front.stl')];
    const result = buildCutoutBinBody(
      m,
      params({
        models,
        labelSlot: false,
        fusedLabel: { text: 'A', text2: '', icon: null },
      }),
    );

    expect(result.warnings).toEqual([
      {
        modelIndex: 0,
        message:
          'The model "front.stl" reaches under the fused label shelf, which needs to stay ' +
          'solid for the label to stand on. Move it away from the front wall.',
      },
    ]);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('rejects a cutout bin that also carries divider walls', () => {
    // An error, not a warning: the interior is filled solid for the carve, so
    // walls have nothing to divide and would reach the carve as nonsense.
    const models = [cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z))];

    expect(() =>
      buildCutoutBinBody(
        m,
        params({
          models,
          walls: [{ ax: -10, ay: 0, bx: 10, by: 0, heightMm: 20 }],
        }),
      ),
    ).toThrow(
      'Cutout models cannot be combined with divider walls. Remove the dividers to add models.',
    );

    for (const model of models) model.solid.delete();
  });
});

describe('nothing appears where it has no business being', () => {
  it('keeps the floor plate solid under a pocket that stops above it', () => {
    // The pocket bottom sits 2 mm above the floor top, so the plate under it
    // and the 2 mm of fill above it must both come back solid.
    const models = [cubeModel(10, 0, at(0, 5, FLOOR_TOP + 2 + 5), 'shallow.stl')];
    const result = buildCutoutBinBody(m, params({ models }));

    expect(probeVolume(result.body, [0, 5, FLOOR_TOP - 0.5], [4, 4, 1])).toBeCloseTo(16, 5);
    expect(probeVolume(result.body, [0, 5, FLOOR_TOP + 1], [4, 4, 2])).toBeCloseTo(32, 5);

    result.body.delete();
    for (const model of models) model.solid.delete();
  });

  it('leaves everything at and below the container floor identical to an uncarved bin', () => {
    // The defect this pins actually shipped once, in the divider walls: roots
    // reached past the interior floor and printed as ribs across the bottom of
    // the bin, with every validity assertion in the suite green throughout.
    // The comparison is differential so magnet holes, which legitimately sit
    // below the floor, cancel between the two bins rather than having to be
    // described again.
    const models = [cubeModel(10, DEFAULT_CUTOUT_CLEARANCE_MM, at(0, 5, INTERIOR_MID_Z))];
    const plain = uncarvedBin();
    const carved = buildCutoutBinBody(m, params({ models })).body;

    const plainBase = plain.trimByPlane([0, 0, -1], -FLOOR_TOP);
    const carvedBase = carved.trimByPlane([0, 0, -1], -FLOOR_TOP);
    expect(carvedBase.volume()).toBeCloseTo(plainBase.volume(), 6);

    // The first layer as its own plan slice, so a change confined to the bed
    // surface cannot hide inside a volume comparison.
    const plainSlice = plain.slice(0.1);
    const carvedSlice = carved.slice(0.1);
    expect(carvedSlice.area()).toBeCloseTo(plainSlice.area(), 6);

    for (const part of [plainSlice, carvedSlice]) part.delete();
    for (const part of [plainBase, carvedBase, plain, carved]) part.delete();
    for (const model of models) model.solid.delete();
  });

  it('leaves the stacking lip intact above a fully buried model', () => {
    // A cutter or a fill reaching into the lip region would quietly ruin
    // stackability, which nothing else in the suite would notice.
    const models = [cubeModel(10, DEFAULT_CUTOUT_CLEARANCE_MM, at(0, 5, INTERIOR_MID_Z))];
    const plain = uncarvedBin();
    const carved = buildCutoutBinBody(m, params({ models })).body;

    const plainLip = plain.trimByPlane([0, 0, 1], BODY_TOP);
    const carvedLip = carved.trimByPlane([0, 0, 1], BODY_TOP);
    expect(plainLip.volume()).toBeGreaterThan(0);
    expect(carvedLip.volume()).toBeCloseTo(plainLip.volume(), 6);

    for (const part of [plainLip, carvedLip, plain, carved]) part.delete();
    for (const model of models) model.solid.delete();
  });

  it('cuts the lip only where a raised model actually passes through it', () => {
    // The other side of the same question: a model raised through the rim is
    // allowed to open its pocket at the top, but it must take exactly the
    // material it occupies there and no more of the lip profile.
    //
    // The lip is the raised rim along the walls, so a model rising out of the
    // middle of the interior passes through the open mouth and touches no lip
    // material at all. Cutting the lip at all means standing over a wall, and
    // that is where this model is put.
    const placement = at(binOuterSizeMm(2) / 2, 5, BODY_TOP + LIP_HEIGHT / 2);
    const models = [cubeModel(20, 0, placement, 'raised.stl')];
    const cutter = placeCutter(models[0].solid, placement);
    const plain = uncarvedBin();
    const carved = buildCutoutBinBody(m, params({ models })).body;

    const plainLip = plain.trimByPlane([0, 0, 1], BODY_TOP);
    const carvedLip = carved.trimByPlane([0, 0, 1], BODY_TOP);
    const passesThrough = plainLip.intersect(cutter);

    expect(passesThrough.volume()).toBeGreaterThan(0);
    expect(plainLip.volume() - carvedLip.volume()).toBeCloseTo(passesThrough.volume(), 6);

    for (const part of [passesThrough, plainLip, carvedLip, plain, carved, cutter]) {
      part.delete();
    }
    for (const model of models) model.solid.delete();
  });
});

describe('unit scale', () => {
  it('carves a pocket 25.4 times the file dimensions for an inch-authored model', () => {
    // The scale is applied before the centring and the simplify, because the
    // tolerance and the clearance are millimetre figures and only mean what
    // they say once the solid is in millimetres.
    const clearanceMm = DEFAULT_CUTOUT_CLEARANCE_MM;
    const solid = prepared(m.Manifold.cube([1, 1, 1], true), clearanceMm, 25.4);
    const models: CutoutModelSpec[] = [
      {
        name: 'inch.stl',
        solid,
        placement: at(0, 5, INTERIOR_MID_Z),
        clearanceMm,
        sweepEnabled: false,
        draftAngleDeg: 0,
      },
    ];
    const pocket = pocketOf(models);

    for (const extent of sizeOf(pocket)) {
      expect(extent).toBeCloseTo(25.4 + 2 * clearanceMm, 6);
    }

    pocket.delete();
    solid.delete();
  });

  it('reports the model size in millimetres after the scale', () => {
    const result = prepareCutoutModel(m, m.Manifold.cube([1, 2, 3], true), {
      name: 'inch.stl',
      unitScale: 25.4,
      clearanceMm: 0,
    });

    expect(result.sizeMm.x).toBeCloseTo(25.4, 6);
    expect(result.sizeMm.y).toBeCloseTo(50.8, 6);
    expect(result.sizeMm.z).toBeCloseTo(76.2, 6);

    result.solid.delete();
  });

  it('centres the prepared model on its own bounding box', () => {
    // Manifold rotates about the origin, so a model authored far from its own
    // origin would swing across the bin when rotated unless it is centred.
    const offCentre = m.Manifold.cube([10, 10, 10], true).translate(100, -60, 40);
    const result = prepareCutoutModel(m, offCentre, {
      name: 'off.stl',
      unitScale: 1,
      clearanceMm: 0,
    });
    const box = result.solid.boundingBox();

    for (let axis = 0; axis < 3; axis += 1) {
      expect((box.min[axis] + box.max[axis]) / 2).toBeCloseTo(0, 6);
    }

    result.solid.delete();
  });
});

describe('clearance is per model', () => {
  it('gives two models in one bin their own dilations', () => {
    // A bin-wide clearance surviving in the implementation would silently give
    // one model the other's fit, so each pocket is measured separately.
    const models = [
      cubeModel(10, 0.4, at(-20, 5, INTERIOR_MID_Z), 'snug.stl'),
      cubeModel(10, 0.8, at(20, 5, INTERIOR_MID_Z), 'loose.stl'),
    ];
    const pocket = pocketOf(models);
    const parts = pocket.decompose().filter((part) => part.volume() > 0);
    const widths = parts.map((part) => sizeOf(part)[0]).sort((a, b) => a - b);

    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeCloseTo(10.8, 6);
    expect(widths[1]).toBeCloseTo(11.6, 6);

    for (const part of parts) part.delete();
    pocket.delete();
    for (const model of models) model.solid.delete();
  });

  it('mixes an exact model and a dilated one in the same bin', () => {
    // The zero clearance fast path is per model, not per bin: one model skips
    // the simplify and the Minkowski sum while the other does not.
    const models = [
      cubeModel(10, 0, at(-20, 5, INTERIOR_MID_Z), 'exact.stl'),
      cubeModel(10, 0.4, at(20, 5, INTERIOR_MID_Z), 'dilated.stl'),
    ];
    const pocket = pocketOf(models);
    const parts = pocket.decompose().filter((part) => part.volume() > 0);
    const widths = parts.map((part) => sizeOf(part)[0]).sort((a, b) => a - b);

    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeCloseTo(10, 6);
    expect(widths[1]).toBeCloseTo(10.8, 6);

    for (const part of parts) part.delete();
    pocket.delete();
    for (const model of models) model.solid.delete();
  });
});

describe('simplifyToleranceMm', () => {
  it('is one quarter of the clearance, and zero for a zero clearance', () => {
    // A hardcoded literal here would be the fudge the derivation exists to
    // avoid: the tolerance is a stated fraction of the fit budget.
    for (const clearanceMm of [0.1, 0.2, 0.4, 0.8, 1]) {
      expect(simplifyToleranceMm(clearanceMm)).toBeCloseTo(clearanceMm / 4, 12);
    }
    expect(simplifyToleranceMm(0.4)).toBeCloseTo(0.1, 12);
    expect(simplifyToleranceMm(0)).toBe(0);
  });
});

describe('the offset sphere resolution', () => {
  it('satisfies the faceting inequality at every clearance', () => {
    // The sphere's faceting error is the sagitta radius * (1 - cos(pi / n)),
    // and the count comes from the shared derivation rather than a literal.
    for (const clearanceMm of [0.1, 0.2, 0.4, 0.8, 1]) {
      const toleranceMm = simplifyToleranceMm(clearanceMm);
      const n = circleSegments(clearanceMm, toleranceMm);

      expect(clearanceMm * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(toleranceMm);
      // Multiple of four, so the axis extremes land on vertices and the pocket
      // measures its nominal size along each axis.
      expect(n % 4).toBe(0);
    }
  });
});

describe('maxClearanceMm', () => {
  it('is half the narrowest interior dimension', () => {
    for (const [gridX, gridY] of [
      [1, 1],
      [2, 1],
      [1, 3],
      [4, 4],
    ]) {
      expect(maxClearanceMm(gridX, gridY)).toBeCloseTo(
        Math.min(binInteriorSizeMm(gridX), binInteriorSizeMm(gridY)) / 2,
        9,
      );
    }
  });

  it('is the same figure the validator message quotes', () => {
    // A ceiling in the message that drifted from the ceiling enforced would
    // tell the user a limit the app does not actually apply.
    const limit = maxClearanceMm(2, 1);

    expect(() => validateClearanceMm(limit, 2, 1)).not.toThrow();
    expect(() => validateClearanceMm(limit + 0.1, 2, 1)).toThrow(
      `A clearance of ${limit + 0.1} mm does not fit a bin 2 by 1 cells, ` +
        `which allows at most ${limit} mm.`,
    );
  });

  it('rejects a negative clearance with its own message', () => {
    expect(() => validateClearanceMm(-0.1, 2, 2)).toThrow(
      'The clearance must be 0 mm or more.',
    );
  });
});

describe('cutoutModelKey', () => {
  it('changes with the clearance and not with the placement', () => {
    // Keying by model alone would silently reuse the old dilation after a
    // clearance change: a wrong printed part with no visible symptom.
    expect(cutoutModelKey('abc', 1, 0.4)).not.toBe(cutoutModelKey('abc', 1, 0.8));
    // The placement is no part of the key at all, which is what makes a drag
    // cheap: the same cached solid serves every placement.
    expect(cutoutModelKey('abc', 1, 0.4)).toBe(cutoutModelKey('abc', 1, 0.4));
  });

  it('changes with the unit scale', () => {
    // A scale correction rescales the model before it is simplified and
    // dilated, so it invalidates the entry exactly as a clearance change does.
    expect(cutoutModelKey('abc', 1, 0.4)).not.toBe(cutoutModelKey('abc', 25.4, 0.4));
  });

  it('leaves other models untouched when one model is recomputed', () => {
    // A clearance change must cost one Minkowski sum, not one per model in the
    // bin, which is only true if the keys are per model.
    const cache = new Map<string, string>([
      [cutoutModelKey('a', 1, 0.4), 'solid a'],
      [cutoutModelKey('b', 1, 0.4), 'solid b'],
    ]);

    cache.delete(cutoutModelKey('a', 1, 0.4));
    cache.set(cutoutModelKey('a', 1, 0.8), 'solid a redone');

    expect(cache.get(cutoutModelKey('b', 1, 0.4))).toBe('solid b');
    expect(cache.has(cutoutModelKey('a', 1, 0.4))).toBe(false);
    expect(cache.get(cutoutModelKey('a', 1, 0.8))).toBe('solid a redone');
  });
});

describe('prepareCutoutModel ownership and reporting', () => {
  it('deletes the solid it is handed', () => {
    // A leak here is invisible in the output and fatal in a long editing
    // session, so it is asserted rather than reviewed.
    const input = m.Manifold.cube([10, 10, 10], true);
    const result = prepareCutoutModel(m, input, {
      name: 'part.stl',
      unitScale: 1,
      clearanceMm: DEFAULT_CUTOUT_CLEARANCE_MM,
    });

    expect(() => input.volume()).toThrow(/deleted object/);

    result.solid.delete();
  });

  it('rejects a negative clearance before touching the solid', () => {
    const input = m.Manifold.cube([10, 10, 10], true);

    expect(() =>
      prepareCutoutModel(m, input, { name: 'part.stl', unitScale: 1, clearanceMm: -1 }),
    ).toThrow('The clearance must be 0 mm or more.');

    input.delete();
  });

  it('reports the triangle count as imported', () => {
    const input = m.Manifold.cube([10, 10, 10], true);
    const triangleCount = input.numTri();
    const result = prepareCutoutModel(m, input, {
      name: 'part.stl',
      unitScale: 1,
      clearanceMm: 0,
    });

    expect(result.triangleCount).toBe(triangleCount);

    result.solid.delete();
  });
});

describe('the wall clock ceiling on the clearance offset', () => {
  it('discards the offset and reports rather than caching when the ceiling is passed', () => {
    // A real STL from the wild can have sliver triangles and near-degenerate
    // geometry that make a Minkowski sum take minutes, and the failure without
    // this is the worst kind: an indeterminate progress bar that never ends
    // and nothing anywhere saying what went wrong. The ceiling is set below
    // any elapsed time here so the mechanism itself is exercised.
    const input = m.Manifold.cube([10, 10, 10], true);

    expect(() =>
      prepareCutoutModel(m, input, {
        name: 'slow.stl',
        unitScale: 1,
        clearanceMm: DEFAULT_CUTOUT_CLEARANCE_MM,
        ceilingMs: -1,
      }),
    ).toThrow(
      'Applying a clearance to the model "slow.stl" took longer than -0.001 seconds and ' +
        'was stopped. The model is probably too complex or has geometry the offset cannot ' +
        'handle. Simplify it in your modelling software and import it again, or import it ' +
        'with a clearance of 0 mm.',
    );
    // Nothing is left behind on the failure path, including the discarded
    // dilation, which is the point of discarding rather than caching it.
    expect(() => input.volume()).toThrow(/deleted object/);
  });

  it('does not apply to a zero clearance import, which runs no offset at all', () => {
    // Naming the zero clearance route in the message is only honest if it
    // really escapes the stage that timed out.
    const input = m.Manifold.cube([10, 10, 10], true);
    const result = prepareCutoutModel(m, input, {
      name: 'slow.stl',
      unitScale: 1,
      clearanceMm: 0,
      ceilingMs: -1,
    });

    expect(result.solid.status()).toBe('NoError');

    result.solid.delete();
  });
});

describe('generateCutoutBin', () => {
  it('produces a body mesh and carries the warnings out with it', () => {
    const models = [cubeModel(10, 0, at(300, 0, INTERIOR_MID_Z), 'away.stl')];
    const result = generateCutoutBin(m, font, params({ models }));

    expect(result.meshes.body.vertices.length).toBeGreaterThan(0);
    expect(result.meshes.label).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.footprints).toHaveLength(1);

    for (const model of models) model.solid.delete();
  });

  it('keeps a fused label as its own mesh', () => {
    const models = [cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z))];
    const result = generateCutoutBin(
      m,
      font,
      params({ models, labelSlot: false, fusedLabel: { text: 'M3', text2: '', icon: null } }),
    );

    expect(result.meshes.label).not.toBeNull();
    expect(result.meshes.label!.vertices.length).toBeGreaterThan(0);

    for (const model of models) model.solid.delete();
  });

  it('folds a non-empty edit list into the body, producing different geometry than none', () => {
    // Download-shaped: no models, exactly what binDownloads.ts sends when the
    // plan's cutout bin has manual edits but no imported models. A remove
    // stroke through the interior must carve extra material out of the body,
    // so the two carves cannot land on the same volume.
    const withoutEdits = generateCutoutBin(m, font, params({ models: [] }));
    const withoutSolid = meshToManifold(m, withoutEdits.meshes.body);
    const withoutVolume = withoutSolid.volume();
    withoutSolid.delete();

    const withEdits = generateCutoutBin(
      m,
      font,
      params({
        models: [],
        edits: [
          {
            kind: 'remove',
            points: [
              { xMm: -10, yMm: 0, zMm: INTERIOR_MID_Z },
              { xMm: 10, yMm: 0, zMm: INTERIOR_MID_Z },
            ],
            radiusMm: 5,
          },
        ],
      }),
    );
    const withSolid = meshToManifold(m, withEdits.meshes.body);
    const withVolume = withSolid.volume();
    withSolid.delete();

    expect(withVolume).toBeLessThan(withoutVolume);
  });
});

describe('generateCutoutBinUnion', () => {
  it('produces one mesh for the single-mesh download', () => {
    const models = [cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z))];
    const result = generateCutoutBinUnion(m, font, params({ models }));

    expect(result.mesh.vertices.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);

    for (const model of models) model.solid.delete();
  });
});

describe('a superseded carve', () => {
  /**
   * The ExecutionContext constructor is on the loaded module but not on the
   * ManifoldToplevel type, exactly as the worker reaches it.
   */
  function newContext(): ExecutionContext {
    const factory = m as unknown as { ExecutionContext: new () => ExecutionContext };
    return new factory.ExecutionContext();
  }

  it('reports supersession rather than an invalid solid', () => {
    // Manifold reports a cancelled evaluation as a status like any other, so
    // without an explicit check a preview the user superseded himself would
    // reach him as "Cutout bin generation produced an invalid solid:
    // Cancelled", which reads as a defect in a bin that is perfectly fine.
    const models = [cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z))];
    const ctx = newContext();
    ctx.cancel();

    let thrown: unknown;
    try {
      generateCutoutBin(m, font, params({ models }), ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CarveCancelledError);
    expect((thrown as Error).message).not.toContain('invalid solid');

    ctx.delete();
    for (const model of models) model.solid.delete();
  });

  it('carves normally under a context that was never cancelled', () => {
    // The context must not change the result of the carve it observes, or
    // every preview would differ from the download of the same bin.
    const models = [cubeModel(10, 0, at(0, 5, INTERIOR_MID_Z))];
    const ctx = newContext();

    const observed = generateCutoutBin(m, font, params({ models }), ctx);
    const plain = generateCutoutBin(m, font, params({ models }));

    expect(observed.meshes.body.vertices.length).toBe(plain.meshes.body.vertices.length);
    expect(observed.warnings).toEqual(plain.warnings);

    ctx.delete();
    for (const model of models) model.solid.delete();
  });
});
