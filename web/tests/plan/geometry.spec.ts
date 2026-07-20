import { describe, expect, it } from 'vitest';
import { partsOf, previewBinParams } from '../../src/engine/plan/geometry';
import type {
  BinWithInsertProduct,
  CutoutBin,
  CutoutModel,
  ManualBin,
} from '../../src/engine/plan/types';

function manualBin(overrides: Partial<ManualBin> = {}): ManualBin {
  return {
    origin: 'manual',
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
    ...overrides,
  };
}

function binWithInsert(overrides: Partial<BinWithInsertProduct> = {}): BinWithInsertProduct {
  return {
    kind: 'binWithInsert',
    bin: manualBin(),
    insert: { text: 'M3 x 20', text2: '', icon: 'countersunk screw' },
    ...overrides,
  };
}

function cutoutModel(): CutoutModel {
  return {
    id: 'm1',
    name: 'socket-19.stl',
    modelSourceId: 'src-1',
    triangleCount: 14842,
    unitScale: 1,
    sizeMm: { x: 24, y: 24, z: 40 },
    placement: { xMm: 3, yMm: -2, zMm: 21.75, rotXDeg: 0, rotYDeg: 90, rotZDeg: 15 },
    clearanceMm: 0.4,
    sweepEnabled: false,
    draftAngleDeg: 0,
  };
}

function cutoutBin(overrides: Partial<CutoutBin> = {}): CutoutBin {
  return {
    origin: 'cutout',
    gridX: 3,
    gridY: 2,
    heightUnits: 6,
    magnetHoles: false,
    models: [cutoutModel()],
    ...overrides,
  };
}

describe('partsOf for a cutout bin', () => {
  it('carries the models through on a bin ordered alone', () => {
    const parts = partsOf({ kind: 'bin', bin: cutoutBin(), labelSlot: true });
    expect(parts).toHaveLength(1);
    const bin = parts[0];
    if (bin.part !== 'bin') throw new Error('expected bin part');
    expect(bin.models).toEqual([cutoutModel()]);
    expect(bin.pockets).toBeUndefined();
  });

  it('carries the models through on a bin ordered with its insert', () => {
    const parts = partsOf({
      kind: 'binWithInsert',
      bin: cutoutBin(),
      insert: { text: 'sockets', text2: '', icon: null },
    });
    expect(parts.map((p) => p.part)).toEqual(['bin', 'insert']);
    const bin = parts[0];
    if (bin.part !== 'bin') throw new Error('expected bin part');
    expect(bin.models).toEqual([cutoutModel()]);
  });

  it('carries the models through on a fused bin', () => {
    const parts = partsOf({
      kind: 'binWithInsert',
      bin: cutoutBin(),
      insert: { text: 'sockets', text2: '', icon: null },
      fused: true,
    });
    expect(parts).toHaveLength(1);
    const bin = parts[0];
    if (bin.part !== 'bin') throw new Error('expected bin part');
    expect(bin.models).toEqual([cutoutModel()]);
  });

  it('gives a cutout bin no divider walls, because its interior is filled for the carve', () => {
    const parts = partsOf({ kind: 'bin', bin: cutoutBin(), labelSlot: true });
    const bin = parts[0];
    if (bin.part !== 'bin') throw new Error('expected bin part');
    expect(bin.bin.walls).toEqual([]);
  });
});

describe('partsOf for binWithInsert', () => {
  it('expands the swappable-insert product into a bin and a separate insert', () => {
    const parts = partsOf(binWithInsert());
    expect(parts.map((p) => p.part)).toEqual(['bin', 'insert']);
    const bin = parts[0];
    expect(bin.part).toBe('bin');
    if (bin.part !== 'bin') throw new Error('expected bin part');
    expect(bin.bin.labelSlot).toBe(true);
    expect(bin.bin.fusedLabel).toBeNull();
  });

  it('expands a fused product into a single bin part carrying the raised label', () => {
    const parts = partsOf(binWithInsert({ fused: true }));
    expect(parts).toHaveLength(1);
    const bin = parts[0];
    expect(bin.part).toBe('bin');
    if (bin.part !== 'bin') throw new Error('expected bin part');
    // No slot is cut and the label content rides as the fused label.
    expect(bin.bin.labelSlot).toBe(false);
    expect(bin.bin.insert).toBeNull();
    expect(bin.bin.fusedLabel).toEqual({ text: 'M3 x 20', text2: '', icon: 'countersunk screw' });
    expect(bin.labelText).toBe('M3 x 20');
  });
});

describe('previewBinParams for binWithInsert', () => {
  it('shows the resting insert for the swappable product and the raised label for the fused one', () => {
    const swappable = previewBinParams(binWithInsert())!;
    expect(swappable.labelSlot).toBe(true);
    expect(swappable.insert).not.toBeNull();
    expect(swappable.fusedLabel).toBeNull();

    const fused = previewBinParams(binWithInsert({ fused: true }))!;
    expect(fused.labelSlot).toBe(false);
    expect(fused.insert).toBeNull();
    expect(fused.fusedLabel).not.toBeNull();
  });
});
