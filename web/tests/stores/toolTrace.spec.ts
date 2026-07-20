import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useToolTrace } from '../../src/stores/toolTrace';

describe('toolTrace store shadow option', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('leaves the shadow post-filter off for a fresh session', () => {
    // The trace canvas passes this ref straight to the worker, which runs the
    // shadow and paper-halo filter only when it is true. A default of true
    // would delete a bare metal tool from the mask before it is ever traced.
    const store = useToolTrace();
    expect(store.removeShadows).toBe(false);
  });

  it('returns the shadow post-filter to off on reset', () => {
    const store = useToolTrace();
    store.removeShadows = true;
    store.reset();
    expect(store.removeShadows).toBe(false);
  });
});
