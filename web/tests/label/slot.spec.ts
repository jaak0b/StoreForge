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
  SLOT_DEPTH,
  SLOT_FRONT_INSET,
} from '../../src/engine/label/slot';
import {
  buildFoot,
  buildInsertInSlotSolids,
  buildSlottedBinBody,
  generateInsertUnion,
  generateSlottedBin,
} from '../../src/engine/gridfinity/binGenerator';
import { binOuterSizeMm, HEIGHT_UNIT } from '../../src/engine/gridfinity/constants';
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

  it('raises the label above the constant-thickness plate', () => {
    const { body, label } = buildInsertSolids(m, font, { text: 'M3 x 20', icon: null }, 1);
    expect(label).not.toBeNull();
    expect(body.status()).toBe('NoError');
    expect(label!.status()).toBe('NoError');
    // The plate keeps its full 0.8 mm; the label stands 0.2 proud of it
    // (the channel's vertical clearance: 1.0 slot height minus the 0.8
    // plate), ending flush with the nominal bin top when seated.
    expect(body.boundingBox().max[2]).toBeCloseTo(0.8, 6);
    expect(label!.boundingBox().max[2]).toBeCloseTo(1.0, 6);
    // The label reaches the 0.05 weld below the plate top.
    expect(label!.boundingBox().min[2]).toBeCloseTo(0.75, 6);
    // Welded: the face reaches into the plate below its top.
    const overlap = label!.intersect(body);
    expect(overlap.isEmpty()).toBe(false);
    overlap.delete();
    // The plate itself is identical with and without a label.
    const blank = buildInsertSolids(m, font, { text: '', icon: null }, 1);
    expect(body.volume()).toBeCloseTo(blank.body.volume(), 6);
    blank.body.delete();
    body.delete();
    label!.delete();
  });

  it('unions to one watertight solid with the raised text on top for the STL download', () => {
    const mesh = generateInsertUnion(m, font, { cells: 1, content: { text: 'M3 x 20', icon: null } });
    let maxZ = -Infinity;
    for (let i = 2; i < mesh.vertices.length; i += 3) {
      maxZ = Math.max(maxZ, mesh.vertices[i]);
    }
    // Plate 0.8 plus the 0.2 raised text.
    expect(maxZ).toBeCloseTo(1.0, 6);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });
});

describe('buildSlotShelf', () => {
  it('is watertight and stops at the nominal bin top', () => {
    // The shelf adds nothing above the nominal top: on a lipped bin the tab
    // pockets sit inside the walls' lip support band, whose own material
    // forms the retaining ceilings (matching the reference bin, whose
    // ceiling is the lip seat's 45 degree taper overhead).
    const shelf = buildSlotShelf(m, binParams());
    expect(shelf.status()).toBe('NoError');
    expect(shelf.boundingBox().max[2]).toBeCloseTo(21, 6);
    shelf.delete();
  });
});

