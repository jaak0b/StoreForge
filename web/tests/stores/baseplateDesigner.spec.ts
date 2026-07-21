import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useBaseplateDesigner } from '../../src/stores/baseplateDesigner';
import { validateProduct } from '../../src/engine/plan/planFile';
import { PITCH } from '../../src/engine/gridfinity/constants';

describe('baseplateDesigner store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('derives the size readout from the cell counts at the full pitch', () => {
    const store = useBaseplateDesigner();
    expect(store.widthMm).toBe(2 * PITCH);
    store.unitsX = 4;
    expect(store.widthMm).toBe(4 * PITCH);
    expect(store.depthMm).toBe(2 * PITCH);
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
});
