import { describe, expect, it } from 'vitest';
import { validateCustomIcon } from '../../src/engine/label/customIcon';
import {
  parseCustomIconFile,
  serializeCustomIconFile,
  type CustomIcon,
} from '../../src/engine/label/customIconFile';
import { iconByName } from '../../src/engine/label/icons';

const SQUARE = 'M10 10L90 10L90 90L10 90Z';

// validateCustomIcon is the synchronous revalidation of an already normalized,
// stored path (a single filled d string). The SVG-document handling, shape
// union and stroke expansion live in normalizeCustomIcon (see its spec), which
// needs the manifold WASM and runs in the worker.
describe('validateCustomIcon', () => {
  it('accepts bare path data and reports its bounding box', () => {
    const result = validateCustomIcon(SQUARE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(SQUARE);
      expect(result.viewBox).toEqual([10, 10, 80, 80]);
    }
  });

  it('accepts a multi-contour path (a shape with a hole)', () => {
    const result = validateCustomIcon(iconByName('washer').path);
    expect(result.ok).toBe(true);
  });

  it('rejects empty input and unreadable path data', () => {
    expect(validateCustomIcon('')).toEqual({
      ok: false,
      error: 'No path data found in this file.',
    });
    expect(validateCustomIcon('not path data')).toEqual({
      ok: false,
      error: 'No path data found in this file.',
    });
  });

  it('rejects a path that encloses no area', () => {
    const result = validateCustomIcon('M10 10L90 10');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('No path data found in this file.');
  });
});

describe('custom icon file round trip', () => {
  const icon: CustomIcon = {
    id: 'i1',
    name: 'logo',
    path: SQUARE,
    viewBox: [10, 10, 80, 80],
    createdAt: '2026-07-01T10:00:00.000Z',
  };

  it('round-trips icons through JSON unchanged', () => {
    const result = parseCustomIconFile(serializeCustomIconFile([icon]));
    expect(result).toEqual({ ok: true, icons: [icon] });
  });

  it('rejects a stored icon whose path data is unusable', () => {
    const text = serializeCustomIconFile([{ ...icon, path: 'garbage' }]);
    const result = parseCustomIconFile(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('No path data');
  });

  it('rejects duplicate icon ids', () => {
    const result = parseCustomIconFile(serializeCustomIconFile([icon, icon]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('appears twice');
  });

  it('rejects an unknown envelope version', () => {
    const result = parseCustomIconFile('{"version":9,"icons":[]}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version 9');
  });
});
