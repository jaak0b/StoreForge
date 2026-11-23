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

  it('resolves a tool request with the typed slots when the user confirms', async () => {
    const store = useToolAssignment();
    const request = store.requestAssignment();
    store.bodyText = '4';
    store.labelText = '7';

    store.confirmRequest();

    await expect(request).resolves.toEqual({ body: 4, label: 7 });
    expect(store.dialogOpen).toBe(false);
  });

  it('resolves a tool request with null when the user cancels', async () => {
    const store = useToolAssignment();
    const request = store.requestAssignment();

    store.cancelRequest();

    await expect(request).resolves.toBeNull();
    expect(store.dialogOpen).toBe(false);
  });

  it('keeps the dialog open when the user confirms an invalid slot', () => {
    const store = useToolAssignment();
    void store.requestAssignment();
    store.labelText = '0';

    const confirmed = store.confirmRequest();

    expect(confirmed).toBe(false);
    expect(store.dialogOpen).toBe(true);
  });

  it('cancels an open tool request when a second one starts', async () => {
    const store = useToolAssignment();
    const first = store.requestAssignment();

    void store.requestAssignment();

    await expect(first).resolves.toBeNull();
    expect(store.dialogOpen).toBe(true);
  });
});
