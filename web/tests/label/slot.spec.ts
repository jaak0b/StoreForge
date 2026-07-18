import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from 'opentype.js';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import {
  buildInsertSolids,
  buildSlotShelf,
  insertLengthMm,
  insertPositionInBin,
} from '../../src/engine/label/slot';
import {
  buildInsertPlacedInSlot,
  buildLabeledBody,
  generateLabeledBin,
  generateLabelInsertUnion,
} from '../../src/engine/gridfinity/binGenerator';
import type { LabeledBinParams } from '../../src/engine/gridfinity/types';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

function params(overrides: Partial<LabeledBinParams> = {}): LabeledBinParams {
  return {
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    labelText: 'M3',
    labelText2: '',
    labelIcon: null,
    labelMode: 'slot',
    ...overrides,
  };
}

describe('insertLengthMm', () => {
  it('matches the reference model: 37.8 mm for one cell, 79.8 mm for two', () => {
    // Measured from the Pred model's published label meshes (x1 label 3MF
    // bounding box 37.8 mm, x2 blank STEP 79.8 mm).
    expect(insertLengthMm(1)).toBeCloseTo(37.8, 6);
    expect(insertLengthMm(2)).toBeCloseTo(79.8, 6);
  });
});

describe('buildInsertSolids', () => {
  it('builds a plate with the reference dimensions', () => {
    const { body, label } = buildInsertSolids(m, font, { text: '', icon: null }, 1);
    expect(label).toBeNull();
    const box = body.boundingBox();
    // Measured from the Pred x1 label mesh: 37.8 x 11.5 x 0.8 mm.
    expect(box.max[0] - box.min[0]).toBeCloseTo(37.8, 3);
    expect(box.max[1] - box.min[1]).toBeCloseTo(11.5, 6);
    expect(box.max[2] - box.min[2]).toBeCloseTo(0.8, 6);
    expect(box.min[2]).toBeCloseTo(0, 6);
    expect(body.status()).toBe('NoError');
    expect(body.genus()).toBe(0);
    body.delete();
  });

  it('inlays the label flush with the plate top as a separate welded solid', () => {
    const { body, label } = buildInsertSolids(m, font, { text: 'M3 x 20', icon: null }, 1);
    expect(label).not.toBeNull();
    expect(body.status()).toBe('NoError');
    expect(label!.status()).toBe('NoError');
    // Flush top: neither part rises above the 0.8 mm plate.
    expect(body.boundingBox().max[2]).toBeCloseTo(0.8, 6);
    expect(label!.boundingBox().max[2]).toBeCloseTo(0.8, 6);
    // Welded: the inlay reaches into the plate below its pocket floor.
    const overlap = label!.intersect(body);
    expect(overlap.isEmpty()).toBe(false);
    overlap.delete();
    // The pocket removes material from the plate.
    const blank = buildInsertSolids(m, font, { text: '', icon: null }, 1);
    expect(body.volume()).toBeLessThan(blank.body.volume());
    blank.body.delete();
    body.delete();
    label!.delete();
  });

  it('unions to one watertight solid with a flat top for the STL download', () => {
    const mesh = generateLabelInsertUnion(m, font, params({ labelMode: 'insert' }));
    let maxZ = -Infinity;
    for (let i = 2; i < mesh.vertices.length; i += 3) {
      maxZ = Math.max(maxZ, mesh.vertices[i]);
    }
    expect(maxZ).toBeCloseTo(0.8, 6);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });
});

describe('buildSlotShelf', () => {
  it('is watertight and stays inside the bin height plus the front overhang', () => {
    const shelf = buildSlotShelf(m, params());
    expect(shelf.status()).toBe('NoError');
    const box = shelf.boundingBox();
    // heightUnits 3: nominal top 21; the front overhang strip rises 0.7 above.
    expect(box.max[2]).toBeCloseTo(21.7, 6);
    shelf.delete();
  });

  it('keeps a flat-topped bin flat: no overhang without a stacking lip', () => {
    const shelf = buildSlotShelf(m, params({ stackingLip: false }));
    expect(shelf.boundingBox().max[2]).toBeCloseTo(21, 6);
    shelf.delete();
  });
});

describe('insert in slot', () => {
  function placedInsert(p: LabeledBinParams): Manifold {
    const { body, label } = buildInsertSolids(
      m,
      font,
      { text: p.labelText, icon: null },
      p.gridX,
    );
    const parts = label === null ? [body] : [body, label];
    const at = insertPositionInBin(p);
    const placed = m.Manifold.union(parts).translate(at.x, at.y, at.z);
    body.delete();
    label?.delete();
    return placed;
  }

  it('rests in the slot without touching the bin body (clearance fit)', () => {
    const p = params();
    const body = buildLabeledBody(m, p);
    const insert = placedInsert(p);
    const overlap = insert.intersect(body);
    // The insert rests on the channel floor (coincident faces), so the
    // intersection may be a zero-volume film, but never solid material.
    expect(Math.abs(overlap.volume())).toBeLessThan(1e-9);
    overlap.delete();
    // The insert sits on the channel floor: heightUnits 3, floor at 20.0.
    expect(insert.boundingBox().min[2]).toBeCloseTo(20.0, 6);
    body.delete();
    insert.delete();
  });

  it('is retained: lifting the insert makes it collide with the slot geometry', () => {
    const p = params();
    const body = buildLabeledBody(m, p);
    const lifted = placedInsert(p).translate(0, 0, 0.4);
    const overlap = lifted.intersect(body);
    expect(overlap.volume()).toBeGreaterThan(0.01);
    overlap.delete();
    body.delete();
    lifted.delete();
  });

  it('cannot slide sideways past the side cheeks', () => {
    const p = params();
    const body = buildLabeledBody(m, p);
    const shifted = placedInsert(p).translate(1.5, 0, 0);
    const overlap = shifted.intersect(body);
    expect(overlap.volume()).toBeGreaterThan(0.01);
    overlap.delete();
    body.delete();
    shifted.delete();
  });
});

describe('generateLabeledBin label modes', () => {
  it("mode 'slot' returns the slotted bin with no label mesh", () => {
    const result = generateLabeledBin(m, font, params({ labelMode: 'slot' }));
    expect(result.label).toBeNull();
    expect(result.body.indices.length).toBeGreaterThan(0);
  });

  it("mode 'slot-insert' previews the insert in place on the label mesh", () => {
    const result = generateLabeledBin(m, font, params({ labelMode: 'slot-insert' }));
    expect(result.label).not.toBeNull();
    // The preview insert lies in the slot: its lowest point is the channel
    // floor at 20.0 for a 3-unit bin.
    let minZ = Infinity;
    for (let i = 2; i < result.label!.vertices.length; i += 3) {
      minZ = Math.min(minZ, result.label!.vertices[i]);
    }
    expect(minZ).toBeCloseTo(20.0, 5);
  });

  it("mode 'insert' returns just the insert plate and inlay", () => {
    const result = generateLabeledBin(m, font, params({ labelMode: 'insert' }));
    expect(result.label).not.toBeNull();
    let maxZ = -Infinity;
    for (let i = 2; i < result.body.vertices.length; i += 3) {
      maxZ = Math.max(maxZ, result.body.vertices[i]);
    }
    expect(maxZ).toBeCloseTo(0.8, 6);
  });

  it('placed preview insert build matches the standalone insert position', () => {
    const placed = buildInsertPlacedInSlot(m, font, params({ labelMode: 'slot-insert' }));
    expect(placed.status()).toBe('NoError');
    expect(placed.boundingBox().min[2]).toBeCloseTo(20.0, 6);
    placed.delete();
  });
});
