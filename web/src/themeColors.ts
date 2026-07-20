/**
 * The workshop theme's palette, in one place.
 *
 * Vuetify turns these into CSS variables, which is all the DOM ever needs. The
 * 3D viewports do not paint DOM: they paint WebGL materials, which no CSS
 * variable reaches, so they have to be given the figures directly. Both readers
 * take them from here, so a ghost in the viewport and a chip beside it are the
 * same colour rather than two hex literals that drift apart.
 *
 * Framework-agnostic on purpose: this is a table of colours and nothing else,
 * so the geometry viewports can import it without pulling in the app entry.
 */

// The surface ladder, darkest to lightest: page, card, control. Every grey in
// the app resolves to one of these three, and the muted neutral is also the
// hairline border colour, so none of them is written down twice.
export const PAGE = '#101010';
export const CARD = '#1a1a1a';
export const CONTROL = '#2f2f2f';
export const MUTED_NEUTRAL = '#444444';

// Warm off-white body text. The second text level is this colour at the
// medium-emphasis opacity, and there is no third level.
export const TEXT = '#ece7df';

/** The single muted amber accent: primary buttons, active tabs, focus rings. */
export const PRIMARY = '#b8752a';

/** White label text on the amber accent, as reviewed and approved on the mockup. */
export const ON_PRIMARY = '#ffffff';

export const SUCCESS = '#23a55a';
export const WARNING = '#f0b232';
export const ERROR = '#da373c';
export const INFO = '#00a8fc';
