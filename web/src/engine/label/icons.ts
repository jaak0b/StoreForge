/**
 * Icon set for bin labels: original filled silhouettes of common hardware,
 * drawn for this project (no external license applies). Each icon is a
 * single SVG path in a 100 x 100 viewBox, y down as in SVG, filled with the
 * even-odd rule so ring-shaped icons keep their holes.
 *
 * Fastener head-type icons (the ones named in HEAD_ICON_NAME) use a two-view
 * technical-drawing layout: an end view on the left (x 0-44, a filled circle
 * or hexagon with the drive cut out as an even-odd hole: hex socket, Phillips
 * cross, square, or no hole where there is no drive) and a side view on the
 * right (x 56-100, the head profile silhouette plus a smooth shaft with no
 * thread teeth, since teeth that fine do not print cleanly). The 12-unit gap
 * between the two views keeps them visually separate. The general category
 * adds silhouettes of common workshop items drawn to the same single-view
 * rules as before.
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
    // Two-view: end view is a circle with a hex-socket hole (flat head cap
    // screws take a hex key); side view is the flat, tapered countersunk
    // head profile plus a smooth shaft.
    name: 'countersunk screw',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M33 50L28.5 42.21L19.5 42.21L15 50L19.5 57.79L28.5 57.79Z' +
      'M56 30L56 70L78 56L100 56L100 44L78 44Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a circle with a small hex-socket hole (button
    // head cap screws take a hex key); side view is the low domed head
    // profile plus a smooth shaft.
    name: 'pan head screw',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M31 50L27.5 43.94L20.5 43.94L17 50L20.5 56.06L27.5 56.06Z' +
      'M56 34L74 34L74 43L100 43L100 57L74 57L74 66L56 66Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a circle with a larger hex-socket hole (socket
    // cap screws take a hex key); side view is the tall cylindrical head
    // profile plus a smooth shaft.
    name: 'cap head screw',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M34 50L29 41.34L19 41.34L14 50L19 58.66L29 58.66Z' +
      'M56 30L80 30L80 43L100 43L100 57L80 57L80 70L56 70Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a solid hexagon (the wrench flats, no drive
    // hole); side view is the chamfered hex head profile plus a smooth
    // shank.
    name: 'hex bolt',
    path:
      'M44 50L34 32.68L14 32.68L4 50L14 67.32L34 67.32Z' +
      'M56 38L62 30L74 30L80 38L80 43L100 43L100 57L80 57L80 62L74 70L62 70L56 62Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a hexagon with a round bore (even-odd); side
    // view is the short chamfered block profile of the nut, no shaft.
    name: 'hex nut',
    path:
      'M44 50L34 32.68L14 32.68L4 50L14 67.32L34 67.32Z' +
      'M24 42a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z' +
      'M56 38L62 30L90 30L96 38L96 62L90 70L62 70L56 62Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is an annulus (even-odd), the bore through the
    // washer; side view is the thin flat plate profile.
    name: 'washer',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M24 40a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z' +
      'M56 44L100 44L100 56L56 56Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is an annulus (even-odd), the insert's internal
    // thread bore; side view is the plain collar with a chamfered lead end,
    // no knurl teeth so it stays printable at a few millimetres tall.
    name: 'threaded insert',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M24 42a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z' +
      'M56 36L86 36L94 44L94 56L86 64L56 64Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a circle with a Phillips cross-slot hole
    // (even-odd); side view is the low domed head profile plus a smooth
    // shaft tapered to a point (also used for wood screws).
    name: 'self-tapping screw',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M20 37L28 37L28 46L37 46L37 54L28 54L28 63L20 63L20 54L11 54L11 46L20 46Z' +
      'M56 34L74 34L74 43L92 43L100 50L92 57L74 57L74 66L56 66Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a plain filled circle (a brad has no drive);
    // side view is a small flat head plus a slender shank running out to a
    // point.
    name: 'brad',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M56 38L64 38L64 46L88 46L100 50L88 54L64 54L64 62L56 62Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a plain filled circle (round cross-section, no
    // drive); side view is a straight rod with a chamfer at each end.
    name: 'dowel',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M60 40L92 40L96 44L96 56L92 60L60 60L56 56L56 44Z',
    viewBox: VIEW_BOX,
    category: 'fasteners',
  },
  {
    // Two-view: end view is a circle with a square-drive hole (pocket
    // screws commonly take a square bit); side view is the wide flat
    // flange head profile plus a smooth shaft tapered to a point.
    name: 'pocket screw',
    path:
      'M24 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z' +
      'M17 43L31 43L31 57L17 57Z' +
      'M56 30L70 30L70 43L92 43L100 50L92 57L70 57L70 70L56 70Z',
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
