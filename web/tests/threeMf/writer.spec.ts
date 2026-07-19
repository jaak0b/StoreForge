import { beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { Font } from 'opentype.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../helpers/manifold';
import { loadLabelFont } from '../helpers/font';
import { generateSlottedBin } from '../../src/engine/gridfinity/binGenerator';
import { writePlate3mf, type PlateItem } from '../../src/engine/threeMf/writer';
import {
  meshBounds,
  mergePlacedMeshes,
} from '../../src/engine/plate/placement';
import type { PartMeshes, MeshData } from '../../src/engine/gridfinity/types';

/**
 * Minimal XML well-formedness check: walks the document character by
 * character, tracking the tag stack; throws on mismatched or unclosed tags.
 * Not a validator, but enough to catch broken serialization.
 */
function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  let i = xml.indexOf('<');
  expect(i).toBeGreaterThanOrEqual(0);
  while (i !== -1) {
    const end = xml.indexOf('>', i);
    if (end === -1) throw new Error(`Unterminated tag at offset ${i}`);
    const tag = xml.slice(i + 1, end);
    if (tag.startsWith('?') || tag.startsWith('!--')) {
      // Declaration or comment.
    } else if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (open !== name) {
        throw new Error(`Closing tag ${name} does not match open tag ${open}`);
      }
    } else {
      const selfClosing = tag.endsWith('/');
      const name = tag.split(/[\s/]/, 1)[0];
      if (name === '') throw new Error(`Empty tag name at offset ${i}`);
      if (!selfClosing) stack.push(name);
    }
    i = xml.indexOf('<', end);
  }
  expect(stack).toEqual([]);
}

/** A 10 x 10 x 5 mm cuboid mesh with its base at z = 1, centred at (cx, cy). */
function cuboid(cx: number, cy: number): MeshData {
  const x0 = cx - 5;
  const x1 = cx + 5;
  const y0 = cy - 5;
  const y1 = cy + 5;
  const z0 = 1;
  const z1 = 6;
  const vertices = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { vertices, indices };
}

function unzip(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, strFromU8(data)]),
  );
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern, 'g'))?.length ?? 0;
}

