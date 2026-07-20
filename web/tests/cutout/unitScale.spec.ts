import { describe, expect, it } from 'vitest';
import {
  INCHES_UNIT_SCALE,
  METRES_UNIT_SCALE,
  proposeUnitScale,
} from '../../src/engine/cutout/unitScale';

/**
 * The unit question is the app's only defence against the one import failure
 * whose sole symptom is a wasted print: an inch- or metre-authored STL that
 * imports cleanly at the wrong size. What these tests hold is that it fires on
 * the sizes that are actually implausible, stays silent on the ones that are
 * not, and never changes anything by itself.
 */
describe('proposeUnitScale', () => {
  it('says nothing about a model of an ordinary size', () => {
    expect(proposeUnitScale('socket-19.stl', 42)).toBeNull();
  });

  it('proposes metres for a model too small to hold anything', () => {
    const proposal = proposeUnitScale('wrench.stl', 0.15);
    expect(proposal?.unit).toBe('metres');
    expect(proposal?.unitScale).toBe(METRES_UNIT_SCALE);
    expect(proposal?.acceptLabel).toBe('Rescale as metres');
    expect(proposal?.rejectLabel).toBe('Keep as millimetres');
    expect(proposal?.message).toBe(
      'The model "wrench.stl" is 0.15 mm at its longest, which is too small to hold ' +
        'anything. STL files do not record their units, so it was probably authored in ' +
        'metres. Rescale it as metres, or keep it as millimetres if the size is correct.',
    );
  });

  it('proposes inches for a model larger than any bin', () => {
    const proposal = proposeUnitScale('bracket.stl', 812.8);
    expect(proposal?.unit).toBe('inches');
    expect(proposal?.unitScale).toBe(INCHES_UNIT_SCALE);
    expect(proposal?.acceptLabel).toBe('Rescale as inches');
    expect(proposal?.message).toBe(
      'The model "bracket.stl" is 812.80 mm at its longest, which is larger than any bin ' +
        'this app can make. STL files do not record their units, so it was probably ' +
        'authored in inches. Rescale it as inches, or keep it as millimetres if the size ' +
        'is correct.',
    );
  });

  // The thresholds only decide whether a question is asked, so what matters is
  // that a model sitting exactly on one is left alone rather than nagged about.
  it('leaves a model exactly on either threshold alone', () => {
    expect(proposeUnitScale('a.stl', 3)).toBeNull();
    expect(proposeUnitScale('a.stl', 500)).toBeNull();
  });

  it('quotes the measured size the user can compare against the file', () => {
    expect(proposeUnitScale('a.stl', 1.5)?.message).toContain('is 1.50 mm at its longest');
  });
});
