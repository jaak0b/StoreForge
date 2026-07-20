// An STL file declares no units at all: both the binary and the ASCII form
// store bare floating point coordinates with nothing anywhere saying what they
// measure. This app reads them as millimetres, as slicers do, which is right
// most of the time and silently wrong the rest. A model authored in inches or
// in metres is a perfectly valid file that imports without complaint, dilates
// by a clearance that no longer means anything relative to the part, and carves
// a pocket that fits nothing. It is the one import problem whose only symptom
// is a wasted print.
//
// This module owns the question the app asks about that, and nothing else. It
// never changes a model: it decides whether the size is implausible enough to
// be worth asking about, and words the question. The user's answer is the only
// thing that sets a unit scale, which is why the two thresholds below are
// allowed to be heuristics: nothing is derived from them.
//
// Whole units only, never a free scale factor. A free scale would let a user
// resize the part the pocket has to hold, which changes the fit silently and is
// exactly what the clearance exists to do properly. Rescaling by 25.4 is not
// resizing the part; it is stating what the part always measured.

/** Multiplier taking a file authored in metres to millimetres. */
export const METRES_UNIT_SCALE = 1000;

/** Multiplier taking a file authored in inches to millimetres. */
export const INCHES_UNIT_SCALE = 25.4;

/**
 * Below this largest dimension, read as millimetres, a model is more likely
 * authored in metres than genuinely that small. HEURISTIC, not a measured
 * constant: the smallest bin interior is about 39.6 mm across and nobody builds
 * a Gridfinity pocket for a 3 mm speck, while a 150 mm tool authored in metres
 * reads as 0.15. It only decides whether to ask the user a question.
 */
const METRES_THRESHOLD_MM = 3;

/**
 * Above this largest dimension, read as millimetres, a model is more likely
 * authored in inches than genuinely that large. HEURISTIC on the same terms:
 * the largest bin this app generates is bounded by the build plate, so a model
 * over half a metre in its longest direction cannot be carved into any of them.
 */
const INCHES_THRESHOLD_MM = 500;

/** How many decimals the proposal quotes the measured dimension to. */
const QUOTED_DECIMALS = 2;

/** A question about a model's units, with everything the buttons need. */
export interface UnitScaleProposal {
  /** The unit the file was probably authored in. */
  unit: 'metres' | 'inches';
  /** The multiplier accepting the proposal writes into the model record. */
  unitScale: number;
  /** The complete sentence stating the problem and the two ways out of it. */
  message: string;
  /** Label of the button that accepts the proposal. */
  acceptLabel: string;
  /** Label of the button that keeps the model at millimetres. */
  rejectLabel: string;
}

/** The label of the button that leaves a model's units alone. */
const KEEP_LABEL = 'Keep as millimetres';

/**
 * Whether a freshly imported model's size is implausible enough to ask the user
 * about its units, and what to ask. Returns null when the size is ordinary,
 * which is the common case and costs two comparisons.
 *
 * `largestDimensionMm` is the model's largest bounding box dimension read as
 * millimetres, which is the reading being questioned. Run this on a fresh
 * import and on a re-linked file, never on a model loaded back from a plan: the
 * answer is stored, and a user who has answered once must not be asked again.
 */
export function proposeUnitScale(
  name: string,
  largestDimensionMm: number,
): UnitScaleProposal | null {
  const measured = largestDimensionMm.toFixed(QUOTED_DECIMALS);
  if (largestDimensionMm < METRES_THRESHOLD_MM) {
    return {
      unit: 'metres',
      unitScale: METRES_UNIT_SCALE,
      message:
        `The model "${name}" is ${measured} mm at its longest, which is too small to hold ` +
        'anything. STL files do not record their units, so it was probably authored in ' +
        'metres. Rescale it as metres, or keep it as millimetres if the size is correct.',
      acceptLabel: 'Rescale as metres',
      rejectLabel: KEEP_LABEL,
    };
  }
  if (largestDimensionMm > INCHES_THRESHOLD_MM) {
    return {
      unit: 'inches',
      unitScale: INCHES_UNIT_SCALE,
      message:
        `The model "${name}" is ${measured} mm at its longest, which is larger than any bin ` +
        'this app can make. STL files do not record their units, so it was probably authored ' +
        'in inches. Rescale it as inches, or keep it as millimetres if the size is correct.',
      acceptLabel: 'Rescale as inches',
      rejectLabel: KEEP_LABEL,
    };
  }
  return null;
}
