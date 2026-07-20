import { binTopOpeningMm } from '../gridfinity/constants';
import { assertNever } from './types';

/**
 * Screw-list shorthand parsing and bin sizing for the "add bins from a screw
 * list" flow. Pure functions, no Vue or DOM.
 *
 * Grammar (case-insensitive, whitespace-tolerant), one batch per
 * comma-separated segment:
 *
 *   batch  := parts in any order, at most one of each:
 *             thread, length, head, quantity
 *   thread := "M" digit+ ("." digit+)?          M2, M2.5, M3, ...
 *           | "#" digit+ ("-" TPI)?             #8, #8-32 (normalized to #8)
 *           | digit+ "/" digit+ "-" TPI         1/4-20, 5/16-18
 *   length := digit+ ("mm")?                    1 to 1000 integer millimetres
 *           | inches ('"' | "in")?              1", 1-1/2", 1/2", 1in
 *   head   := an alias from HEAD_ALIASES        may come before or after the
 *                                               thread/length pair
 *   qty    := "x" digit+ | "*" digit+ | "qty" digit+
 *
 * "m3x20 fhcs x6" and "fhcs m3x20mm x6" parse identically. The head is
 * optional; when omitted it stays unspecified, never guessed.
 *
 * Imperial lengths are converted to the canonical lengthMm by multiplying by
 * 25.4 and rounding to the nearest whole millimetre (bins are sized with a
 * 4 mm handling clearance, so sub-millimetre precision carries no meaning).
 * The text as entered is kept in enteredLengthText for display and labels.
 * A number-series thread's TPI suffix is dropped from the normalized thread
 * ("#8-32" reads as "#8"); a fractional thread keeps its TPI ("1/4-20"),
 * because that is how each is conventionally written on labels. An inch
 * suffix is optional inside a combined imperial token ("#8x1-1/2") and for
 * any fractional length; a bare integer is metric millimetres unless it
 * follows an imperial thread in the same combined token.
 *
 * Extension over the base grammar: nuts, washers and threaded inserts have no
 * meaningful length, so a batch like "m5 nut" is complete without one, and the
 * composed label drops the length part ("M5 NUT").
 */

/** Canonical head types. All but 'wood screw' are also label icon names. */
export type HeadType =
  | 'countersunk screw'
  | 'pan head screw'
  | 'cap head screw'
  | 'hex bolt'
  | 'wood screw'
  | 'self-tapping screw'
  | 'pocket screw'
  | 'brad'
  | 'dowel'
  | 'hex nut'
  | 'washer'
  | 'threaded insert';

/** Every canonical head type, in UI display order. */
export const HEAD_TYPES: HeadType[] = [
  'countersunk screw',
  'pan head screw',
  'cap head screw',
  'hex bolt',
  'wood screw',
  'self-tapping screw',
  'pocket screw',
  'brad',
  'dowel',
  'hex nut',
  'washer',
  'threaded insert',
];

/** Shorthand words (lowercase) accepted for each head type. */
export const HEAD_ALIASES: Record<string, HeadType> = {
  fhcs: 'countersunk screw',
  csk: 'countersunk screw',
  countersunk: 'countersunk screw',
  flat: 'countersunk screw',
  bhcs: 'pan head screw',
  button: 'pan head screw',
  pan: 'pan head screw',
  shcs: 'cap head screw',
  cap: 'cap head screw',
  socket: 'cap head screw',
  hex: 'hex bolt',
  hexbolt: 'hex bolt',
  'hex bolt': 'hex bolt',
  hexnut: 'hex nut',
  'hex nut': 'hex nut',
  nut: 'hex nut',
  washer: 'washer',
  insert: 'threaded insert',
  heatset: 'threaded insert',
  'heat-set': 'threaded insert',
  'self-tap': 'self-tapping screw',
  selftap: 'self-tapping screw',
  tek: 'self-tapping screw',
  wood: 'wood screw',
  pocket: 'pocket screw',
  'pocket screw': 'pocket screw',
  brad: 'brad',
  dowel: 'dowel',
};

/** The abbreviation each head type contributes to the label text. */
export const HEAD_LABEL_ABBREV: Record<HeadType, string> = {
  'countersunk screw': 'FHCS',
  'pan head screw': 'PAN',
  'cap head screw': 'SHCS',
  'hex bolt': 'HEX',
  'wood screw': 'WOOD',
  'self-tapping screw': 'ST',
  'pocket screw': 'POCKET',
  brad: 'BRAD',
  dowel: 'DOWEL',
  'hex nut': 'NUT',
  washer: 'WASHER',
  'threaded insert': 'INSERT',
};

