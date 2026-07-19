import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from 'opentype.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import {
  buildSlottedBinBody,
  generateBin,
  generateSlottedBin,
  generateSlottedBinUnion,
} from '../../src/engine/gridfinity/binGenerator';
import {
  buildFusedLabel,
  buildInsertSolids,
  FUSED_SHELF_THICKNESS,
  insertLengthMm,
  INSERT_DEPTH,
  INSERT_TAB_LENGTH,
  INSERT_TEXT_RAISE,
  INSERT_TEXT_WELD,
  SLOT_DEPTH,
  SLOT_FRONT_INSET,
} from '../../src/engine/label/slot';
import {
  layoutLabelFace,
  LABEL_LINE2_SCALE,
  LABEL_MARGIN,
  LABEL_TEXT_HEIGHT,
  SHELF_DEPTH_MARGIN,
  SHELF_THICKNESS,
  TEXT_BOLD_OFFSET,
} from '../../src/engine/label/placement';
import { binOuterSizeMm, HEIGHT_UNIT } from '../../src/engine/gridfinity/constants';
import type { BinParams, MeshData, SlottedBinParams } from '../../src/engine/gridfinity/types';

let m: ManifoldToplevel;
let font: Font;

beforeAll(async () => {
  m = await loadManifold();
  font = await loadLabelFont();
});

function params(overrides: Partial<SlottedBinParams> = {}): SlottedBinParams {
  return {
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: [],
    insert: null,
    ...overrides,
  };
}

function binParams(overrides: Partial<BinParams> = {}): BinParams {
  const { insert: _insert, ...rest } = params(overrides);
  void _insert;
  return rest;
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

const bodyTop = 3 * HEIGHT_UNIT;

describe('text bolding', () => {
  it('dilates text outlines wider without merging separate letters', () => {
    const [part] = layoutLabelFace(font, { text: 'M3 x 20', icon: null }, 1000, 1000);
    const original = new m.CrossSection(part.polygons, part.fillRule);
    const bold = original.offset(TEXT_BOLD_OFFSET, 'Round');
    // Dilating every stem by TEXT_BOLD_OFFSET per side must grow the printed
    // area (this is the whole point: thin Roboto stems become thick enough
    // to slice as solid perimeters).
    expect(bold.area()).toBeGreaterThan(original.area());
    // Kerned letters that start out separated must stay separated: same
    // number of closed contours before and after dilation.
    expect(bold.numContour()).toBe(original.numContour());
    original.delete();
    bold.delete();
  });

  it('keeps the finished insert solid watertight after text bolding', () => {
    const { body, label } = buildInsertSolids(m, font, { text: 'M3 x 20', icon: null }, 1);
    expect(body.status()).toBe('NoError');
    expect(label!.status()).toBe('NoError');
    body.delete();
    label!.delete();
  });

  it('makes text visibly thicker on the finished label than an unbolded pass would be', () => {
    // Reproduce the pre-fix geometry (no offset) to compare against the
    // fixed pipeline's cross-sectional area at the same emboss depth.
    const [part] = layoutLabelFace(font, { text: 'M3', icon: null }, 1000, 1000);
    const unbolded = new m.CrossSection(part.polygons, part.fillRule);
    const bolded = unbolded.offset(TEXT_BOLD_OFFSET, 'Round');
    expect(bolded.area()).toBeGreaterThan(unbolded.area() * 1.1);
    unbolded.delete();
    bolded.delete();
  });
});

describe('layoutLabelFace with a second line', () => {
  const wide = 1000;

  function partBounds(part: { polygons: [number, number][][] }): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const contour of part.polygons) {
      for (const [x, y] of contour) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    return { minX, maxX, minY, maxY };
  }

  it('stacks the second line below the first at the reduced cap height', () => {
    const parts = layoutLabelFace(
      font,
      { text: 'M3', text2: 'M3', icon: null },
      wide,
      wide,
    );
    expect(parts).toHaveLength(2);
    const line1 = partBounds(parts[0]);
    const line2 = partBounds(parts[1]);
    // Below, with clear separation.
    expect(line2.maxY).toBeLessThan(line1.minY);
    // Same text at the second-line scale: cap height ratio matches.
    expect((line2.maxY - line2.minY) / (line1.maxY - line1.minY)).toBeCloseTo(
      LABEL_LINE2_SCALE,
      6,
    );
    // Glyphs may slightly overshoot the nominal cap height (rounded digits).
    expect(line1.maxY - line1.minY).toBeCloseTo(LABEL_TEXT_HEIGHT, 0);
  });

  it('leaves a single-line label unchanged when the second line is empty', () => {
    const single = layoutLabelFace(font, { text: 'M3', icon: null }, wide, wide);
    const emptied = layoutLabelFace(font, { text: 'M3', text2: '  ', icon: null }, wide, wide);
    expect(emptied).toHaveLength(single.length);
    expect(partBounds(emptied[0])).toEqual(partBounds(single[0]));
  });

  it('shrinks both lines together to fit the shelf depth', () => {
    const narrowDepth = 4;
    const parts = layoutLabelFace(
      font,
      { text: 'M3', text2: 'M3', icon: null },
      wide,
      narrowDepth,
    );
    const all = parts.map(partBounds);
    const minY = Math.min(...all.map((b) => b.minY));
    const maxY = Math.max(...all.map((b) => b.maxY));
    expect(maxY - minY).toBeLessThanOrEqual(narrowDepth + 1e-9);
    // The two lines keep their relative scale when shrunk together.
    expect((all[1].maxY - all[1].minY) / (all[0].maxY - all[0].minY)).toBeCloseTo(
      LABEL_LINE2_SCALE,
      6,
    );
  });
});

