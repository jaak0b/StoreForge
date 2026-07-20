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
