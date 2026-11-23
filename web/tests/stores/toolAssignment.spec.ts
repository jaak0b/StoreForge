import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useToolAssignment } from '../../src/stores/toolAssignment';

describe('tool assignment store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('starts with the base on slot 1 and the label on slot 2', () => {
    expect(useToolAssignment().assignment).toEqual({ body: 1, label: 2 });
  });

  it('returns the typed slots once both fields are valid', () => {
    const store = useToolAssignment();
    store.bodyText = '3';
    store.labelText = '3';
    expect(store.assignment).toEqual({ body: 3, label: 3 });
  });

  it('has no assignment while one field is invalid', () => {
    const store = useToolAssignment();
    store.labelText = '';
    expect(store.assignment).toBeNull();
  });
});
