import type { Font, PathCommand } from 'opentype.js';
import type { SimplePolygon } from 'manifold-3d';
import {
  DEFAULT_CHORD_TOLERANCE_MM,
  cleanContour,
  flattenCubic,
  flattenQuadratic,
} from './flatten';

/**
 * Cap height of the font in font units, taken from the OS/2 table with a
 * fallback measurement of the capital H outline for fonts that omit it.
 */
function capHeightUnits(font: Font): number {
  const fromTable = font.tables.os2?.sCapHeight;
  if (typeof fromTable === 'number' && fromTable > 0) return fromTable;
  const glyph = font.charToGlyph('H');
  const box = glyph.getBoundingBox();
  const measured = box.y2 - box.y1;
  if (measured > 0) return measured;
  throw new Error('The font reports no usable cap height.');
}

/**
 * Convert a text string to flat polygon contours in millimetres, sized so
 * capital letters are sizeMm tall. The output is a list of closed contours
 * (outlines and letter holes together) intended for an even-odd filled
 * cross-section; y points up and the baseline sits at y = 0.
 */
export function textToPolygons(
  font: Font,
  text: string,
  sizeMm: number,
  toleranceMm: number = DEFAULT_CHORD_TOLERANCE_MM,
): SimplePolygon[] {
  if (!(sizeMm > 0)) {
    throw new Error(`Text size must be positive, got ${sizeMm}`);
  }
  const fontSize = (sizeMm * font.unitsPerEm) / capHeightUnits(font);
  const scale = fontSize / font.unitsPerEm;

  // Build the glyph run character by character with advance widths and pair
  // kerning. This stays off opentype.js's OpenType-feature shaping path,
  // which rejects fonts using GSUB lookups it does not implement.
  const commands: PathCommand[] = [];
  let penX = 0;
  let previous: ReturnType<Font['charToGlyph']> | null = null;
  for (const char of text) {
    const glyph = font.charToGlyph(char);
    if (previous) {
      penX += font.getKerningValue(previous, glyph) * scale;
    }
    commands.push(...glyph.getPath(penX, 0, fontSize).commands);
    penX += (glyph.advanceWidth ?? 0) * scale;
    previous = glyph;
  }

  const contours: SimplePolygon[] = [];
  let current: SimplePolygon = [];
  // opentype.js emits y-down coordinates; flip to y-up millimetres.
  let cx = 0;
  let cy = 0;
  const finish = (): void => {
    const cleaned = cleanContour(current);
    if (cleaned) contours.push(cleaned);
    current = [];
  };
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        finish();
        cx = cmd.x;
        cy = -cmd.y;
        current.push([cx, cy]);
        break;
      case 'L':
        cx = cmd.x;
        cy = -cmd.y;
        current.push([cx, cy]);
        break;
      case 'Q':
        flattenQuadratic(
          current,
          [cx, cy],
          [cmd.x1!, -cmd.y1!],
          [cmd.x, -cmd.y],
          toleranceMm,
        );
        cx = cmd.x;
        cy = -cmd.y;
        break;
      case 'C':
        flattenCubic(
          current,
          [cx, cy],
          [cmd.x1!, -cmd.y1!],
          [cmd.x2!, -cmd.y2!],
          [cmd.x, -cmd.y],
          toleranceMm,
        );
        cx = cmd.x;
        cy = -cmd.y;
        break;
      case 'Z':
        finish();
        break;
      default:
        throw new Error(`Unsupported font path command: ${(cmd as { type: string }).type}`);
    }
  }
  finish();
  return contours;
}
