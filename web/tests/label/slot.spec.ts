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
  buildSlottedBinBody,
  generateInsertUnion,
  generateSlottedBin,
} from '../../src/engine/gridfinity/binGenerator';
import type { BinParams, SlottedBinParams } from '../../src/engine/gridfinity/types';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

function binParams(overrides: Partial<BinParams> = {}): BinParams {
  return {
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    ...overrides,
  };
}

function params(overrides: Partial<SlottedBinParams> = {}): SlottedBinParams {
  return { ...binParams(), insert: { text: 'M3', text2: '', icon: null }, ...overrides };
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
    // Measured from the Pred x1 label mesh: 37.8 x 11.5 x 0.8 mm overall.
    expect(box.max[0] - box.min[0]).toBeCloseTo(37.8, 3);
    expect(box.max[1] - box.min[1]).toBeCloseTo(11.5, 6);
    expect(box.max[2] - box.min[2]).toBeCloseTo(0.8, 6);
    expect(box.min[2]).toBeCloseTo(0, 6);
    expect(body.status()).toBe('NoError');
    // The two push-out through-holes give the plate genus 2.
    expect(body.genus()).toBe(2);
    body.delete();
  });

  it('carries the reference end tabs: 35.8 mm plate plus a 1.0 x 5.7 mm tab per end', () => {
    const { body } = buildInsertSolids(m, font, { text: '', icon: null }, 1);
    // Away from the centreline (beyond the 5.7 mm tab band) only the plate
    // remains: a slab there measures the 35.8 mm plate length. Measured from
    // the Pred x1 label mesh (plate ends 1.0 inside the 37.8 mm total).
    const offCentre = m.Manifold.cube([100, 2, 2], true).translate(0, 4.5, 0.4);
    const plateOnly = body.intersect(offCentre);
    const plateBox = plateOnly.boundingBox();
    expect(plateBox.max[0] - plateBox.min[0]).toBeCloseTo(35.8, 3);
    offCentre.delete();
    plateOnly.delete();
    // On the centreline the tabs reach the full 37.8 mm.
    const onCentre = m.Manifold.cube([100, 2, 2], true).translate(0, 0, 0.4);
    const withTabs = body.intersect(onCentre);
    const tabBox = withTabs.boundingBox();
    expect(tabBox.max[0] - tabBox.min[0]).toBeCloseTo(37.8, 3);
    onCentre.delete();
    withTabs.delete();
    body.delete();
  });

  it('pierces a 1.5 mm push-out hole 1.5 mm from each tab tip', () => {
    const { body } = buildInsertSolids(m, font, { text: '', icon: null }, 1);
    // Measured from the Pred x1 label mesh: hole centres 1.5 from the tips
    // on the centreline, so at x = 17.4 for the 37.8 mm insert.
    for (const side of [-1, 1]) {
      const pin = m.Manifold.cylinder(2, 0.5, 0.5, 16).translate(side * 17.4, 0, -0.5);
      const overlap = body.intersect(pin);
      expect(Math.abs(overlap.volume())).toBeLessThan(1e-9);
      pin.delete();
      overlap.delete();
    }
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
    const mesh = generateInsertUnion(m, font, { cells: 1, content: { text: 'M3 x 20', icon: null } });
    let maxZ = -Infinity;
    for (let i = 2; i < mesh.vertices.length; i += 3) {
      maxZ = Math.max(maxZ, mesh.vertices[i]);
    }
    expect(maxZ).toBeCloseTo(0.8, 6);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });
});

describe('buildSlotShelf', () => {
  it('is watertight and carries the pocket ceilings above the bin top', () => {
    const shelf = buildSlotShelf(m, binParams());
    expect(shelf.status()).toBe('NoError');
    const box = shelf.boundingBox();
    // heightUnits 3: nominal top 21; the tab-pocket ceilings rise 0.65 above
    // (measured 0.65 of material over the pocket on the reference bin).
    expect(box.max[2]).toBeCloseTo(21.65, 6);
    shelf.delete();
  });

  it('keeps a flat-topped bin flat: no ceilings without a stacking lip', () => {
    const shelf = buildSlotShelf(m, binParams({ stackingLip: false }));
    expect(shelf.boundingBox().max[2]).toBeCloseTo(21, 6);
    shelf.delete();
  });
});