describe('buildSlottedBinBody', () => {
  it('produces a watertight solid whether or not an insert is paired with it', () => {
    const body = buildSlottedBinBody(m, binParams());
    expect(body.status()).toBe('NoError');
    expect(body.isEmpty()).toBe(false);
    body.delete();
  });

  it('every bin gets the slot: its volume exceeds the plain unslotted body', () => {
    const slotted = buildSlottedBinBody(m, binParams());
    const plain = generateBin(m, binParams());
    expect(slotted.volume()).toBeGreaterThan(0);
    // Compare against the raw unslotted mesh volume via its own manifold.
    const plainVolume = (() => {
      let vol = 0;
      const v = plain.vertices;
      const idx = plain.indices;
      for (let i = 0; i < idx.length; i += 3) {
        const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
        vol +=
          (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
            v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
            v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
          6;
      }
      return vol;
    })();
    expect(slotted.volume()).toBeGreaterThan(plainVolume);
    slotted.delete();
  });
});

describe('generateSlottedBin', () => {
  it('returns separate watertight body and label meshes when an insert is paired', () => {
    const result = generateSlottedBin(m, font, params({ insert: { text: 'M3', text2: '', icon: 'washer' } }));
    expect(result.label).not.toBeNull();
    for (const mesh of [result.body, result.label!]) {
      expect(mesh.vertices.length % 3).toBe(0);
      expect(mesh.indices.length % 3).toBe(0);
      expect(mesh.indices.length).toBeGreaterThan(0);
    }
  });

  it('tops the body out at the stacking lip crest, not above it', () => {
    const labeled = generateSlottedBin(m, font, params());
    // The lip crest apex sits 4.4 - 0.6 * sqrt(2) = 3.5515 above the
    // nominal top; nothing the slot or insert adds reaches higher.
    expect(meshMaxZ(labeled.body)).toBeCloseTo(bodyTop + 3.5515, 3);
  });

  it('returns a null label mesh for a bin ordered with an empty slot', () => {
    const noLabel = generateSlottedBin(m, font, params({ insert: null }));
    expect(noLabel.label).toBeNull();
    // The slot itself is still cut into the body, so its volume differs from
    // a plain bin generated without any slot machinery.
    const reference = generateBin(m, binParams());
    expect(meshVolume(noLabel.body)).toBeGreaterThan(meshVolume(reference));
  });
});

describe('generateSlottedBinUnion', () => {
  it('matches the body mesh of generateSlottedBin with no insert riding along', () => {
    const { body } = generateSlottedBin(m, font, params());
    const union = generateSlottedBinUnion(m, font, params());
    expect(meshVolume(union)).toBeCloseTo(meshVolume(body), 6);
  });
});

describe('fused label', () => {
  const spec = { text: 'M3 x 20', icon: null } as const;

  it('builds a watertight raised label standing on the bin top face', () => {
    const label = buildFusedLabel(m, font, spec, binParams());
    expect(label).not.toBeNull();
    expect(label!.status()).toBe('NoError');
    // The raised face stands INSERT_TEXT_RAISE above the shelf's top face,
    // which is the nominal bin top, exactly as the insert label stands above
    // its plate.
    expect(label!.boundingBox().max[2]).toBeCloseTo(bodyTop + INSERT_TEXT_RAISE, 6);
    label!.delete();
  });

  it('returns null for a blank spec', () => {
    const label = buildFusedLabel(m, font, { text: '', icon: null }, binParams());
    expect(label).toBeNull();
  });

  /** The fused bin exactly as the plan expansion produces it. */
  const fusedParams = () =>
    params({ labelSlot: false, fusedLabel: { ...spec, text2: '' } });

  it('cuts no insert channel into the body, but does carry the fused shelf', () => {
    const fused = generateSlottedBin(m, font, fusedParams());
    expect(fused.label).not.toBeNull();
    // The fused body is not the slotted body: it has no insert channel.
    const slotted = generateSlottedBin(m, font, params({ insert: null }));
    expect(meshVolume(fused.body)).not.toBeCloseTo(meshVolume(slotted.body), 3);
    // It is not the plain bin either: the label's shelf is unioned in. The
    // label's own footprint lies wholly over the interior cavity, so the plate
    // covering it at its full thickness is material a plain bin does not have.
    const plain = generateBin(m, binParams());
    const labelFootprint =
      (insertLengthMm(1) - 2 * INSERT_TAB_LENGTH - 2 * LABEL_MARGIN) *
      (INSERT_DEPTH - 2 * SHELF_DEPTH_MARGIN);
    expect(meshVolume(fused.body) - meshVolume(plain)).toBeGreaterThan(
      labelFootprint * FUSED_SHELF_THICKNESS,
    );
  });

  it('builds the fused body as a watertight solid', () => {
    const body = buildSlottedBinBody(m, fusedParams());
    expect(body.status()).toBe('NoError');
    expect(body.isEmpty()).toBe(false);
    expect(body.genus()).toBe(0);
    body.delete();
  });

  it('stands the label text on the shelf instead of floating it over the cavity', () => {
    const body = buildSlottedBinBody(m, fusedParams());
    const label = buildFusedLabel(m, font, spec, binParams());
    // The text reaches into the plate below the bin top, and the plate is
    // there to receive it: the two solids share volume, so the printed part is
    // one welded piece rather than text hanging in mid air.
    expect(label!.boundingBox().min[2]).toBeCloseTo(bodyTop - INSERT_TEXT_WELD, 6);
    expect(label!.boundingBox().min[2]).toBeGreaterThan(bodyTop - FUSED_SHELF_THICKNESS);
    const weld = m.Manifold.intersection(body, label!);
    expect(weld.volume()).toBeGreaterThan(0);
    weld.delete();
    body.delete();
    label!.delete();
  });

  it('steps down at the inner end just as the slot shelf does', () => {
    // The channel's back edge, where both shelves' ramp starts, and the plate
    // top's back edge one plate thickness behind it: in the slot shelf that
    // edge is the end stop's back face, so the inner end shows a short
    // vertical face there before the 45 degree ramp begins. The fused shelf
    // must show the same face; without the riser its chamfer starts straight
    // off the top surface and the plate top reaches a further slot height into
    // the bin.
    const p = fusedParams();
    const yBack = -binOuterSizeMm(p.gridY) / 2 + SLOT_FRONT_INSET + SLOT_DEPTH;
    const body = buildSlottedBinBody(m, p);
    // Cross-section just under the top face, over the interior (clear of the
    // side walls): the material must stop at the plate's top-back edge.
    const justBelowTop = m.Manifold.cube([10, 18, 0.05]).translate(-5, -20, bodyTop - 0.05);
    const topSlice = m.Manifold.intersection(body, justBelowTop);
    expect(topSlice.boundingBox().max[1]).toBeCloseTo(yBack + SHELF_THICKNESS, 6);
    justBelowTop.delete();
    topSlice.delete();
    // The same slice holds no material behind that edge, where a chamfer
    // starting at the top face would still leave some.
    const behindEdge = m.Manifold.cube([10, SHELF_THICKNESS, 0.05]).translate(
      -5,
      yBack + SHELF_THICKNESS + 0.01,
      bodyTop - 0.05,
    );
    const stray = m.Manifold.intersection(body, behindEdge);
    expect(Math.abs(stray.volume())).toBeLessThan(1e-9);
    behindEdge.delete();
    stray.delete();
    body.delete();
  });

  it('unions the raised label into the single STL mesh', () => {
    const fusedUnion = generateSlottedBinUnion(
      m,
      font,
      params({ labelSlot: false, fusedLabel: { ...spec, text2: '' } }),
    );
    // The union is the plain unslotted bin plus the raised label, so it holds
    // more material than the plain bin body alone.
    const plain = generateBin(m, binParams());
    expect(meshVolume(fusedUnion)).toBeGreaterThan(meshVolume(plain));
  });
});