/** The label icon name for each head type (wood screws share the self-tapping icon). */
export const HEAD_ICON_NAME: Record<HeadType, string> = {
  'countersunk screw': 'countersunk screw',
  'pan head screw': 'pan head screw',
  'cap head screw': 'cap head screw',
  'hex bolt': 'hex bolt',
  'wood screw': 'self-tapping screw',
  'self-tapping screw': 'self-tapping screw',
  'pocket screw': 'pocket screw',
  brad: 'brad',
  dowel: 'dowel',
  'hex nut': 'hex nut',
  washer: 'washer',
  'threaded insert': 'threaded insert',
};

/** Head types with no meaningful length (label and sizing skip the length). */
export const LENGTHLESS_HEADS: ReadonlySet<HeadType> = new Set<HeadType>([
  'hex nut',
  'washer',
  'threaded insert',
]);

/** The supported fastener length range in millimetres. */
export const MIN_LENGTH_MM = 1;
export const MAX_LENGTH_MM = 1000;

/** The measurement system a batch was entered in. */
export type EnteredUnit = 'metric' | 'imperial';

/** One parsed batch of identical fasteners. Null fields were not given. */
export interface ScrewBatch {
  /** Thread size, normalized like 'M3', '#8' or '1/4-20', or null when the batch had none. */
  thread: string | null;
  /** Fastener length in whole millimetres (canonical), or null when absent or invalid. */
  lengthMm: number | null;
  /** Canonical head type, or null when unspecified. */
  head: HeadType | null;
  /** How many fasteners the batch calls for. At least 1, defaults to 1. */
  quantity: number;
  /** Whether the batch was entered in metric or imperial notation. */
  enteredUnit: EnteredUnit;
  /** The length as entered for an imperial batch ('1-1/2"'), display only. */
  enteredLengthText: string | null;
}

/** Result of parsing one shorthand line. */
export interface ParsedShorthand {
  /** One batch per comma-separated segment that contained anything readable. */
  batches: ScrewBatch[];
  /** User-worded problems, each naming the token or segment it refers to. */
  errors: string[];
}

const COMBINED_TOKEN = /^m(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?)(mm)?)?(?:x(\d+))?$/;
const MARKED_NUMBER = /^[x*](\d+(?:\.\d+)?)(mm)?$/;
const BARE_NUMBER = /^(\d+(?:\.\d+)?)(mm)?$/;
const QTY_WORD = /^qty(\d+)?$/;

