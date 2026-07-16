/**
 * Icon set for bin labels: original filled silhouettes of common hardware,
 * drawn for this project (no external license applies). Fasteners are shown
 * in side view, head on the left and threaded shank on the right, with bold
 * triangular thread teeth so they stay readable when printed a few
 * millimetres tall. Nut and washer are shown face on. The general category
 * adds silhouettes of common workshop items drawn to the same rules. Each
 * icon is a single
 * SVG path in a 100 x 100 viewBox, y down as in SVG, filled with the
 * even-odd rule so ring-shaped icons keep their holes.
 */

/** The picker category an icon belongs to. */
export type IconCategory = 'fasteners' | 'general' | 'custom';

/** A filled single-path icon in SVG path-data form. */
export interface LabelIcon {
  /** Stable identifier, also the UI display key. */
  name: string;
  /** SVG path d attribute describing the filled silhouette. */
  path: string;
  /** The viewBox the path coordinates live in: [minX, minY, width, height]. */
  viewBox: [number, number, number, number];
  /** Which picker category the icon is listed under. */
  category: IconCategory;
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
    category: 'fasteners',
  },
  {
    // Chamfered pan head, uniform machine thread, blunt end.
    name: 'pan head screw',
    path:
      'M2 34L8 27L20 27L20 41L28 28L36 41L44 28L52 41L60 28L68 41L76 28' +
      'L84 41L92 41L92 59L84 59L76 72L68 59L60 72L52 59L44 72L36 59L28 72' +
      'L20 59L20 73L8 73L2 66Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Tall cylindrical socket head, uniform machine thread, blunt end.
    name: 'cap head screw',
    path:
      'M2 28L26 28L26 41L34 29L42 41L50 29L58 41L66 29L74 41L82 29L90 41' +
      'L92 41L92 59L90 59L82 71L74 59L66 71L58 59L50 71L42 59L34 71L26 59' +
      'L26 72L2 72Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Chamfered hex head in side view, plain shank, threaded end.
    name: 'hex bolt',
    path:
      'M2 36L9 29L22 29L22 41L58 41L66 29L74 41L82 29L90 41L94 41L94 59' +
      'L90 59L82 71L74 59L66 71L58 59L22 59L22 71L9 71L2 64Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Face-on hexagon with a round hole (even-odd).
    name: 'hex nut',
    path:
      'M96 50L73 89.8L27 89.8L4 50L27 10.2L73 10.2Z' +
      'M50 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Face-on annulus (even-odd).
    name: 'washer',
    path:
      'M50 5a45 45 0 1 0 0 90a45 45 0 1 0 0-90Z' +
      'M50 29a21 21 0 1 0 0 42a21 21 0 1 0 0-42Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Heat-set insert: plain collar on the left, bold knurled band,
    // chamfered lead end on the right.
    name: 'threaded insert',
    path:
      'M16 26L28 26L34 38L40 26L46 38L52 26L58 38L64 26L70 38L76 26L84 36' +
      'L84 64L76 74L70 62L64 74L58 62L52 74L46 62L40 74L34 62L28 74L16 74Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Sheet metal screw: pan head, coarse deep thread, pointed tip.
    name: 'self-tapping screw',
    path:
      'M2 34L8 27L20 27L20 42L30 28L40 42L50 28L60 42L70 28L80 36.5L88 47.5' +
      'L96 50L88 52.5L80 63.5L70 72L60 58L50 72L40 58L30 72L20 58L20 73' +
      'L8 73L2 66Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Thin nail in side view: a small flat head on the left and a slender
    // shank running out to a point on the right.
    name: 'brad',
    path:
      'M2 28L10 28L10 43L88 43L98 50L88 57L10 57L10 72L2 72Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Plain cylindrical pin in side view with a chamfer on each end.
    name: 'dowel',
    path:
      'M10 30L90 30L98 38L98 62L90 70L10 70L2 62L2 38Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Pocket-hole screw: chamfered pan head, coarse deep thread, blunt tip.
    name: 'pocket screw',
    path:
      'M2 34L8 27L20 27L20 42L32 28L44 42L56 28L68 42L80 28L92 42L92 58' +
      'L80 72L68 58L56 72L44 58L32 72L20 58L20 73L8 73L2 66Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Mains plug in side view: two prongs on the left, a blocky plug body,
    // and the cord running off to the right.
    name: 'cable',
    path:
      'M2 24L18 24L18 16L42 16L42 42L96 42L96 58L42 58L42 84L18 84L18 76' +
      'L2 76L2 62L18 62L18 38L2 38Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Cylindrical cell in side view with the positive terminal nub on the right.
    name: 'battery',
    path:
      'M4 30L84 30L84 42L96 42L96 58L84 58L84 70L4 70Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Toy brick in side view with two studs on top.
    name: 'lego brick',
    path:
      'M5 45L20 45L20 30L40 30L40 45L60 45L60 30L80 30L80 45L95 45L95 85L5 85Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Axial resistor in side view: a wide body with a wire lead on each side.
    name: 'resistor',
    path:
      'M2 43L14 43L14 30L86 30L86 43L98 43L98 57L86 57L86 70L14 70L14 57L2 57Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // DIP package face on: a rectangular body with three pins per side.
    name: 'ic chip',
    path:
      'M22 16L78 16L78 22L94 22L94 36L78 36L78 43L94 43L94 57L78 57L78 64' +
      'L94 64L94 78L78 78L78 84L22 84L22 78L6 78L6 64L22 64L22 57L6 57' +
      'L6 43L22 43L22 36L6 36L6 22L22 22Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Compression spring in side view: a bold zigzag band of coils.
    name: 'spring',
    path:
      'M4 55L24 20L44 55L64 20L84 55L84 83L64 48L44 83L24 48L4 83Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Ball bearing face on: a wide annulus (even-odd) around the bore.
    name: 'bearing',
    path:
      'M50 5a45 45 0 1 0 0 90a45 45 0 1 0 0-90Z' +
      'M50 34a16 16 0 1 0 0 32a16 16 0 1 0 0-32Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Screwdriver bit in side view: hex shank on the left, a narrow neck and
    // a flared driving tip on the right.
    name: 'bit',
    path:
      'M4 33L55 33L55 40L70 40L82 30L96 30L96 70L82 70L70 60L55 60L55 67L4 67Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Glue bottle in side view: nozzle on top, sloped shoulder, wide body.
    name: 'adhesive',
    path:
      'M14 40L38 40L38 26L44 26L44 8L56 8L56 26L62 26L62 40L86 40L86 92L14 92Z',
    viewBox: VIEW_BOX,
    category: 'general',
  },
  {
    // Storage carton face on: a wide lid band over the box body.
    name: 'misc box',
    path:
      'M8 34L92 34L92 48L84 48L84 90L16 90L16 48L8 48Z',
    viewBox: VIEW_BOX,
    category: 'general',
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