describe('insert in slot', () => {
  function placedInsert(p: BinParams & { labelText: string }): Manifold {
    const { body, label } = buildInsertSolids(m, font, { text: p.labelText, icon: null }, p.gridX);
    const parts = label === null ? [body] : [body, label];
    const at = insertPositionInBin(p);
    const placed = m.Manifold.union(parts).translate(at.x, at.y, at.z);
    body.delete();
    label?.delete();
    return placed;
  }

  it('rests in the slot without touching the bin body (clearance fit)', () => {
    const p = binParams();
    const body = buildSlottedBinBody(m, p);
    const insert = placedInsert({ ...p, labelText: 'M3' });
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

  it('is retained: a lifted insert hits the tab-pocket ceilings', () => {
    const p = binParams();
    const body = buildSlottedBinBody(m, p);
    const lifted = placedInsert({ ...p, labelText: 'M3' }).translate(0, 0, 0.4);
    const overlap = lifted.intersect(body);
    expect(overlap.volume()).toBeGreaterThan(0.01);
    overlap.delete();
    body.delete();
    lifted.delete();
  });

  it('lifts freely out of a flat-topped bin, whose pockets have no ceiling', () => {
    const p = binParams({ stackingLip: false });
    const body = buildSlottedBinBody(m, p);
    const lifted = placedInsert({ ...p, labelText: 'M3' }).translate(0, 0, 0.4);
    const overlap = lifted.intersect(body);
    expect(Math.abs(overlap.volume())).toBeLessThan(1e-9);
    overlap.delete();
    body.delete();
    lifted.delete();
  });

  it('cannot slide sideways past the channel ends', () => {
    const p = binParams();
    const body = buildSlottedBinBody(m, p);
    const shifted = placedInsert({ ...p, labelText: 'M3' }).translate(1.5, 0, 0);
    const overlap = shifted.intersect(body);
    expect(overlap.volume()).toBeGreaterThan(0.01);
    overlap.delete();
    body.delete();
    shifted.delete();
  });

  it('cannot slide into the bin interior past the end stop', () => {
    const p = binParams();
    const body = buildSlottedBinBody(m, p);
    const shifted = placedInsert({ ...p, labelText: 'M3' }).translate(0, 1.5, 0);
    const overlap = shifted.intersect(body);
    expect(overlap.volume()).toBeGreaterThan(0.01);
    overlap.delete();
    body.delete();
    shifted.delete();
  });
});

describe('generateSlottedBin with and without a paired insert', () => {
  it('returns the slotted bin with no label mesh when the slot is empty', () => {
    const result = generateSlottedBin(m, font, params({ insert: null }));
    expect(result.label).toBeNull();
    expect(result.body.indices.length).toBeGreaterThan(0);
  });

  it('previews the insert in place on the label mesh when one is paired', () => {
    const result = generateSlottedBin(m, font, params());
    expect(result.label).not.toBeNull();
    // The preview insert lies in the slot: its lowest point is the channel
    // floor at 20.0 for a 3-unit bin.
    let minZ = Infinity;
    for (let i = 2; i < result.label!.vertices.length; i += 3) {
      minZ = Math.min(minZ, result.label!.vertices[i]);
    }
    expect(minZ).toBeCloseTo(20.0, 5);
  });

  it('placed preview insert build matches the standalone insert position', () => {
    const p = params();
    const placed = buildInsertPlacedInSlot(m, font, p.insert!, p);
    expect(placed.status()).toBe('NoError');
    expect(placed.boundingBox().min[2]).toBeCloseTo(20.0, 6);
    placed.delete();
  });
});