describe('slotted bin front region (measured against the Pred 1x1x6 mesh)', () => {
  /** Intersection volume of the body with an axis-aligned probe box. */
  function probeVolume(
    body: Manifold,
    min: [number, number, number],
    max: [number, number, number],
  ): number {
    const probe = m.Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).translate(
      ...min,
    );
    const overlap = body.intersect(probe);
    const volume = overlap.volume();
    probe.delete();
    overlap.delete();
    return volume;
  }

  it('is watertight with genus 0 (no handles, no internal gaps)', () => {
    const body = buildSlottedBinBody(m, binParams());
    expect(body.status()).toBe('NoError');
    expect(body.genus()).toBe(0);
    body.delete();
  });

  it('carries the measured support ribs under the shelf plate', () => {
    // Reference 1x1x6 mesh: 1.0 mm plate (channel floor z 36.25, underside
    // 35.25) on three 0.8 mm ribs at quarter-pitch centres, each rib a 45
    // degree triangle from the channel's back edge at the underside down to
    // the front wall (plan section y 33: rib slabs x 20.475..21.275 solid
    // from z 29.4 up to 35.25, air between ribs at x 3.5). Mapped to our
    // 1x1x6 frame (bin centred, z up from the bed, nominal top 42): the
    // centre rib at x 0 is solid at (0, -12, 36), and x 5 between ribs is
    // air. The previous rib layout (wall-thickness ribs, flush ends, 16 mm
    // max span) left air at x 0.
    const body = buildSlottedBinBody(m, binParams({ heightUnits: 6 }));
    const inRib = probeVolume(body, [-0.2, -12.2, 35.8], [0.2, -11.8, 36.2]);
    expect(inRib).toBeCloseTo(0.4 * 0.4 * 0.4, 4);
    const betweenRibs = probeVolume(body, [4.8, -12.2, 35.8], [5.2, -11.8, 36.2]);
    expect(Math.abs(betweenRibs)).toBeLessThan(1e-9);
    body.delete();
  });

  it('truncates the ribs at the interior floor on a shallow bin and stays watertight', () => {
    // heightUnits 2 (14 mm): the full 45 degree hypotenuse would end below
    // the floor, so the rib is clipped at the floor top (7 mm) and rests on
    // the floor plate. Plate underside at 12; at z 7.5 the centre rib is
    // solid at y -12 (between the wall and the hypotenuse, which lies at
    // y -10.65 there).
    const body = buildSlottedBinBody(m, binParams({ heightUnits: 2 }));
    expect(body.status()).toBe('NoError');
    expect(body.genus()).toBe(0);
    const inRib = probeVolume(body, [-0.2, -12.2, 7.3], [0.2, -11.8, 7.7]);
    expect(inRib).toBeCloseTo(0.4 * 0.4 * 0.4, 4);
    body.delete();
  });

  it('keeps the lip support band solid in front of the channel', () => {
    // The channel front edge is flush with the lip's inner support face,
    // 2.6 (LIP_DEPTH) behind the outer face: measured on the reference bin
    // at y 39.15 on its 41.75 face, channel floor z 36.25, nominal top
    // 37.25 (x = 21 cross-section). heightUnits 3: front face at -20.75,
    // band from -18.15 outward, channel z 20..21. The band between the rim
    // groove (0.7 deep) and the channel face must be fully solid; before
    // the fix the channel cut a notch into it, leaving the lip overhanging
    // the notch with a flat unsupported underside.
    const body = buildSlottedBinBody(m, binParams());
    const volume = probeVolume(body, [-1, -19.5, 20.1], [1, -18.3, 20.9]);
    expect(volume).toBeCloseTo(2 * 1.2 * 0.8, 3);
    body.delete();
  });

  it('has no material overhanging the channel: the column above the open span is empty', () => {
    // On the reference bin nothing hangs over the channel: the lip's inner
    // profile above the channel front edge is vertical or leans outward at
    // 45 degrees all the way to the crest (measured faces y 39.15 vertical,
    // 45 degree ramp to y 39.85, vertical to z 39.75, 45 degrees to the
    // crest round, x = 21 cross-section). So the whole column above the
    // channel's open span, from the channel floor to above the crest apex,
    // must be empty; any material in it would print as an unsupported
    // overhang over the slot.
    const p = binParams();
    const body = buildSlottedBinBody(m, p);
    const yFront = -binOuterSizeMm(p.gridY) / 2 + SLOT_FRONT_INSET;
    const volume = probeVolume(
      body,
      [-17, yFront + 0.05, 20.05],
      // Stop 0.5 short of the channel back edge to stay clear of the end
      // stop ridge, and reach past the crest apex (21 + 3.552).
      [17, yFront + SLOT_DEPTH - 0.5, 25],
    );
    expect(Math.abs(volume)).toBeLessThan(1e-9);
    body.delete();
  });

  it('retains the lip band ceiling over the tab pockets', () => {
    // The pocket void spans x 18.15..19.15, y -15.5..-8.8, z 20..21 on the
    // 1x1x3 bin (reference pocket x 1.85..2.85, y 29.8..36.5, z 36.25..37.25
    // on the 1x1x6 mesh). Above it the side wall's lip seat taper provides
    // the ceiling: at x = 18.4..19.0 (1.75..2.35 from the side face) the
    // taper face lies at z 21.25 or higher, so a probe just above the
    // nominal top must be fully solid.
    const body = buildSlottedBinBody(m, binParams());
    for (const side of [-1, 1]) {
      const volume = probeVolume(
        body,
        [side === -1 ? -19.0 : 18.4, -13, 21.02],
        [side === -1 ? -18.4 : 19.0, -11, 21.2],
      );
      expect(volume).toBeCloseTo(0.6 * 2 * 0.18, 3);
    }
    body.delete();
  });

  it('still seats a stacked foot: the slot leaves the lip seat unobstructed', () => {
    // The reference bin's stacking seat runs clean around the whole
    // perimeter (plan section at z 37.6: one uniform rounded-rectangle
    // opening). Before the fix, raised pocket blocks stood in the seat's
    // front corners and a stacked bin could not sit down.
    const body = buildSlottedBinBody(m, binParams());
    const foot = buildFoot(m);
    const seated = foot.translate(0, 0, 3 * HEIGHT_UNIT);
    const overlap = body.intersect(seated);
    expect(Math.abs(overlap.volume())).toBeLessThan(1e-9);
    overlap.delete();
    seated.delete();
    foot.delete();
    body.delete();
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

  it('has no slot shelf at all on a bin built without the label slot', () => {
    const p = binParams();
    const slotted = buildSlottedBinBody(m, p);
    const plain = buildSlottedBinBody(m, { ...p, labelSlot: false });
    // Probe the shelf plate region under the channel floor (heightUnits 3:
    // floor at 20.0, plate below it, inside the front interior): the slotted
    // bin has material there, the plain bin's interior is open. The probe
    // stays clear of the front wall, whose stacking lip support bulges 2.6
    // inward from the outer face (18.15 from centre) near the top.
    const probe = m.Manifold.cube([4, 3, 0.5], true).translate(0, -15, 19.5);
    const inSlotted = slotted.intersect(probe);
    const inPlain = plain.intersect(probe);
    expect(inSlotted.volume()).toBeGreaterThan(0.01);
    expect(Math.abs(inPlain.volume())).toBeLessThan(1e-9);
    inSlotted.delete();
    inPlain.delete();
    probe.delete();
    slotted.delete();
    plain.delete();
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

  it('previews the paired insert with only its raised label face on the label mesh', () => {
    const result = generateSlottedBin(m, font, params());
    expect(result.label).not.toBeNull();
    // The label mesh is the raised face alone: it stands on the plate top
    // 0.8 above the channel floor, welded 0.05 into the plate, so its
    // lowest point is 20.75 for a 3-unit bin (channel floor at 20.0). The
    // plate itself joins the body mesh and rests on the channel floor.
    let minZ = Infinity;
    for (let i = 2; i < result.label!.vertices.length; i += 3) {
      minZ = Math.min(minZ, result.label!.vertices[i]);
    }
    expect(minZ).toBeCloseTo(20.75, 5);
    let bodyMinAtFront = Infinity;
    for (let i = 0; i < result.body.vertices.length; i += 3) {
      const y = result.body.vertices[i + 1];
      const z = result.body.vertices[i + 2];
      // Sample the channel region (front of the bin) above the shelf plate.
      if (y < -8 && z > 19.9) bodyMinAtFront = Math.min(bodyMinAtFront, z);
    }
    expect(bodyMinAtFront).toBeCloseTo(20.0, 5);
  });

  it('placed preview insert build matches the standalone insert position', () => {
    const p = params();
    const placed = buildInsertInSlotSolids(m, font, p.insert!, p);
    expect(placed.plate.status()).toBe('NoError');
    expect(placed.plate.boundingBox().min[2]).toBeCloseTo(20.0, 6);
    expect(placed.label).not.toBeNull();
    // The raised label face ends flush with the nominal bin top: 21.0 for a
    // 3-unit bin.
    expect(placed.label!.boundingBox().max[2]).toBeCloseTo(21.0, 6);
    placed.plate.delete();
    placed.label!.delete();
  });
});
