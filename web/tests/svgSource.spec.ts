import { describe, expect, it } from 'vitest';
import {
  MAX_SVG_FETCH_BYTES,
  fetchSvgText,
  isProbablyUrl,
} from '../src/svgSource';

/** A minimal stub Response for the fields fetchSvgText reads. */
function stubResponse(options: {
  ok?: boolean;
  contentLength?: string | null;
  body?: string;
}): Response {
  const { ok = true, contentLength = null, body = '' } = options;
  return {
    ok,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? contentLength : null,
    },
    text: async () => body,
  } as unknown as Response;
}

describe('isProbablyUrl', () => {
  it('accepts http and https links', () => {
    expect(isProbablyUrl('https://example.com/calculator.svg')).toBe(true);
    expect(isProbablyUrl('http://example.com/a.svg')).toBe(true);
    expect(isProbablyUrl('  https://example.com/a.svg  ')).toBe(true);
  });

  it('rejects SVG markup and path data', () => {
    expect(isProbablyUrl('<svg><path d="M0 0"/></svg>')).toBe(false);
    expect(isProbablyUrl('M0 0 L10 10 Z')).toBe(false);
    expect(isProbablyUrl('example.com/a.svg')).toBe(false);
    expect(isProbablyUrl('ftp://example.com/a.svg')).toBe(false);
  });
});

describe('fetchSvgText', () => {
  it('returns the fetched text on success', async () => {
    const fetchImpl = async () => stubResponse({ body: '<svg/>' });
    const result = await fetchSvgText('https://example.com/a.svg', fetchImpl as typeof fetch);
    expect(result).toEqual({ ok: true, text: '<svg/>' });
  });

  it('maps a thrown TypeError (blocked cross-origin request) to the upload-instead message', async () => {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await fetchSvgText('https://example.com/a.svg', fetchImpl as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('upload button');
  });

  it('maps a non-OK response to the could-not-be-fetched message', async () => {
    const fetchImpl = async () => stubResponse({ ok: false });
    const result = await fetchSvgText('https://example.com/a.svg', fetchImpl as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('could not be fetched');
  });

  it('rejects a file whose content-length exceeds the limit', async () => {
    const fetchImpl = async () =>
      stubResponse({ contentLength: String(MAX_SVG_FETCH_BYTES + 1) });
    const result = await fetchSvgText('https://example.com/a.svg', fetchImpl as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('1 MB');
  });

  it('rejects an oversized body even when content-length is absent', async () => {
    const big = 'a'.repeat(MAX_SVG_FETCH_BYTES + 1);
    const fetchImpl = async () => stubResponse({ body: big });
    const result = await fetchSvgText('https://example.com/a.svg', fetchImpl as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('1 MB');
  });
});