describe('writePlate3mf with synthetic meshes', () => {
  const item: PlateItem = {
    body: cuboid(0, 0),
    label: cuboid(3, 3),
    name: 'Test <bin> "one"',
    instances: [{ xMm: 50, yMm: 60 }, { xMm: 120, yMm: 60, rotationDeg: 90 }],
  };
  let files: Record<string, string>;

  beforeAll(() => {
    files = unzip(writePlate3mf([item]));
  });

  it('contains the required package files, all well formed', () => {
    expect(Object.keys(files).sort()).toEqual([
      '3D/3dmodel.model',
      'Metadata/model_settings.config',
      '[Content_Types].xml',
      '_rels/.rels',
    ]);
    for (const content of Object.values(files)) assertWellFormedXml(content);
  });

  it('declares the model relationship and content types', () => {
    expect(files['_rels/.rels']).toContain('Target="/3D/3dmodel.model"');
    expect(files['[Content_Types].xml']).toContain(
      'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    );
  });

  it('writes millimeter unit, production namespace, and escaped names', () => {
    const model = files['3D/3dmodel.model'];
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain(
      'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"',
    );
    expect(files['Metadata/model_settings.config']).toContain(
      'Test &lt;bin&gt; &quot;one&quot;',
    );
  });

  it('preserves vertex and triangle counts per part', () => {
    const model = files['3D/3dmodel.model'];
    expect(countMatches(model, /<vertex /)).toBe(16);
    expect(countMatches(model, /<triangle /)).toBe(24);
    expect(countMatches(model, /<object /)).toBe(3);
    expect(countMatches(model, /<component /)).toBe(2);
  });

  it('assigns extruder 1 to the body part and extruder 2 to the label part', () => {
    const settings = files['Metadata/model_settings.config'];
    const parts = [...settings.matchAll(/<part id="(\d+)"[\s\S]*?<\/part>/g)];
    expect(parts).toHaveLength(2);
    expect(parts[0][0]).toContain('subtype="normal_part"');
    expect(parts[0][0]).toContain('value="Body"');
    expect(parts[0][0]).toContain('<metadata key="extruder" value="1"/>');
    expect(parts[1][0]).toContain('value="Label"');
    expect(parts[1][0]).toContain('<metadata key="extruder" value="2"/>');
  });

  it('writes one build item per instance with p:UUID and applied transforms', () => {
    const model = files['3D/3dmodel.model'];
    const items = [...model.matchAll(/<item objectid="(\d+)" p:UUID="[0-9a-f-]+" transform="([^"]+)"/g)];
    expect(items).toHaveLength(2);
    // Both instances reference the same component object (instancing).
    expect(items[0][1]).toBe(items[1][1]);

    // The joint bounds of body + label: x,y in [-5, 8], z in [1, 6];
    // footprint centre (1.5, 1.5), minZ 1.
    const t0 = items[0][2].split(' ').map(Number);
    expect(t0.slice(0, 9)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(t0[9]).toBeCloseTo(50 - 1.5, 6);
    expect(t0[10]).toBeCloseTo(60 - 1.5, 6);
    expect(t0[11]).toBeCloseTo(-1, 6);

    // Second instance: rotated 90 degrees about the footprint centre.
    const t1 = items[1][2].split(' ').map(Number);
    expect(t1[0]).toBeCloseTo(0, 6);
    expect(t1[1]).toBeCloseTo(1, 6);
    expect(t1[3]).toBeCloseTo(-1, 6);
    expect(t1[4]).toBeCloseTo(0, 6);
    // Rotated centre (1.5, 1.5) -> (-1.5, 1.5); translation restores it to (120, 60).
    expect(t1[9]).toBeCloseTo(120 + 1.5, 6);
    expect(t1[10]).toBeCloseTo(60 - 1.5, 6);
  });

  it('lists a plate with plater_id and one model_instance per build item', () => {
    const settings = files['Metadata/model_settings.config'];
    expect(settings).toContain('<metadata key="plater_id" value="1"/>');
    expect(countMatches(settings, /<model_instance>/)).toBe(2);
    expect(settings).toContain('<metadata key="instance_id" value="0"/>');
    expect(settings).toContain('<metadata key="instance_id" value="1"/>');
  });

  it('omits the label part for single-mesh items', () => {
    const singleFiles = unzip(
      writePlate3mf([
        { body: cuboid(0, 0), label: null, name: 'Plain', instances: [{ xMm: 10, yMm: 10 }] },
      ]),
    );
    const settings = singleFiles['Metadata/model_settings.config'];
    expect(countMatches(settings, /<part /)).toBe(1);
    expect(settings).not.toContain('key="extruder" value="2"');
  });

  it('rejects empty input and items without instances', () => {
    expect(() => writePlate3mf([])).toThrow();
    expect(() =>
      writePlate3mf([{ body: cuboid(0, 0), label: null, name: 'x', instances: [] }]),
    ).toThrow();
  });
});

describe('writePlate3mf with two real labeled bins', () => {
  let m: ManifoldToplevel;
  let font: Font;
  let binA: PartMeshes;
  let binB: PartMeshes;

  beforeAll(async () => {
    m = await loadManifold();
    font = await loadLabelFont();
    binA = generateSlottedBin(m, font, {
      gridX: 1,
      gridY: 1,
      heightUnits: 3,
      magnetHoles: false,
      walls: [],
      insert: { text: 'M3', text2: '', icon: null },
    });
    binB = generateSlottedBin(m, font, {
      gridX: 2,
      gridY: 1,
      heightUnits: 2,
      magnetHoles: false,
      walls: [],
      insert: { text: 'M4', text2: '', icon: null },
    });
  });

  it('round-trips both bins with matching geometry counts', () => {
    const files = unzip(
      writePlate3mf([
        { body: binA.body, label: binA.label, name: 'Bin A', instances: [{ xMm: 40, yMm: 40 }] },
        { body: binB.body, label: binB.label, name: 'Bin B', instances: [{ xMm: 130, yMm: 40 }] },
      ]),
    );
    const model = files['3D/3dmodel.model'];
    assertWellFormedXml(model);
    assertWellFormedXml(files['Metadata/model_settings.config']);
    const expectVertices =
      (binA.body.vertices.length +
        binA.label!.vertices.length +
        binB.body.vertices.length +
        binB.label!.vertices.length) /
      3;
    const expectTriangles =
      (binA.body.indices.length +
        binA.label!.indices.length +
        binB.body.indices.length +
        binB.label!.indices.length) /
      3;
    expect(countMatches(model, /<vertex /)).toBe(expectVertices);
    expect(countMatches(model, /<triangle /)).toBe(expectTriangles);
    // Two component objects, four mesh parts, two build items.
    expect(countMatches(model, /<components>/)).toBe(2);
    expect(countMatches(model, /<item /)).toBe(2);
    const settings = files['Metadata/model_settings.config'];
    // Per object: one object-level extruder 1 plus the body part's; per label part: extruder 2.
    expect(countMatches(settings, /<metadata key="extruder" value="1"\/>/)).toBe(4);
    expect(countMatches(settings, /<metadata key="extruder" value="2"\/>/)).toBe(2);
  });
});

describe('mergePlacedMeshes', () => {
  it('places each mesh at its position with the base on z = 0', () => {
    const merged = mergePlacedMeshes([
      { mesh: cuboid(0, 0), xMm: 30, yMm: 40 },
      { mesh: cuboid(7, 7), xMm: 90, yMm: 40 },
    ]);
    expect(merged.vertices.length).toBe(2 * 8 * 3);
    expect(merged.indices.length).toBe(2 * 12 * 3);
    const bounds = meshBounds([merged]);
    expect(bounds.minZ).toBeCloseTo(0, 6);
    // First cuboid spans x 25..35, second 85..95.
    expect(bounds.minX).toBeCloseTo(25, 5);
    expect(bounds.maxX).toBeCloseTo(95, 5);
    // Indices of the second mesh are offset past the first mesh's vertices.
    expect(Math.max(...merged.indices)).toBe(15);
  });
});
