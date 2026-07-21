import { describe, expect, it } from 'vitest';
import { suggestShorthand, applySuggestion } from '../../src/engine/plan/screwSuggest';

describe('suggestShorthand', () => {
  it('suggests threads on empty input', () => {
    const s = suggestShorthand('', 0);
    expect(s.map((x) => x.insert)).toContain('M3');
    expect(s[0].kind).toBe('thread');
  });
  it('filters threads by typed prefix', () => {
    const s = suggestShorthand('m2', 2);
    expect(s.map((x) => x.insert)).toEqual(expect.arrayContaining(['M2', 'M2.5']));
    expect(s.map((x) => x.insert)).not.toContain('M3');
  });
  it('suggests lengths after a thread', () => {
    const s = suggestShorthand('M3 ', 3);
    expect(s[0].kind).toBe('length');
    expect(s.map((x) => x.insert)).toContain('x20');
  });
  it('filters lengths by typed digits', () => {
    const s = suggestShorthand('M3 x2', 5);
    expect(s.map((x) => x.insert)).toEqual(expect.arrayContaining(['x20', 'x25']));
    expect(s.map((x) => x.insert)).not.toContain('x30');
  });
  it('suggests heads after a length', () => {
    const s = suggestShorthand('M3x20 ', 6);
    expect(s[0].kind).toBe('head');
    expect(s.map((x) => x.insert)).toContain('fhcs');
  });
  it('filters heads by prefix', () => {
    const s = suggestShorthand('M3x20 f', 7);
    expect(s.map((x) => x.insert)).toContain('fhcs');
    expect(s.map((x) => x.insert)).not.toContain('shcs');
  });
  it('skips length suggestions for lengthless heads', () => {
    const s = suggestShorthand('M3 nut', 6);
    expect(s.every((x) => x.kind !== 'length')).toBe(true);
  });
  it('suggests counts once thread, length and head are set', () => {
    const s = suggestShorthand('M3x20 fhcs ', 11);
    expect(s[0].kind).toBe('count');
    expect(s.map((x) => x.insert)).toContain('x5');
  });
  it('returns nothing for a complete segment with explicit count', () => {
    expect(suggestShorthand('M3x20 fhcs x5', 13)).toEqual([]);
  });
  it('only considers the segment under the caret in a comma list', () => {
    const input = 'M3x20 fhcs x5, m4';
    const s = suggestShorthand(input, input.length);
    expect(s.map((x) => x.insert)).toContain('M4');
  });

  // Finding 1: a non-numeric partial while the length is still missing must fall
  // through to head suggestions rather than blanking the menu.
  it('suggests a lengthless head while the length is still open', () => {
    const s = suggestShorthand('M3 nu', 5);
    expect(s.some((x) => x.kind === 'head' && /hex nut/.test(x.label))).toBe(true);
  });

  // Finding 2: a compact token completes its remaining field.
  it('suggests heads after a compact, complete thread and length', () => {
    const s = suggestShorthand('m3x20', 5);
    expect(s.some((x) => x.kind === 'head')).toBe(true);
    expect(s.map((x) => x.insert)).toContain('m3x20 fhcs');
  });
  it('suggests length completions for a compact, partial length', () => {
    const s = suggestShorthand('m3x2', 4);
    expect(s.every((x) => x.kind === 'length')).toBe(true);
    expect(s.map((x) => x.insert)).toEqual(expect.arrayContaining(['m3x20', 'm3x25']));
  });

  // Finding 3: a bare "x" with no digits shows the full length list.
  it('shows the full length list for a bare x after a thread', () => {
    const s = suggestShorthand('M3 x', 4);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.kind === 'length')).toBe(true);
    expect(s.map((x) => x.insert)).toEqual(expect.arrayContaining(['x20', 'x25']));
  });

  // Finding 4: parser-accepted aliases beyond the canonical one complete.
  it('completes a non-canonical head alias', () => {
    const s = suggestShorthand('M3x20 fl', 8);
    expect(s.some((x) => x.kind === 'head' && /countersunk screw/.test(x.label))).toBe(true);
  });
});

describe('applySuggestion', () => {
  it('replaces the partial token and appends a space', () => {
    const r = applySuggestion('m2', 2, { insert: 'M2.5', label: 'M2.5', kind: 'thread' });
    expect(r.value).toBe('M2.5 ');
    expect(r.cursor).toBe(5);
  });
  it('inserts mid-list without touching other segments', () => {
    const input = 'M3x20 fhcs x5, m4';
    const r = applySuggestion(input, input.length, { insert: 'M4', label: 'M4', kind: 'thread' });
    expect(r.value).toBe('M3x20 fhcs x5, M4 ');
  });
});
