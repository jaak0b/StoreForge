import { describe, expect, it } from 'vitest';
import { describeProduct } from '../../src/engine/plan/rowDescriptor';
import { evenDividerWalls } from '../../src/engine/gridfinity/dividerModel';
import type {
  BinPockets,
  CutoutBin,
  CutoutModel,
  LabelContent,
  ManualBin,
  ScrewBin,
  ScrewSpec,
  TracedBin,
} from '../../src/engine/plan/types';

function manualBin(
  overrides: Partial<Omit<ManualBin, 'walls'>> & {
    walls?: ManualBin['walls'];
    dividerCountX?: number;
    dividerCountY?: number;
  } = {},
): ManualBin {
  const { dividerCountX = 0, dividerCountY = 0, walls, ...rest } = overrides;
  const base = {
    origin: 'manual' as const,
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    ...rest,
  };
  return {
    ...base,
    walls: walls ?? evenDividerWalls(base.gridX, base.gridY, dividerCountX, dividerCountY),
  };
}

function screwSpec(): ScrewSpec {
  return { thread: 'M3', lengthMm: 20, head: 'countersunk screw', enteredLengthText: null };
}

function screwBin(overrides: Partial<ScrewBin> = {}): ScrewBin {
  return { ...manualBin({ gridX: 1, heightUnits: 6 }), origin: 'screw', screw: screwSpec(), ...overrides };
}

/** Pockets holding the given number of placements of one traced tool. */
function pockets(placementCount: number): BinPockets {
  return {
    tools: [
      {
        id: 't1',
        name: 'Wrench',
        outline: {
          outer: [
            { x: -10, y: -5 },
            { x: 10, y: -5 },
            { x: 10, y: 5 },
          ],
          holes: [],
        },
        clicks: [],
        rotationDeg: 0,
        offsetMm: 0.5,
        mirrored: false,
        fingerHoles: [],
      },
    ],
    placements: Array.from({ length: placementCount }, () => ({
      toolId: 't1',
      xMm: 0,
      yMm: 0,
      pocketDepthMm: 10,
    })),
  };
}

function tracedBin(placementCount: number, overrides: Partial<TracedBin> = {}): TracedBin {
  return {
    origin: 'traced',
    gridX: 3,
    gridY: 2,
    heightUnits: 4,
    magnetHoles: false,
    pockets: pockets(placementCount),
    ...overrides,
  };
}

/** The given number of carved models, each a distinct entry in one bin. */
function cutoutModels(count: number): CutoutModel[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `m${index}`,
    name: `socket-${index}.stl`,
    modelSourceId: `src-${index}`,
    triangleCount: 1200,
    unitScale: 1,
    sizeMm: { x: 20, y: 10, z: 8 },
    placement: { xMm: 0, yMm: 0, zMm: 12, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 },
    clearanceMm: 0.4,
    sweepEnabled: false,
    draftAngleDeg: 0,
  }));
}

function cutoutBin(modelCount: number, overrides: Partial<CutoutBin> = {}): CutoutBin {
  return {
    origin: 'cutout',
    gridX: 3,
    gridY: 2,
    heightUnits: 4,
    magnetHoles: false,
    models: cutoutModels(modelCount),
    ...overrides,
  };
}

function content(overrides: Partial<LabelContent> = {}): LabelContent {
  return { text: 'M3 x 20', text2: '', icon: 'countersunk screw', ...overrides };
}

