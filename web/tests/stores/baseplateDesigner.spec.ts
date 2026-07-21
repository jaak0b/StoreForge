import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useBaseplateDesigner } from '../../src/stores/baseplateDesigner';
import { validateProduct } from '../../src/engine/plan/planFile';

describe('baseplateDesigner store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('collapses the magnets to null when the mode is none despite non-default dimensions', () => {
    const store = useBaseplateDesigner();
    store.magnetMode = 'full';
    store.magnetDiameterMm = 8.2;
    store.magnetHeightMm = 1;
    expect(store.magnets).toEqual({ diameterMm: 8.2, heightMm: 1 });
    store.magnetMode = 'none';
    expect(store.magnets).toBeNull();
    expect(store.product.magnets).toBeNull();
    expect(store.params.magnets).toBeNull();
  });

  it('produces a product that passes validateProduct in the default and fully optioned states', () => {
    // Ties the form to the file format: a form default outside the validator's
    // range (the magnet defaults sit near the bounds) fails here, at build
    // time, instead of through a user's rejected import.
    const store = useBaseplateDesigner();
    expect(validateProduct(store.product, 'Default form')).toBeNull();
    store.unitsX = 4;
    store.unitsY = 2;
    store.magnetMode = 'full';
    store.screwHoleMode = 'full';
    store.connectable = true;
    expect(validateProduct(store.product, 'Optioned form')).toBeNull();
    expect(store.product.screwHoles).toBe(true);
    expect(store.product.connectable).toBe(true);
  });

  it('round-trips a brimmed product through loadProduct and the product getter verbatim', () => {
    // A queue edit of a drawer-fill plate loads here; the form has no brim
    // controls, so the brim must survive the load-save round trip untouched.
    const store = useBaseplateDesigner();
    const brim = { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6.5 };
    store.loadProduct({
      kind: 'baseplate',
      unitsX: 5,
      unitsY: 3,
      magnets: null,
      screwHoles: false,
      connectable: false,
      brim,
    });
    expect(store.product.brim).toEqual(brim);
    // The stored brim is a copy, detached from the loaded product object.
    expect(store.brim).not.toBe(brim);
  });

  it('emits no brim on a fresh design and clears a loaded brim on reset', () => {
    const store = useBaseplateDesigner();
    expect(store.product.brim).toBeUndefined();
    store.loadProduct({
      kind: 'baseplate',
      unitsX: 2,
      unitsY: 2,
      magnets: null,
      screwHoles: false,
      connectable: false,
      brim: { leftMm: 1, rightMm: 1, frontMm: 0, backMm: 2 },
    });
    expect(store.product.brim).toBeDefined();
    store.$reset();
    expect(store.product.brim).toBeUndefined();
  });
});
