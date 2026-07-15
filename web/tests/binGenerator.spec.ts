import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from './helpers/manifold';
import {
  buildBinManifold,
  generateBin,
  roundedRectPolygon,
  validateParams,
} from '../src/engine/gridfinity/binGenerator';
import {
  FOOT_HEIGHT,
  HEIGHT_UNIT,
  LIP_HEIGHT,
  PITCH,
} from '../src/engine/gridfinity/constants';
import type { BinParams } from '../src/engine/gridfinity/types';

let m: ManifoldToplevel;

beforeAll(async () => {
  m = await loadManifold();
});

function params(overrides: Partial<BinParams> = {}): BinParams {
  return {
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: false,
    magnetHoles: false,
    ...overrides,
  };
}

describe('roundedRectPolygon', () => {
  it('stays inside the rectangle and touches its sides', () => {
    const poly = roundedRectPolygon(41.5, 41.5, 3.75);
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of poly) {
      expect(Math.abs(x)).toBeLessThanOrEqual(41.5 / 2 + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(41.5 / 2 + 1e-9);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    expect(maxX).toBeCloseTo(41.5 / 2, 9);
    expect(maxY).toBeCloseTo(41.5 / 2, 9);
  });
});

describe('buildBinManifold', () => {
  it('produces a watertight solid of genus 0 for a plain 1x1x3 bin', () => {
    const bin = buildBinManifold(m, params());
    expect(bin.status()).toBe('NoError');
    expect(bin.isEmpty()).toBe(false);
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('matches the expected outer dimensions for a 1x1x3 bin without lip', () => {
    const bin = buildBinManifold(m, params());
    const box = bin.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(1 * PITCH - 0.5, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(1 * PITCH - 0.5, 5);
    expect(box.max[2] - box.min[2]).toBeCloseTo(3 * HEIGHT_UNIT, 5);
    bin.delete();
  });

  it('matches the expected outer dimensions for a 2x1x6 bin without lip', () => {
    const bin = buildBinManifold(m, params({ gridX: 2, gridY: 1, heightUnits: 6 }));
    const box = bin.boundingBox();
    expect(box.max[0] - box.min[0]).toBeCloseTo(2 * PITCH - 0.5, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(1 * PITCH - 0.5, 5);
    expect(box.max[2] - box.min[2]).toBeCloseTo(6 * HEIGHT_UNIT, 5);
    bin.delete();
  });

  it('adds the lip height on top when the stacking lip is enabled', () => {
    const bin = buildBinManifold(m, params({ stackingLip: true }));
    const box = bin.boundingBox();
    expect(box.max[2] - box.min[2]).toBeCloseTo(3 * HEIGHT_UNIT + LIP_HEIGHT, 5);
    expect(bin.genus()).toBe(0);
    bin.delete();
  });

  it('has a positive volume smaller than its bounding box volume', () => {
    const bin = buildBinManifold(m, params());
    const box = bin.boundingBox();
    const boxVolume =
      (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
    const volume = bin.volume();
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeLessThan(boxVolume);
    bin.delete();
  });

  it('magnet holes reduce the volume without breaking the solid', () => {
    const plain = buildBinManifold(m, params());
    const withMagnets = buildBinManifold(m, params({ magnetHoles: true }));
    expect(withMagnets.volume()).toBeLessThan(plain.volume());
    expect(withMagnets.status()).toBe('NoError');
    // Each of the four holes removes at most a full cylinder of material.
    const holeVolume = Math.PI * 3.25 ** 2 * 2.4;
    expect(plain.volume() - withMagnets.volume()).toBeLessThanOrEqual(4 * holeVolume + 1e-6);
    expect(plain.volume() - withMagnets.volume()).toBeGreaterThan(2 * holeVolume);
    plain.delete();
    withMagnets.delete();
  });

  it('keeps the foot region narrower than the body so bins can stack', () => {
    // Sample the bounding box of the solid sliced below the foot top.
    const bin = buildBinManifold(m, params());
    const feetOnly = bin.trimByPlane([0, 0, -1], -(FOOT_HEIGHT - 0.05));
    const box = feetOnly.boundingBox();
    expect(box.max[0] - box.min[0]).toBeLessThan(1 * PITCH - 0.5);
    bin.delete();
    feetOnly.delete();
  });

  it('rejects non-integer and out-of-range parameters', () => {
    expect(() => validateParams(params({ gridX: 0 }))).toThrow(/gridX/);
    expect(() => validateParams(params({ gridY: 1.5 }))).toThrow(/gridY/);
    expect(() => validateParams(params({ heightUnits: 1 }))).toThrow(/heightUnits/);
  });
});

describe('generateBin', () => {
  it('returns transferable arrays describing a valid triangle mesh', () => {
    const mesh = generateBin(m, params());
    expect(mesh.vertices.length % 3).toBe(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    const numVert = mesh.vertices.length / 3;
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(numVert);
    }
  });
});