describe('describeProduct titles', () => {
  it('names a labeled row by its label, with line 2 and the icon separate', () => {
    const row = describeProduct({
      kind: 'binWithInsert',
      bin: manualBin(),
      insert: content({ text: 'M3 bolts', text2: 'drawer 2', icon: 'bolt' }),
    });
    expect(row.title).toBe('M3 bolts');
    expect(row.titleLine2).toBe('drawer 2');
    expect(row.iconName).toBe('bolt');
    expect(row.titlePlaceholder).toBe(false);
  });

  it('marks an insert with no text as a placeholder', () => {
    const row = describeProduct({
      kind: 'insert',
      origin: 'manual',
      cells: 2,
      content: content({ text: '', text2: '', icon: null }),
    });
    expect(row.title).toBe('Insert with no text');
    expect(row.titlePlaceholder).toBe(true);
    expect(row.iconName).toBe(null);
  });

  it('synthesizes a plain manual bin title from its own fields', () => {
    const row = describeProduct({ kind: 'bin', bin: manualBin(), labelSlot: true });
    expect(row.title).toBe('Bin');
    expect(row.titleLine2).toBe('');
    expect(row.titlePlaceholder).toBe(false);
    expect(row.iconName).toBe(null);
  });

  it('names one divider in the singular and adds magnet holes', () => {
    const row = describeProduct({
      kind: 'bin',
      bin: manualBin({ dividerCountX: 1, magnetHoles: true }),
      labelSlot: true,
    });
    expect(row.title).toBe('Bin, 1 divider, magnet holes');
  });

  it('counts dividers across both axes in the plural', () => {
    const row = describeProduct({
      kind: 'bin',
      bin: manualBin({ dividerCountX: 2, dividerCountY: 1 }),
      labelSlot: false,
    });
    expect(row.title).toBe('Bin, 3 dividers');
  });

  it('names a traced bin by its pocket count', () => {
    expect(describeProduct({ kind: 'bin', bin: tracedBin(1), labelSlot: true }).title).toBe(
      'Traced bin, 1 pocket',
    );
    expect(describeProduct({ kind: 'bin', bin: tracedBin(3), labelSlot: true }).title).toBe(
      'Traced bin, 3 pockets',
    );
    expect(describeProduct({ kind: 'bin', bin: tracedBin(0), labelSlot: true }).title).toBe(
      'Traced bin',
    );
  });

  it('names a cutout bin by its cutout count', () => {
    expect(describeProduct({ kind: 'bin', bin: cutoutBin(1), labelSlot: true }).title).toBe(
      'Cutout bin, 1 cutout',
    );
    expect(describeProduct({ kind: 'bin', bin: cutoutBin(3), labelSlot: true }).title).toBe(
      'Cutout bin, 3 cutouts',
    );
    expect(describeProduct({ kind: 'bin', bin: cutoutBin(0), labelSlot: true }).title).toBe(
      'Cutout bin',
    );
  });

  it('does not describe a cutout bin as a manual one, whatever its magnet holes say', () => {
    // A cutout bin carries no walls at all, so the divider-wall branch would
    // read undefined; the magnet holes are set because that branch would put
    // them in the title and the cutout branch must not.
    const row = describeProduct({
      kind: 'bin',
      bin: cutoutBin(2, { magnetHoles: true }),
      labelSlot: true,
    });
    expect(row.title).toBe('Cutout bin, 2 cutouts');
  });

  it('never puts the size in the title', () => {
    for (const row of [
      describeProduct({ kind: 'bin', bin: manualBin(), labelSlot: true }),
      describeProduct({ kind: 'bin', bin: tracedBin(2), labelSlot: true }),
      describeProduct({ kind: 'insert', origin: 'manual', cells: 4, content: content() }),
    ]) {
      expect(row.title).not.toContain('×');
    }
  });
});

