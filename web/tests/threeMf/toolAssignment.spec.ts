import { describe, expect, it } from 'vitest';
import { parseToolNumber } from '../../src/engine/threeMf/toolAssignment';

describe('parseToolNumber', () => {
  it.each([
    ['1', 1],
    ['100', 100],
    [' 4 ', 4],
  ])('accepts %j as slot %i', (text, value) => {
    expect(parseToolNumber(text)).toEqual({ ok: true, value });
  });

  it.each([
    ['', 'Enter a filament slot number.'],
    ['   ', 'Enter a filament slot number.'],
    ['0', 'The filament slot must be a whole number from 1 to 100.'],
    ['101', 'The filament slot must be a whole number from 1 to 100.'],
    ['2.5', 'Enter a whole number from 1 to 100.'],
    ['-1', 'Enter a whole number from 1 to 100.'],
    ['1e1', 'Enter a whole number from 1 to 100.'],
  ])('rejects %j with a user-worded message', (text, error) => {
    expect(parseToolNumber(text)).toEqual({ ok: false, error });
  });
});