// Imperial threads: a number series like #8 or #8-32, or a fractional inch
// size with its TPI like 1/4-20.
const NUMBER_THREAD = /^#(\d{1,2})(?:-(\d{2,3}))?$/;
const FRACTION_THREAD = /^(\d+)\/(\d+)-(\d{2,3})$/;
// Imperial lengths: 1, 1-1/2 or 1/2, with an optional " or "in" suffix. The
// bare-integer form is only read as inches inside a combined imperial token;
// elsewhere the suffix or a fraction is required to distinguish it from mm.
const IMPERIAL_LENGTH = /^(?:[x*])?(\d+)(?:-(\d+)\/(\d+))?(?:"|”|in)?$/;
const IMPERIAL_FRACTION_LENGTH = /^(?:[x*])?(\d+)\/(\d+)(?:"|”|in)?$/;
// A combined imperial token: thread, an x, and an imperial length.
const COMBINED_IMPERIAL = /^(#\d{1,2}(?:-\d{2,3})?|\d+\/\d+-\d{2,3})(?:x(.+))?$/;

const MM_PER_INCH = 25.4;

/** Parse an imperial length token into inches plus its normalized display text. */
function parseImperialLength(word: string): { inches: number; text: string } | null {
  let match = IMPERIAL_FRACTION_LENGTH.exec(word);
  if (match !== null) {
    const den = Number(match[2]);
    if (den === 0) return null;
    return { inches: Number(match[1]) / den, text: `${match[1]}/${match[2]}"` };
  }
  match = IMPERIAL_LENGTH.exec(word);
  if (match === null) return null;
  const whole = Number(match[1]);
  if (match[2] !== undefined) {
    const den = Number(match[3]);
    if (den === 0) return null;
    return {
      inches: whole + Number(match[2]) / den,
      text: `${match[1]}-${match[2]}/${match[3]}"`,
    };
  }
  return { inches: whole, text: `${match[1]}"` };
}

/** True when the token spells an imperial length explicitly (suffix or fraction). */
function isExplicitImperialLength(word: string): boolean {
  if (parseImperialLength(word) === null) return false;
  return /(?:"|”|in)$/.test(word) || word.includes('/');
}

/** Normalize an imperial thread token: '#8-32' reads as '#8', '1/4-20' stays. */
function normalizeImperialThread(token: string): string {
  const numberSeries = NUMBER_THREAD.exec(token);
  if (numberSeries !== null) return `#${numberSeries[1]}`;
  return token;
}

/** Parses one line of screw-list shorthand into batches plus error messages. */
export function parseShorthand(line: string): ParsedShorthand {
  const batches: ScrewBatch[] = [];
  const errors: string[] = [];
  for (const segment of line.split(',')) {
    const text = segment.trim();
    if (text === '') continue;
    const batch = parseBatchSegment(text, errors);
    if (batch !== null) batches.push(batch);
  }
  return { batches, errors };
}

function parseBatchSegment(text: string, errors: string[]): ScrewBatch | null {
  const words = text.toLowerCase().replace(/×/g, 'x').split(/\s+/).filter(Boolean);
  let thread: string | null = null;
  let lengthMm: number | null = null;
  let lengthSeen = false;
  let head: HeadType | null = null;
  let quantity: number | null = null;
  let expectQty = false;
  let pendingSeparator = false;
  let sawAnything = false;
  let imperial = false;
  let enteredLengthText: string | null = null;

  const setLength = (raw: string): void => {
    lengthSeen = true;
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      errors.push(`The length '${raw}' must be a whole number of millimetres.`);
      return;
    }
    if (value < MIN_LENGTH_MM || value > MAX_LENGTH_MM) {
      errors.push(
        `The length '${raw}' is outside the supported ${MIN_LENGTH_MM} to ${MAX_LENGTH_MM} mm range.`,
      );
      return;
    }
    lengthMm = value;
  };

  const setImperialLength = (word: string): void => {
    lengthSeen = true;
    imperial = true;
    const parsedLength = parseImperialLength(word);
    if (parsedLength === null) {
      errors.push(`Can't read the length '${word}'.`);
      return;
    }
    const mm = Math.round(parsedLength.inches * MM_PER_INCH);
    if (mm < MIN_LENGTH_MM || mm > MAX_LENGTH_MM) {
      errors.push(
        `The length '${parsedLength.text}' (${mm} mm) is outside the supported ${MIN_LENGTH_MM} to ${MAX_LENGTH_MM} mm range.`,
      );
      return;
    }
    lengthMm = mm;
    enteredLengthText = parsedLength.text;
  };

  const setQty = (raw: string): void => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`The quantity '${raw}' must be a whole number of at least 1.`);
      return;
    }
    quantity = value;
  };

  let i = 0;
  while (i < words.length) {
    const word = words[i];
    // Two-word head aliases ("hex bolt") take precedence over one-word ones ("hex").
    const pair = i + 1 < words.length ? `${word} ${words[i + 1]}` : null;
    if (pair !== null && HEAD_ALIASES[pair] !== undefined) {
      head = HEAD_ALIASES[pair];
      sawAnything = true;
      i += 2;
      continue;
    }
    if (HEAD_ALIASES[word] !== undefined) {
      head = HEAD_ALIASES[word];
      sawAnything = true;
      i += 1;
      continue;
    }
    let match = COMBINED_TOKEN.exec(word);
    if (match !== null) {
      thread = `M${match[1]}`;
      if (match[2] !== undefined) setLength(match[2]);
      if (match[4] !== undefined) setQty(match[4]);
      sawAnything = true;
      i += 1;
      continue;
    }
    // An imperial thread, alone or combined with an inch length ("#8x1-1/2").
    match = COMBINED_IMPERIAL.exec(word);
    if (match !== null && (NUMBER_THREAD.test(match[1]) || FRACTION_THREAD.test(match[1]))) {
      thread = normalizeImperialThread(match[1]);
      imperial = true;
      if (match[2] !== undefined) setImperialLength(match[2]);
      sawAnything = true;
      i += 1;
      continue;
    }
    // An explicit imperial length ('1-1/2"', '3/4in', or any fraction).
    if (isExplicitImperialLength(word)) {
      pendingSeparator = false;
      if (!lengthSeen && (head === null || !LENGTHLESS_HEADS.has(head))) {
        setImperialLength(word);
      } else {
        errors.push(`Can't read '${word}'. Use 'x4' for a quantity.`);
      }
      sawAnything = true;
      i += 1;
      continue;
    }
    if (word === 'x' || word === '*') {
      pendingSeparator = true;
      i += 1;
      continue;
    }
    const qtyWord = QTY_WORD.exec(word);
    if (qtyWord !== null) {
      if (qtyWord[1] !== undefined) setQty(qtyWord[1]);
      else expectQty = true;
      sawAnything = true;
      i += 1;
      continue;
    }
    match = MARKED_NUMBER.exec(word) ?? (pendingSeparator ? BARE_NUMBER.exec(word) : null);
    if (match !== null) {
      // A marked number is the length while none is known (and the head does
      // not rule one out); once the length is settled it reads as a quantity.
      pendingSeparator = false;
      if (expectQty) {
        setQty(match[1]);
        expectQty = false;
      } else if (!lengthSeen && (head === null || !LENGTHLESS_HEADS.has(head))) {
        setLength(match[1]);
      } else {
        setQty(match[1]);
      }
      sawAnything = true;
      i += 1;
      continue;
    }
    match = BARE_NUMBER.exec(word);
    if (match !== null) {
      if (expectQty) {
        setQty(match[1]);
        expectQty = false;
      } else if (!lengthSeen) {
        setLength(match[1]);
      } else {
        errors.push(`Can't read '${word}'. Use 'x${match[1]}' for a quantity.`);
      }
      sawAnything = true;
      i += 1;
      continue;
    }
    errors.push(`Can't read head type '${word}'. Pick one from the row's dropdown instead.`);
    sawAnything = true;
    i += 1;
  }

  if (!sawAnything) return null;
  if (thread === null) {
    errors.push(`Can't find a thread size (like M3 or #8) in '${text}'.`);
  }
  if (!lengthSeen && (head === null || !LENGTHLESS_HEADS.has(head))) {
    errors.push(`'${text}' has no length. Add one like 'x20' or fill it in on the row.`);
  }
  return {
    thread,
    lengthMm,
    head,
    quantity: quantity ?? 1,
    enteredUnit: imperial ? 'imperial' : 'metric',
    enteredLengthText,
  };
}

