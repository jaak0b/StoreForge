import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// The geometry worker does not exist in node. Its validateCustomIcon runs the
// real normalize pipeline in process instead, so only the thread hop is faked.
vi.mock('../../src/workerClient', async () => {
  const { loadManifold } = await import('../helpers/manifold');
  const { normalizeCustomIcon } = await import('../../src/engine/label/customIcon');
  return {
    validateCustomIcon: async (input: string) => normalizeCustomIcon(await loadManifold(), input),
  };
});

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

describe('custom icons store importIcon', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves valid path data under the trimmed name with its tight view box', async () => {
    const store = useCustomIcons();

    const result = await store.importIcon('  gear  ', SQUARE);

    expect(result.ok).toBe(true);
    expect(store.icons.map((icon) => icon.name)).toEqual(['gear']);
    expect(store.icons[0].viewBox).toEqual([10, 10, 80, 80]);
  });

  it('refuses SVG markup with no drawable shape and saves nothing', async () => {
    const store = useCustomIcons();

    const result = await store.importIcon('empty', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    expect(result).toEqual({
      ok: false,
      error:
        'This file has no drawable shape to emboss. Add a filled shape or a stroked outline, then upload it again.',
    });
    expect(store.icons).toEqual([]);
  });

  it('refuses a name used by a built-in icon', async () => {
    const store = useCustomIcons();

    const result = await store.importIcon('hex bolt', SQUARE);

    expect(result).toEqual({
      ok: false,
      error: 'An icon with this name already exists. Choose a different name.',
    });
    expect(store.icons).toEqual([]);
  });

  it('refuses a name used by a custom icon, even with surrounding spaces', async () => {
    const store = useCustomIcons();
    store.add('gear', SQUARE, [0, 0, 100, 100]);

    const result = await store.importIcon(' gear ', SQUARE);

    expect(result).toEqual({
      ok: false,
      error: 'An icon with this name already exists. Choose a different name.',
    });
    expect(store.icons).toHaveLength(1);
  });

  it('refuses an empty name', async () => {
    const store = useCustomIcons();

    const result = await store.importIcon('   ', SQUARE);

    expect(result).toEqual({ ok: false, error: 'Enter a name for the icon.' });
    expect(store.icons).toEqual([]);
  });

  it('fetches a link and saves the SVG it points to', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="50" height="20"/></svg>';
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => svg,
    }));
    const store = useCustomIcons();

    const result = await store.importIcon('plate', 'https://example.com/plate.svg');

    expect(result.ok).toBe(true);
    expect(store.icons[0].viewBox).toEqual([0, 0, 50, 20]);
  });

  it('refuses a link that cannot be fetched with the fetch problem', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, headers: { get: () => null } }));
    const store = useCustomIcons();

    const result = await store.importIcon('plate', 'https://example.com/missing.svg');

    expect(result).toEqual({
      ok: false,
      error:
        'The file at that link could not be fetched. Check that the link is correct and points straight at an .svg file, then try again.',
    });
    expect(store.icons).toEqual([]);
  });
});

describe('custom icons store removeByName', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    setActivePinia(createPinia());
  });

  it('removes the named custom icon', () => {
    const store = useCustomIcons();
    store.add('gear', SQUARE, [0, 0, 100, 100]);

    expect(store.removeByName('gear')).toBeNull();
    expect(store.icons).toEqual([]);
  });

  it('refuses a built-in icon name', () => {
    const store = useCustomIcons();

    expect(store.removeByName('hex bolt')).toBe(
      'The hex bolt icon is built in and cannot be removed. Only custom icons can be removed.',
    );
  });

  it('refuses an unknown name and keeps the other icons', () => {
    const store = useCustomIcons();
    store.add('gear', SQUARE, [0, 0, 100, 100]);

    expect(store.removeByName('sprocket')).toBe('There is no custom icon named "sprocket".');
    expect(store.icons).toHaveLength(1);
  });
});
