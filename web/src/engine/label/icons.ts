/**
 * Icon set for bin labels: original filled silhouettes of common hardware,
 * drawn for this project (no external license applies). Fasteners are shown
 * in side view, head on the left and threaded shank on the right, with bold
 * triangular thread teeth so they stay readable when printed a few
 * millimetres tall. Nut and washer are shown face on. Each icon is a single
 * SVG path in a 100 x 100 viewBox, y down as in SVG, filled with the
 * even-odd rule so ring-shaped icons keep their holes.
 */

/** A filled single-path icon in SVG path-data form. */
export interface LabelIcon {
  /** Stable identifier, also the UI display key. */
  name: string;
  /** SVG path d attribute describing the filled silhouette. */
  path: string;
  /** The viewBox the path coordinates live in: [minX, minY, width, height]. */
  viewBox: [number, number, number, number];
}

const VIEW_BOX: [number, number, number, number] = [0, 0, 100, 100];

export const LABEL_ICONS: LabelIcon[] = [
  {
    // Flat countersunk head on the left, fully threaded tapered shank
    // running out to a point on the right.
    name: 'countersunk screw',
    path:
      'M2 28L16 39L24 26.1L32 41.2L40 28.3L48 43.4L56 34.3L64 45.6L72 40.6' +
      'L80 47.8L88 46.9L96 50L88 53.1L80 52.2L72 59.4L64 54.4L56 65.7L48 56.6' +
      'L40 71.7L32 58.8L24 73.9L16 61L2 72Z',
    viewBox: VIEW_BOX,
  },
  {
    // Chamfered pan head, uniform machine thread, blunt end.
    name: 'pan head screw',
    path:
      'M2 34L8 27L20 27L20 41L28 28L36 41L44 28L52 41L60 28L68 41L76 28' +
      'L84 41L92 41L92 59L84 59L76 72L68 59L60 72L52 59L44 72L36 59L28 72' +
      'L20 59L20 73L8 73L2 66Z',
    viewBox: VIEW_BOX,
  },
  {
    // Tall cylindrical socket head, uniform machine thread, blunt end.
    name: 'cap head screw',
    path:
      'M2 28L26 28L26 41L34 29L42 41L50 29L58 41L66 29L74 41L82 29L90 41' +
      'L92 41L92 59L90 59L82 71L74 59L66 71L58 59L50 71L42 59L34 71L26 59' +
      'L26 72L2 72Z',
    viewBox: VIEW_BOX,
  },
  {
    // Chamfered hex head in side view, plain shank, threaded end.
    name: 'hex bolt',
    path:
      'M2 36L9 29L22 29L22 41L58 41L66 29L74 41L82 29L90 41L94 41L94 59' +
      'L90 59L82 71L74 59L66 71L58 59L22 59L22 71L9 71L2 64Z',
    viewBox: VIEW_BOX,
  },
  {
    // Face-on hexagon with a round hole (even-odd).
    name: 'hex nut',
    path:
      'M96 50L73 89.8L27 89.8L4 50L27 10.2L73 10.2Z' +
      'M50 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z',
    viewBox: VIEW_BOX,
  },
  {
    // Face-on annulus (even-odd).
    name: 'washer',
    path:
      'M50 5a45 45 0 1 0 0 90a45 45 0 1 0 0-90Z' +
      'M50 29a21 21 0 1 0 0 42a21 21 0 1 0 0-42Z',
    viewBox: VIEW_BOX,
  },
  {
    // Heat-set insert: plain collar on the left, bold knurled band,
    // chamfered lead end on the right.
    name: 'threaded insert',
    path:
      'M16 26L28 26L34 38L40 26L46 38L52 26L58 38L64 26L70 38L76 26L84 36' +
      'L84 64L76 74L70 62L64 74L58 62L52 74L46 62L40 74L34 62L28 74L16 74Z',
    viewBox: VIEW_BOX,
  },
  {
    // Sheet metal screw: pan head, coarse deep thread, pointed tip.
    name: 'self-tapping screw',
    path:
      'M2 34L8 27L20 27L20 42L30 28L40 42L50 28L60 42L70 28L80 36.5L88 47.5' +
      'L96 50L88 52.5L80 63.5L70 72L60 58L50 72L40 58L30 72L20 58L20 73' +
      'L8 73L2 66Z',
    viewBox: VIEW_BOX,
  },
];

/** Look up an icon by name, or throw when the name is unknown. */
export function iconByName(name: string): LabelIcon {
  const icon = LABEL_ICONS.find((entry) => entry.name === name);
  if (!icon) {
    throw new Error(`Unknown label icon "${name}"`);
  }
  return icon;
}