/**
 * Composes shorthand text from the structured breakdown fields, the inverse
 * of parseBatchSegment for a single batch. Round-trips with parseShorthand:
 * parsing the result back reproduces the same thread, length and head. Used
 * to keep the shorthand text field in sync when the picker fields change.
 */
export function composeShorthand(
  thread: string | null,
  lengthMm: number | null,
  head: HeadType | null,
  count: number,
): string {
  const lengthless = head !== null && LENGTHLESS_HEADS.has(head);
  const parts: string[] = [];
  if (thread !== null && lengthMm !== null && !lengthless) {
    parts.push(`${thread}x${lengthMm}`);
  } else {
    if (thread !== null) parts.push(thread);
    if (lengthMm !== null && !lengthless) parts.push(`x${lengthMm}`);
  }
  if (head !== null) parts.push(HEAD_ALIASES_REVERSE[head]);
  if (count > 1) parts.push(`x${count}`);
  return parts.join(' ');
}

/** Canonical shorthand alias used to compose text back out for each head type. */
const HEAD_ALIASES_REVERSE: Record<HeadType, string> = {
  'countersunk screw': 'fhcs',
  'pan head screw': 'bhcs',
  'cap head screw': 'shcs',
  'hex bolt': 'hex bolt',
  'wood screw': 'wood',
  'self-tapping screw': 'self-tap',
  'pocket screw': 'pocket screw',
  brad: 'brad',
  dowel: 'dowel',
  'hex nut': 'hex nut',
  washer: 'washer',
  'threaded insert': 'insert',
};

/**
 * Composes the bin label text for a batch, from whichever parts are present:
 * "M3 x 20", or "M5 NUT" for a lengthless head. The head type is shown
 * pictorially via the icon instead of spelled out in the text, so the
 * abbreviation is dropped once a length is present; a lengthless head (nut,
 * washer, insert) keeps its abbreviation since the text would otherwise carry
 * no information at all. An imperial batch prints its length as entered:
 * '#8 x 1-1/2"'.
 */
export function composeLabelText(
  thread: string | null,
  lengthMm: number | null,
  head: HeadType | null,
  enteredLengthText: string | null = null,
): string {
  const parts: string[] = [];
  if (thread !== null) parts.push(thread);
  const lengthless = head !== null && LENGTHLESS_HEADS.has(head);
  if (lengthMm !== null && !lengthless) {
    parts.push(`x ${enteredLengthText ?? lengthMm}`);
  }
  if (lengthless) parts.push(HEAD_LABEL_ABBREV[head as HeadType]);
  return parts.join(' ');
}

