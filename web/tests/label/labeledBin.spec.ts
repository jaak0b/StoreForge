import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from 'opentype.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import {
  generateBin,
  generateLabeledBin,
  generateLabeledBinUnion,
} from '../../src/engine/gridfinity/binGenerator';
import {
  buildLabelManifold,
  buildLabelShelf,
  EMBOSS_HEIGHT,
  EMBOSS_WELD_DEPTH,
  LABEL_MARGIN,
  SHELF_DEPTH,
  SHELF_THICKNESS,
} from '../../src/engine/label/placement';
import { iconByName } from '../../src/engine/label/icons';
import {
  HEIGHT_UNIT,
  PITCH,
  WALL_THICKNESS,
} from '../../src/engine/gridfinity/constants';
import type { LabeledBinParams, MeshData } from '../../src/engine/gridfinity/types';

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
    stackingLip: false,
    magnetHoles: false,
    labelText: 'M3',
    labelIcon: null,
    ...overrides,
  };
}

/** Signed volume of a triangle mesh (divergence theorem over tetrahedra). */
function meshVolume(mesh: MeshData): number {
  const v = mesh.vertices;
  const idx = mesh.indices;
  let volume = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    volume +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
        v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  return volume;
}

function meshMaxZ(mesh: MeshData): number {
  let max = -Infinity;
  for (let i = 2; i < mesh.vertices.length; i += 3) {
    max = Math.max(max, mesh.vertices[i]);
  }
  return max;
}

const outerWidth = PITCH - 0.5;
const outerDepth = PITCH - 0.5;
const bodyTop = 3 * HEIGHT_UNIT;
const shelfFrontY = -outerDepth / 2;
const shelfBackY = shelfFrontY + WALL_THICKNESS + SHELF_DEPTH;

describe('buildLabelShelf', () => {
  it('spans the top front edge, flush with the bin top', () => {
    const shelf = buildLabelShelf(m, params());
    const box = shelf.boundingBox();
    expect(box.max[2]).toBeCloseTo(bodyTop, 6);
    expect(box.min[1]).toBeCloseTo(shelfFrontY, 6);
    expect(box.max[1]).toBeCloseTo(shelfBackY, 6);
    // Clipped to the bin outline, so it never protrudes sideways.
    expect(box.min[0]).toBeGreaterThanOrEqual(-outerWidth / 2 - 1e-6);
    expect(box.max[0]).toBeLessThanOrEqual(outerWidth / 2 + 1e-6);
    shelf.delete();
  });

  it('has a support chamfer whose cross-section narrows downward toward the front wall', () => {
    const shelf = buildLabelShelf(m, params());
    const plateBottom = bodyTop - SHELF_THICKNESS;
    const depthOf = (zLow: number, zHigh: number): number => {
      const slab = m.Manifold.cube([200, 200, zHigh - zLow], true).translate(
        0,
        0,
        (zLow + zHigh) / 2,
      );
      const cut = m.Manifold.intersection(shelf, slab);
      const box = cut.boundingBox();
      const empty = cut.isEmpty();
      slab.delete();
      cut.delete();
      return empty ? 0 : box.max[1] - box.min[1];
    };
    // Material exists below the plate (the chamfer), and its front-to-back
    // extent shrinks with depth: a 45-degree wedge leaning on the front wall.
    const nearPlate = depthOf(plateBottom - 2, plateBottom - 1);
    const deeper = depthOf(plateBottom - 8, plateBottom - 7);
    expect(nearPlate).toBeGreaterThan(0);
    expect(deeper).toBeGreaterThan(0);
    expect(deeper).toBeLessThan(nearPlate);
    // Both slices stay attached to the front wall.
    expect(nearPlate).toBeGreaterThan(WALL_THICKNESS);
    shelf.delete();
  });
});

