import { describe, expect, it } from 'vitest';
import { validateCustomIcon } from '../../src/engine/label/customIcon';
import {
  parseCustomIconFile,
  serializeCustomIconFile,
  type CustomIcon,
} from '../../src/engine/label/customIconFile';
import { iconByName } from '../../src/engine/label/icons';

const SQUARE = 'M10 10L90 10L90 90L10 90Z';

describe('validateCustomIcon', () => {
  it('accepts bare path data and reports its bounding box', () => {
    const result = validateCustomIcon(SQUARE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(SQUARE);
      expect(result.viewBox).toEqual([10, 10, 80, 80]);
    }
  });

  it('accepts a full SVG document with exactly one path', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${SQUARE}" fill="black"/></svg>`;
    const result = validateCustomIcon(svg);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(SQUARE);
  });

  it('accepts a multi-contour path (a shape with a hole)', () => {
    const result = validateCustomIcon(iconByName('washer').path);
    expect(result.ok).toBe(true);
  });

  it('rejects an SVG with more than one path', () => {
    const svg = `<svg><path d="${SQUARE}"/><path d="M0 0L1 0L1 1Z"/></svg>`;
    const result = validateCustomIcon(svg);
    expect(result).toEqual({
      ok: false,
      error:
        'This SVG has more than one shape. Combine it into a single filled path ' +
        'before uploading, or trace it in a vector tool with a boolean union.',
    });
  });

  it('rejects an SVG mixing a path with another shape element', () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10"/><path d="${SQUARE}"/></svg>`;
    const result = validateCustomIcon(svg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('more than one shape');
  });

  it('rejects an SVG without any path', () => {
    expect(validateCustomIcon('<svg><g/></svg>')).toEqual({
      ok: false,
      error: 'No path data found in this file.',
    });
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

  it('rejects a path whose outline is not closed', () => {
    const result = validateCustomIcon('M10 10L90 10L90 90L10 90');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unclosed');
  });

  it('rejects a path where only one of several subpaths is unclosed', () => {
    const result = validateCustomIcon(`${SQUARE}M95 95L99 95L99 99`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unclosed');
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