describe('describeProduct captions', () => {
  it('describes a manual bin alone', () => {
    expect(describeProduct({ kind: 'bin', bin: manualBin(), labelSlot: true }).caption).toBe(
      'bin · 2×1×3 · manual',
    );
  });

  it('describes a manual bin with its insert and divider detail', () => {
    expect(
      describeProduct({
        kind: 'binWithInsert',
        bin: manualBin({ dividerCountX: 1, dividerCountY: 1 }),
        insert: content(),
      }).caption,
    ).toBe('bin + insert · 2×1×3 · manual · 2 dividers');
  });

  it('describes a screw bin with its insert', () => {
    expect(
      describeProduct({ kind: 'binWithInsert', bin: screwBin(), insert: content() }).caption,
    ).toBe('bin + insert · 1×1×6 · screw');
  });

  it('omits a zero divider count entirely', () => {
    expect(
      describeProduct({ kind: 'binWithInsert', bin: manualBin(), insert: content() }).caption,
    ).toBe('bin + insert · 2×1×3 · manual');
  });

  it('names a single divider in the singular', () => {
    expect(
      describeProduct({
        kind: 'binWithInsert',
        bin: manualBin({ dividerCountY: 1 }),
        insert: content(),
      }).caption,
    ).toBe('bin + insert · 2×1×3 · manual · 1 divider');
  });

  it('describes a traced bin with and without pockets', () => {
    expect(describeProduct({ kind: 'bin', bin: tracedBin(2), labelSlot: true }).caption).toBe(
      'bin · 3×2×4 · traced · 2 pockets',
    );
    expect(
      describeProduct({ kind: 'binWithInsert', bin: tracedBin(0), insert: content() }).caption,
    ).toBe('bin + insert · 3×2×4 · traced');
  });

  it('describes a cutout bin with and without models', () => {
    expect(describeProduct({ kind: 'bin', bin: cutoutBin(2), labelSlot: true }).caption).toBe(
      'bin · 3×2×4 · cutout · 2 cutouts',
    );
    expect(
      describeProduct({ kind: 'binWithInsert', bin: cutoutBin(0), insert: content() }).caption,
    ).toBe('bin + insert · 3×2×4 · cutout');
  });

  it('sizes a manual insert by its cell width alone', () => {
    expect(
      describeProduct({ kind: 'insert', origin: 'manual', cells: 1, content: content() }).caption,
    ).toBe('insert · 1 cell · manual');
    expect(
      describeProduct({ kind: 'insert', origin: 'manual', cells: 3, content: content() }).caption,
    ).toBe('insert · 3 cells · manual');
  });

  it('describes a plain baseplate by kind and two-dimension size alone', () => {
    const row = describeProduct({
      kind: 'baseplate',
      unitsX: 4,
      unitsY: 2,
      customXMm: null,
      customYMm: null,
      magnets: null,
      screwHoles: false,
      connectable: false,
    });
    expect(row.title).toBe('Baseplate');
    expect(row.caption).toBe('baseplate · 4×2');
    expect(row.titleLine2).toBe('');
    expect(row.titlePlaceholder).toBe(false);
    expect(row.iconName).toBe(null);
  });

  it('lists the three feature flags of a fully optioned baseplate in the caption', () => {
    const row = describeProduct({
      kind: 'baseplate',
      unitsX: 4,
      unitsY: 2,
      customXMm: null,
      customYMm: null,
      magnets: { diameterMm: 6.5, heightMm: 2.4 },
      screwHoles: true,
      connectable: true,
    });
    expect(row.title).toBe('Baseplate');
    expect(row.caption).toBe('baseplate · 4×2 · magnets · screw holes · connectable');
    expect(row.titlePlaceholder).toBe(false);
    expect(row.iconName).toBe(null);
  });

  it('names a custom-size baseplate in the title, never in the caption', () => {
    const row = describeProduct({
      kind: 'baseplate',
      unitsX: 4,
      unitsY: 2,
      customXMm: 30.5,
      customYMm: null,
      magnets: null,
      screwHoles: true,
      connectable: false,
    });
    expect(row.title).toBe('Baseplate, custom size');
    expect(row.caption).toBe('baseplate · 4×2 · screw holes');
    expect(row.titlePlaceholder).toBe(false);
    expect(row.iconName).toBe(null);
  });

  it('shows a clip tolerance token only when the tolerance is non-zero', () => {
    const nominal = describeProduct({ kind: 'clip', toleranceMm: 0 });
    expect(nominal.title).toBe('Connection clip');
    expect(nominal.caption).toBe('connection clip');
    expect(nominal.titleLine2).toBe('');
    expect(nominal.titlePlaceholder).toBe(false);
    expect(nominal.iconName).toBe(null);

    const loosened = describeProduct({ kind: 'clip', toleranceMm: 0.2 });
    expect(loosened.title).toBe('Connection clip');
    expect(loosened.caption).toBe('connection clip · tolerance 0.2 mm');
    expect(loosened.titlePlaceholder).toBe(false);
    expect(loosened.iconName).toBe(null);
  });

  it('sizes a screw insert by its cell width alone', () => {
    expect(
      describeProduct({
        kind: 'insert',
        origin: 'screw',
        cells: 2,
        content: content(),
        screw: screwSpec(),
      }).caption,
    ).toBe('insert · 2 cells · screw');
  });
});
