import { describe, expect, it } from 'vitest';
import {
  cavityEditRollbackCount,
  clampLastGoodEditCount,
} from '../../src/engine/carve/cavityEditRollback';

describe('cavityEditRollbackCount', () => {
  it('rolls back a bad edit painted after an undo, even though a running max would have equalled it', () => {
    // Repro: paint 3 good edits (a carve lands with editCount 3), undo one
    // (edits.length 2, a recarve of that lands too, editCount 2), paint one
    // bad edit (edits.length 3). A running max of landed counts would still
    // read 3, and 3 > 3 never rolls back. The direct-assignment count reads 2
    // after the undo's recarve lands, so 3 > 2 correctly asks for one pop.
    const lastGoodEditCount = 2;
    const currentLength = 3;
    expect(cavityEditRollbackCount(currentLength, lastGoodEditCount)).toBe(1);
  });

  it('asks for no rollback when the live length is already at the known-good count', () => {
    expect(cavityEditRollbackCount(3, 3)).toBe(0);
  });

  it('asks for no rollback when the live length is below the known-good count', () => {
    expect(cavityEditRollbackCount(1, 3)).toBe(0);
  });

  it('rolls back every suspect edit at once, not just the latest one', () => {
    // Two edits painted while a carve of the first known-good state was still
    // in flight, then that carve rejects: both are suspect.
    expect(cavityEditRollbackCount(5, 3)).toBe(2);
  });
});

describe('clampLastGoodEditCount', () => {
  it('keeps the landed count when it does not exceed the live edit list', () => {
    expect(clampLastGoodEditCount(3, 5)).toBe(3);
  });

  it('clamps to the live length when an undo shrank the list below the landed carve count', () => {
    // The carve was built from 5 edits, but the user undid two of them
    // before its result arrived; only 3 edits remain to call known-good.
    expect(clampLastGoodEditCount(5, 3)).toBe(3);
  });

  it('clamps to zero when every edit has been undone', () => {
    expect(clampLastGoodEditCount(4, 0)).toBe(0);
  });
});
