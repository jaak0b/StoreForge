import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSettings } from '../../src/stores/settings';

// The Vitest environment is node, which has no localStorage; the store reads
// and writes it, so stand up a minimal in-memory implementation.
const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => void data.set(key, String(value)),
  removeItem: (key: string) => void data.delete(key),
  clear: () => data.clear(),
});

describe('settings store', () => {
  beforeEach(() => {
    data.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the local AI agent connection off on a first visit', () => {
    expect(useSettings().allowLocalAgent).toBe(false);
  });

  it('restores an enabled local AI agent connection in a fresh session', () => {
    useSettings().setAllowLocalAgent(true);

    setActivePinia(createPinia());

    expect(useSettings().allowLocalAgent).toBe(true);
  });

  it('restores a connection turned off again as off', () => {
    const first = useSettings();
    first.setAllowLocalAgent(true);
    first.setAllowLocalAgent(false);

    setActivePinia(createPinia());

    expect(useSettings().allowLocalAgent).toBe(false);
  });

  it('falls back to off and reports it when the stored settings are not JSON', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    data.set('storeforge.settings', '{not json');

    const settings = useSettings();

    expect(settings.allowLocalAgent).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('falls back to off and reports it when the stored value is not a boolean', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    data.set('storeforge.settings', '{"allowLocalAgent":"yes"}');

    const settings = useSettings();

    expect(settings.allowLocalAgent).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