/**
 * The nominal major diameter of a thread designation, in millimetres, or null
 * when the thread is absent or unrecognized. Used only to derive a head height
 * for bin sizing, never for geometry.
 *
 * Metric 'M<d>' is the diameter directly. Imperial number sizes use the ANSI
 * unified formula d = 0.060 in + 0.013 in * N (ASME B1.1 / ANSI B18.6.3), so
 * '#8' is 0.164 in. A fractional size like '1/4-20' is the fraction in inches.
 * Inch diameters convert at 25.4 mm per inch.
 */
export function threadDiameterMm(thread: string | null): number | null {
  if (thread === null) return null;
  const metric = /^M(\d+(?:\.\d+)?)$/.exec(thread);
  if (metric !== null) return Number(metric[1]);
  const numberSeries = /^#(\d{1,2})$/.exec(thread);
  if (numberSeries !== null) {
    const n = Number(numberSeries[1]);
    return (0.06 + 0.013 * n) * MM_PER_INCH;
  }
  const fraction = /^(\d+)\/(\d+)-\d{2,3}$/.exec(thread);
  if (fraction !== null) {
    const den = Number(fraction[2]);
    if (den === 0) return null;
    return (Number(fraction[1]) / den) * MM_PER_INCH;
  }
  return null;
}

/**
 * ISO 4014/4017 hexagon bolt head height k, keyed by nominal diameter (mm).
 * The head height is not a clean ratio of the diameter, so the standard's
 * tabulated values are listed for every metric size the parser accepts; the
 * three imperial sizes the picker offers carry their ASME B18.2.1 hex cap
 * screw head heights (0.163, 0.211 and 0.243 in) at their converted diameters.
 * Matched by nearest diameter within HEX_DIAMETER_EPS_MM so an inch diameter's
 * rounding does not miss its row.
 */
const HEX_HEAD_HEIGHT_MM: ReadonlyArray<readonly [number, number]> = [
  // ISO 4014/4017 (ISO 4014:2011 Table 2), diameter -> k_nominal:
  [1.6, 1.1],
  [2, 1.4],
  [2.5, 1.7],
  [3, 2.0],
  [4, 2.8],
  [5, 3.5],
  [6, 4.0],
  [8, 5.3],
  [10, 6.4],
  [12, 7.5],
  [14, 8.8],
  [16, 10.0],
  [20, 12.5],
  [24, 15.0],
  [30, 18.7],
  [36, 22.5],
  // ASME B18.2.1 hex cap screw head height H (basic), diameter -> k:
  [0.25 * MM_PER_INCH, 0.163 * MM_PER_INCH], // 1/4 in
  [0.3125 * MM_PER_INCH, 0.211 * MM_PER_INCH], // 5/16 in
  [0.375 * MM_PER_INCH, 0.243 * MM_PER_INCH], // 3/8 in
];

const HEX_DIAMETER_EPS_MM = 0.1;

/** Hex bolt head height from the ISO 4014/4017 (or ASME B18.2.1) table. */
function hexHeadHeightMm(diameterMm: number): number {
  for (const [d, k] of HEX_HEAD_HEIGHT_MM) {
    if (Math.abs(d - diameterMm) <= HEX_DIAMETER_EPS_MM) return k;
  }
  // An unlisted diameter is sized conservatively at the socket cap head height
  // (k = d, ISO 4762) so the bin never comes out too short for the head.
  return diameterMm;
}

/**
 * The head height added to a fastener's nominal length to get its overall
 * length for bin sizing, in millimetres. By ISO/ASME convention a countersunk
 * (flat) screw's nominal length is already the overall length, so its head
 * adds nothing; every other head type is measured under the head, so its head
 * height is added. Zero when the head or diameter is unknown, or when the head
 * carries no length (a nut, washer or insert is sized without one).
 *
 * Standards per head type:
 *   cap head (ISO 4762): k = d.
 *   pan/button head (ISO 7380-1): k = 0.55 d (M3 1.65, M4 2.20, M5 2.75, ...).
 *   hex bolt (ISO 4014/4017, ASME B18.2.1): tabulated, see HEX_HEAD_HEIGHT_MM.
 *   countersunk (ISO 10642): 0, the nominal length is the overall length.
 *   self-tapping / pocket screw: measured under the head; no single ISO length
 *     standard fixes their head height, so the ISO 7380-1 button ratio 0.55 d
 *     is used as the published pan-family figure.
 *   wood screw (ANSI/ASME B18.6.1 flat head): countersunk, measured overall, 0.
 *   brad (ASTM F1667 finish nail): measured overall, negligible head, 0.
 *   dowel pin (ISO 2338): no head, overall length, 0.
 */
