import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useBaseplateDesigner } from '../../src/stores/baseplateDesigner';
import { validateProduct } from '../../src/engine/plan/planFile';
import { PITCH } from '../../src/engine/gridfinity/constants';

describe('baseplateDesigner store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('collapses the spans to null when custom size is toggled off after typing values', () => {
    // The single most likely regression: a naive product getter reads the raw
    // customXMm field and persists a custom span the user turned off.
    const store = useBaseplateDesigner();
    store.customSize = true;
    store.customXMm = 30.5;
    store.customYMm = 20;
    expect(store.spanX).toBe(30.5);
    expect(store.spanY).toBe(20);
    expect(store.product.customXMm).toBe(30.5);
    store.customSize = false;
    expect(store.spanX).toBeNull();
    expect(store.spanY).toBeNull();
    expect(store.product.customXMm).toBeNull();
    expect(store.product.customYMm).toBeNull();
    // The size readout collapses with it: full-pitch cells again.
    expect(store.widthMm).toBe(2 * PITCH);
    store.customSize = true;
    // The typed values survive the toggle for when it comes back on.
    expect(store.widthMm).toBe(PITCH + 30.5);
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
    store.customSize = true;
    store.customXMm = 30.5;
    store.customYMm = 42;
    store.magnetMode = 'full';
    store.screwHoleMode = 'full';
    store.connectable = true;
    expect(validateProduct(store.product, 'Optioned form')).toBeNull();
    expect(store.product.screwHoles).toBe(true);
    expect(store.product.connectable).toBe(true);
  });
});
