import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCustomIcons } from '../../src/stores/customIcons';

const SQUARE = 'M10 10H90V90H10Z';

// The Vitest environment is node, which has no localStorage; the store reads
// and writes it, so stand up a minimal in-memory implementation for the store
// to persist against.
function installMemoryLocalStorage(): void {
  const data = new Map<string, string>();
  const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
  };
  (globalThis as { localStorage?: unknown }).localStorage = storage;
}

describe('custom icons store', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    setActivePinia(createPinia());
  });

  it('add returns an id and iconByName resolves the stored icon', () => {
    const store = useCustomIcons();
    const id = store.add('gear', SQUARE, [0, 0, 100, 100]);
    expect(id).toBeTruthy();
    expect(store.iconByName('gear')?.path).toBe(SQUARE);
  });

  it('remove drops the icon so iconByName no longer resolves it', () => {
    const store = useCustomIcons();
    const id = store.add('gear', SQUARE, [0, 0, 100, 100]);
    store.remove(id);
    expect(store.icons).toHaveLength(0);
    expect(store.iconByName('gear')).toBeNull();
  });

  it('remove persists so a fresh store does not reload the removed icon', () => {
    const first = useCustomIcons();
    const id = first.add('gear', SQUARE, [0, 0, 100, 100]);
    first.remove(id);
    setActivePinia(createPinia());
    const second = useCustomIcons();
    expect(second.iconByName('gear')).toBeNull();
  });
});