export function headHeightMm(head: HeadType | null, diameterMm: number | null): number {
  if (head === null || diameterMm === null) return 0;
  switch (head) {
    case 'cap head screw':
      return diameterMm; // ISO 4762 k = d.
    case 'pan head screw':
    case 'self-tapping screw':
    case 'pocket screw':
      return 0.55 * diameterMm; // ISO 7380-1 button head k = 0.55 d.
    case 'hex bolt':
      return hexHeadHeightMm(diameterMm);
    case 'countersunk screw': // ISO 10642: nominal length is overall.
    case 'wood screw': // ANSI/ASME B18.6.1 flat head: measured overall.
    case 'brad': // ASTM F1667: measured overall.
    case 'dowel': // ISO 2338: no head.
    case 'hex nut': // Lengthless: sized without a length.
    case 'washer':
    case 'threaded insert':
      return 0;
    default:
      return assertNever(head);
  }
}

/**
 * A fastener's overall length in millimetres: its nominal length plus the head
 * height that ISO/ASME convention leaves out for every head type but the
 * countersunk one. Null when there is no length to size from. This is the
 * single figure bin sizing measures; callers pass its result to
 * computeBinWidthUnits rather than the nominal length.
 */
export function overallLengthMm(spec: {
  thread: string | null;
  lengthMm: number | null;
  head: HeadType | null;
}): number | null {
  if (spec.lengthMm === null) return null;
  return spec.lengthMm + headHeightMm(spec.head, threadDiameterMm(spec.thread));
}

/**
 * Room to spare around a fastener lying flat in its bin, so it can be picked
 * up with fingers and does not wedge against the walls.
 */
export const HANDLING_CLEARANCE_MM = 4;

/**
 * The smallest bin width in grid units whose clear top opening passes a
 * fastener of the given length plus HANDLING_CLEARANCE_MM. The screw is
 * dropped in through the top, and queued bins carry the stacking lip, whose
 * seat overhangs the interior: the narrowed opening at the lip tip
 * (binTopOpeningMm) is what the screw must clear, not the interior below.
 */
export function computeBinWidthUnits(lengthMm: number): number {
  const needed = lengthMm + HANDLING_CLEARANCE_MM;
  let units = 1;
  while (binTopOpeningMm(units) < needed) units += 1;
  return units;
}

/** A raw row headed for grouping: a batch plus its effective bin width. */
export interface GroupableRow {
  thread: string | null;
  lengthMm: number | null;
  head: HeadType | null;
  quantity: number;
  widthUnits: number;
  /** Imperial length as entered, for labels; omitted or null for metric rows. */
  enteredLengthText?: string | null;
}

/** One grouped bin entry, merged from rows with identical thread, length and head. */
export interface BatchGroup {
  thread: string | null;
  lengthMm: number | null;
  head: HeadType | null;
  /** Sum of the merged rows' quantities. */
  quantity: number;
  /** The widest of the merged rows' bin widths, so no override is lost. */
  widthUnits: number;
  /** How many raw rows merged into this group. */
  rowCount: number;
  /** Imperial length as entered, taken from the first merged row that had one. */
  enteredLengthText: string | null;
}

/**
 * Collapses rows with identical (thread, length, head) into one group each,
 * summing quantities. Order follows each group's first appearance.
 */
export function groupBatchRows(rows: GroupableRow[]): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  for (const row of rows) {
    const key = `${row.thread}|${row.lengthMm}|${row.head}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        thread: row.thread,
        lengthMm: row.lengthMm,
        head: row.head,
        quantity: row.quantity,
        widthUnits: row.widthUnits,
        rowCount: 1,
        enteredLengthText: row.enteredLengthText ?? null,
      });
    } else {
      existing.quantity += row.quantity;
      existing.widthUnits = Math.max(existing.widthUnits, row.widthUnits);
      existing.rowCount += 1;
      if (existing.enteredLengthText === null) {
        existing.enteredLengthText = row.enteredLengthText ?? null;
      }
    }
  }
  return [...groups.values()];
}
