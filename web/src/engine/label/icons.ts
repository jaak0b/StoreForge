/**
 * Starter icon set for bin labels: original filled silhouettes of common
 * hardware, drawn for this project (no external license applies). Each icon
 * is a single SVG path in a 24 x 24 viewBox, y down as in SVG, filled with
 * the even-odd rule so ring-shaped icons keep their holes.
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

export const LABEL_ICONS: LabelIcon[] = [
  {
    name: 'washer',
    path: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z',
    viewBox: [0, 0, 24, 24],
  },
  {
    name: 'nut',
    path: 'M21 12l-4.5 7.79h-9L3 12l4.5-7.79h9Z M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7Z',
    viewBox: [0, 0, 24, 24],
  },
  {
    name: 'bolt',
    path: 'M6 3h12v4h-3.5v12l-2.5 2l-2.5-2V7H6Z',
    viewBox: [0, 0, 24, 24],
  },
  {
    name: 'screw',
    path: 'M5 3h14l-4 4v10l-3 4l-3-4V7Z',
    viewBox: [0, 0, 24, 24],
  },
  {
    name: 'wood screw',
    path: 'M7 8a5 5 0 0 1 10 0h-2.5v9l-2.5 4l-2.5-4V8Z',
    viewBox: [0, 0, 24, 24],
  },
  {
    name: 'nail',
    path: 'M9 3h6v2h-2v14l-1 2l-1-2V5H9Z',
    viewBox: [0, 0, 24, 24],
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
