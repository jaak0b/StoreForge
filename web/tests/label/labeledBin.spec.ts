import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from 'opentype.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import {
  generateLabeledBin,
  generateLabeledBinUnion,
} from '../../src/engine/gridfinity/binGenerator';
import { buildLabelManifold, EMBOSS_HEIGHT } from '../../src/engine/label/placement';
import { iconByName } from '../../src/engine/label/icons';
import { PITCH } from '../../src/engine/gridfinity/constants';
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
    stackingLip: false,
    magnetHoles: false,
    labelText: 'M3',
    labelIcon: null,
    ...overrides,
  };
}

describe('buildLabelManifold', () => {
  it('places the label on the front wall, protruding by the emboss height', () => {
    const p = params();
    const label = buildLabelManifold(m, font, p, { text: 'M3', icon: null });
    expect(label).not.toBeNull();
    const box = label!.boundingBox();
    const frontY = -(PITCH - 0.5) / 2;
    expect(box.min[1]).toBeCloseTo(frontY - EMBOSS_HEIGHT, 6);
    expect(box.max[1]).toBeGreaterThan(frontY);
    // Horizontally inside the wall.
    expect(box.min[0]).toBeGreaterThan(-(PITCH - 0.5) / 2);
    expect(box.max[0]).toBeLessThan((PITCH - 0.5) / 2);
    label!.delete();
  });

  it('shrinks long text to fit the wall width with margins', () => {
    const p = params();
    const short = buildLabelManifold(m, font, p, { text: 'M3', icon: null })!;
    const long = buildLabelManifold(m, font, p, {
      text: 'M3 COUNTERSUNK WOOD SCREWS 12 mm',
      icon: null,
    })!;
    const available = PITCH - 0.5 - 2 * 3;
    const longBox = long.boundingBox();
    expect(longBox.max[0] - longBox.min[0]).toBeLessThanOrEqual(available + 1e-6);
    // The long label is shrunk: its glyphs are shorter than the short label's.
    const shortBox = short.boundingBox();
    expect(longBox.max[2] - longBox.min[2]).toBeLessThan(
      shortBox.max[2] - shortBox.min[2],
    );
    short.delete();
    long.delete();
  });

  it('returns null for an empty label spec', () => {
    expect(buildLabelManifold(m, font, params(), { text: '  ', icon: null })).toBeNull();
  });

  it('places the icon left of the text', () => {
    const p = params();
    const textOnly = buildLabelManifold(m, font, p, { text: 'M3', icon: null })!;
    const withIcon = buildLabelManifold(m, font, p, {
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

  it('returns a null label when there is no text and no icon', () => {
    const result = generateLabeledBin(m, font, params({ labelText: '', labelIcon: null }));
    expect(result.label).toBeNull();
  });
});

describe('generateLabeledBinUnion', () => {
  it('produces one mesh larger than the bare body', () => {
    const bare = generateLabeledBin(m, font, params({ labelText: '' }));
    const union = generateLabeledBinUnion(m, font, params());
    expect(union.indices.length).toBeGreaterThan(bare.body.indices.length);
  });
});