describe('buildLabelManifold', () => {
  it('rests the label on the shelf top face, raised by the emboss height', () => {
    const label = buildLabelManifold(m, font, params(), { text: 'M3', icon: null });
    expect(label).not.toBeNull();
    const box = label!.boundingBox();
    expect(box.max[2]).toBeCloseTo(bodyTop + EMBOSS_HEIGHT, 6);
    expect(box.min[2]).toBeCloseTo(bodyTop - EMBOSS_WELD_DEPTH, 6);
    // Within the shelf footprint.
    expect(box.min[1]).toBeGreaterThan(shelfFrontY + WALL_THICKNESS);
    expect(box.max[1]).toBeLessThan(shelfBackY);
    label!.delete();
  });

  it('keeps the label within the interior width margins', () => {
    const label = buildLabelManifold(m, font, params(), {
      text: 'M3 COUNTERSUNK WOOD SCREWS 12 mm',
      icon: null,
    })!;
    const interiorHalf = (outerWidth - 2 * WALL_THICKNESS) / 2;
    const box = label.boundingBox();
    expect(box.min[0]).toBeGreaterThanOrEqual(-(interiorHalf - LABEL_MARGIN) - 1e-6);
    expect(box.max[0]).toBeLessThanOrEqual(interiorHalf - LABEL_MARGIN + 1e-6);
    label.delete();
  });

  it('shrinks long text to fit', () => {
    const short = buildLabelManifold(m, font, params(), { text: 'M3', icon: null })!;
    const long = buildLabelManifold(m, font, params(), {
      text: 'M3 COUNTERSUNK WOOD SCREWS 12 mm',
      icon: null,
    })!;
    const shortBox = short.boundingBox();
    const longBox = long.boundingBox();
    // The long label is shrunk: its glyphs are shorter front to back.
    expect(longBox.max[1] - longBox.min[1]).toBeLessThan(
      shortBox.max[1] - shortBox.min[1],
    );
    short.delete();
    long.delete();
  });

  it('returns null for an empty label spec', () => {
    expect(buildLabelManifold(m, font, params(), { text: '  ', icon: null })).toBeNull();
  });

  it('places the icon left of the text', () => {
    const textOnly = buildLabelManifold(m, font, params(), { text: 'M3', icon: null })!;
    const withIcon = buildLabelManifold(m, font, params(), {
      text: 'M3',
      icon: iconByName('washer'),
    })!;
    const textBox = textOnly.boundingBox();
    const bothBox = withIcon.boundingBox();
    expect(bothBox.max[0] - bothBox.min[0]).toBeGreaterThan(
      textBox.max[0] - textBox.min[0],
    );
    textOnly.delete();
    withIcon.delete();
  });
});

describe('generateLabeledBin', () => {
  it('returns separate watertight body and label meshes', () => {
    const result = generateLabeledBin(m, font, params({ labelIcon: 'washer' }));
    expect(result.label).not.toBeNull();
    for (const mesh of [result.body, result.label!]) {
      expect(mesh.vertices.length % 3).toBe(0);
      expect(mesh.indices.length % 3).toBe(0);
      expect(mesh.indices.length).toBeGreaterThan(0);
    }
  });

  it('adds the shelf to the body when a label is present', () => {
    const plain = generateLabeledBin(m, font, params({ labelText: '', labelIcon: null }));
    const labeled = generateLabeledBin(m, font, params());
    expect(meshVolume(labeled.body)).toBeGreaterThan(meshVolume(plain.body));
  });

  it('does not raise the body top above the bin top', () => {
    const labeled = generateLabeledBin(m, font, params());
    expect(meshMaxZ(labeled.body)).toBeCloseTo(bodyTop, 6);
    const withLip = generateLabeledBin(m, font, params({ stackingLip: true }));
    expect(meshMaxZ(withLip.body)).toBeGreaterThan(bodyTop);
  });

  it('returns a plain bin with no shelf when there is no text and no icon', () => {
    const noLabel = generateLabeledBin(m, font, params({ labelText: '', labelIcon: null }));
    expect(noLabel.label).toBeNull();
    // Same solid as a bin generated without any label machinery: identical volume.
    const reference = generateBin(m, params());
    expect(meshVolume(noLabel.body)).toBeCloseTo(meshVolume(reference), 6);
  });
});

describe('generateLabeledBinUnion', () => {
  it('produces one welded mesh whose volume exceeds body plus shelf alone', () => {
    const labeled = generateLabeledBin(m, font, params());
    const union = generateLabeledBinUnion(m, font, params());
    const bodyVolume = meshVolume(labeled.body);
    const unionVolume = meshVolume(union);
    expect(unionVolume).toBeGreaterThan(bodyVolume);
    // The label overlaps the shelf by the weld depth, so the union is smaller
    // than the plain sum of the two meshes.
    expect(unionVolume).toBeLessThan(bodyVolume + meshVolume(labeled.label!));
  });
});
