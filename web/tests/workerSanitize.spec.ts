import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { sanitizeForWorker } from '../src/workerSanitize';
import type { SlottedBinParams } from '../src/engine/gridfinity/types';

/**
 * A payload built the way the UI builds one: the insert content and the walls
 * array come off a Pinia store, so they are Vue reactive Proxies. Structured
 * clone (what Comlink's postMessage runs) throws on such a Proxy, and
 * sanitizeForWorker must rebuild the plain data so the clone succeeds.
 */
function reactivePayload(): SlottedBinParams {
  return {
    gridX: 2,
    gridY: 1,
    heightUnits: 3,
    magnetHoles: false,
    walls: reactive([{ x1: 0, y1: -8, x2: 0, y2: 8 }]) as SlottedBinParams['walls'],
    labelSlot: true,
    insert: reactive({ text: 'M3', text2: '', icon: null, iconPath: undefined }),
    fusedLabel: null,
  };
}

describe('sanitizeForWorker', () => {
  it('produces a payload the structured clone accepts', () => {
    const params = reactivePayload();
    // Precondition: the reactive proxies make the raw payload unclonable.
    expect(() => structuredClone(params)).toThrow();
    const clean = sanitizeForWorker(params);
    expect(() => structuredClone(clean)).not.toThrow();
  });

  it('deep-equals the plain data it was built from', () => {
    const clean = sanitizeForWorker(reactivePayload());
    expect(clean).toEqual({
      gridX: 2,
      gridY: 1,
      heightUnits: 3,
      magnetHoles: false,
      walls: [{ x1: 0, y1: -8, x2: 0, y2: 8 }],
      labelSlot: true,
      insert: { text: 'M3', text2: '', icon: null, iconPath: undefined },
      fusedLabel: null,
    });
  });

  it('preserves a TypedArray value by reference', () => {
    const buffer = new Float32Array([1, 2, 3]);
    const clean = sanitizeForWorker({ buffer });
    expect(clean.buffer).toBe(buffer);
  });

  it('preserves a function value by reference', () => {
    const callback = (): number => 1;
    const clean = sanitizeForWorker({ callback });
    expect(clean.callback).toBe(callback);
  });

  it('keeps an undefined-valued optional key present', () => {
    const clean = sanitizeForWorker({ iconPath: undefined, text: 'x' });
    expect('iconPath' in clean).toBe(true);
    expect(clean.iconPath).toBeUndefined();
  });
});
