import { describe, expect, it } from 'vitest';
import {
  describeMissingModels,
  missingCutoutModels,
  modelNotStoredMessage,
  relinkCutoutModel,
} from '../../src/engine/plan/missingModels';
import { describeProduct } from '../../src/engine/plan/rowDescriptor';
import type { CutoutBin, CutoutModel } from '../../src/engine/plan/types';

function model(overrides: Partial<CutoutModel> = {}): CutoutModel {
  return {
    id: 'm1',
    name: 'bracket.stl',
    modelSourceId: 'src-1',
    triangleCount: 120,
    unitScale: 25.4,
    sizeMm: { x: 20, y: 10, z: 5 },
    placement: { xMm: 3, yMm: -4, zMm: 6, rotXDeg: 90, rotYDeg: 0, rotZDeg: 45 },
    clearanceMm: 0.6,
    ...overrides,
  };
}

function cutoutBin(models: CutoutModel[]): CutoutBin {
  return { origin: 'cutout', gridX: 2, gridY: 1, heightUnits: 6, magnetHoles: false, models };
}

describe('missingCutoutModels', () => {
  it('reports the models whose bytes this device does not hold', () => {
    const bin = cutoutBin([
      model({ id: 'm1', modelSourceId: 'src-1', name: 'a.stl' }),
      model({ id: 'm2', modelSourceId: 'src-2', name: 'b.stl' }),
    ]);
    expect(missingCutoutModels(bin, new Set(['src-1'])).map((m) => m.name)).toEqual(['b.stl']);
  });

  it('reports nothing when every model is stored', () => {
    const bin = cutoutBin([model({ modelSourceId: 'src-1' })]);
    expect(missingCutoutModels(bin, new Set(['src-1', 'src-9']))).toEqual([]);
  });

  it('reports every model when this device holds none of them', () => {
    const bin = cutoutBin([
      model({ id: 'm1', modelSourceId: 'src-1' }),
      model({ id: 'm2', modelSourceId: 'src-2' }),
    ]);
    expect(missingCutoutModels(bin, new Set())).toHaveLength(2);
  });
});

describe('describeMissingModels', () => {
  it('says nothing when nothing is missing', () => {
    expect(describeMissingModels([])).toBe('');
  });

  it('names one missing model in the singular', () => {
    expect(describeMissingModels([model({ name: 'bracket.stl' })])).toBe(
      'This bin needs the model "bracket.stl", which is not stored on this device.',
    );
  });

  it('names several missing models in one sentence', () => {
    expect(
      describeMissingModels([
        model({ id: 'm1', name: 'a.stl' }),
        model({ id: 'm2', name: 'b.stl' }),
        model({ id: 'm3', name: 'c.stl' }),
      ]),
    ).toBe(
      'This bin needs the models "a.stl", "b.stl" and "c.stl", which are not stored on this device.',
    );
  });
});

describe('modelNotStoredMessage', () => {
  it('names the file and says what the user can do about it', () => {
    expect(modelNotStoredMessage(model({ name: 'bracket.stl' }))).toBe(
      'The model "bracket.stl" is not stored on this device, so this bin cannot be generated. ' +
        'Upload the model again, or remove it from the bin.',
    );
  });
});

describe('relinkCutoutModel', () => {
  it('keeps the record identity, placement, unit scale and clearance', () => {
    const existing = model();
    const { model: relinked } = relinkCutoutModel(existing, {
      name: 'bracket.stl',
      triangleCount: 130,
      sizeMm: { x: 21, y: 10, z: 5 },
    });
    expect(relinked.id).toBe(existing.id);
    expect(relinked.modelSourceId).toBe(existing.modelSourceId);
    expect(relinked.placement).toEqual(existing.placement);
    expect(relinked.unitScale).toBe(existing.unitScale);
    expect(relinked.clearanceMm).toBe(existing.clearanceMm);
  });

  it('takes the name, the triangle count and the size from the located file', () => {
    const { model: relinked } = relinkCutoutModel(model(), {
      name: 'bracket-v2.stl',
      triangleCount: 4000,
      sizeMm: { x: 30, y: 12, z: 8 },
    });
    expect(relinked.name).toBe('bracket-v2.stl');
    expect(relinked.triangleCount).toBe(4000);
    expect(relinked.sizeMm).toEqual({ x: 30, y: 12, z: 8 });
  });

  it('says nothing when the located file has the name the plan recorded', () => {
    const { note } = relinkCutoutModel(model({ name: 'bracket.stl' }), {
      name: 'bracket.stl',
      triangleCount: 120,
      sizeMm: { x: 20, y: 10, z: 5 },
    });
    expect(note).toBeNull();
  });

  it('notes a differently named file once, without blocking the link', () => {
    const { note } = relinkCutoutModel(model({ name: 'bracket.stl' }), {
      name: 'bracket-v2.stl',
      triangleCount: 4000,
      sizeMm: { x: 30, y: 12, z: 8 },
    });
    expect(note).toBe(
      'The file "bracket-v2.stl" was linked to the model previously stored as "bracket.stl". ' +
        'Check the size readout if you expected a different model.',
    );
  });

  it('does not mutate the record it was given', () => {
    const existing = model({ name: 'bracket.stl', triangleCount: 120 });
    relinkCutoutModel(existing, {
      name: 'other.stl',
      triangleCount: 999,
      sizeMm: { x: 1, y: 1, z: 1 },
    });
    expect(existing.name).toBe('bracket.stl');
    expect(existing.triangleCount).toBe(120);
  });
});

describe('describeProduct with missing models', () => {
  const bin = cutoutBin([
    model({ id: 'm1', modelSourceId: 'src-1', name: 'a.stl' }),
    model({ id: 'm2', modelSourceId: 'src-2', name: 'b.stl' }),
  ]);

  it('names the missing models on the row', () => {
    const row = describeProduct({ kind: 'bin', bin, labelSlot: true }, new Set(['src-1']));
    expect(row.missingModels).toBe(
      'This bin needs the model "b.stl", which is not stored on this device.',
    );
  });

  it('says nothing when the caller did not read the model store', () => {
    expect(describeProduct({ kind: 'bin', bin, labelSlot: true }).missingModels).toBe('');
  });

  it('says nothing when every model is stored', () => {
    const row = describeProduct(
      { kind: 'bin', bin, labelSlot: true },
      new Set(['src-1', 'src-2']),
    );
    expect(row.missingModels).toBe('');
  });

  it('leaves the title and the caption of a bin with missing models alone', () => {
    const row = describeProduct({ kind: 'bin', bin, labelSlot: true }, new Set());
    expect(row.title).toBe('Cutout bin, 2 cutouts');
    expect(row.caption).toBe('bin · 2×1×6 · cutout · 2 cutouts');
  });

  it('says nothing for a bin of another origin', () => {
    const row = describeProduct(
      {
        kind: 'bin',
        bin: { origin: 'manual', gridX: 1, gridY: 1, heightUnits: 3, magnetHoles: false, walls: [] },
        labelSlot: true,
      },
      new Set(),
    );
    expect(row.missingModels).toBe('');
  });
});
