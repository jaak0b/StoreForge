// Regenerates web/public/og-image.png, the 1200x630 social preview card.
// Run from web/ with: node scripts/renderOgImage.mjs
// The card is composed as one SVG and rasterized with sharp. og-image.png is a
// generated artifact: edit this script, not the PNG.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'public', 'og-image.png');

const BG = '#161616';
const PRIMARY = '#b8752a';
const GRAY = '#8a8a8a';
const WHITE = '#f0f0f0';
const LIST_GRAY = '#9a9a9a';

// Every element stays this far clear of the card edges.
const MARGIN = 60;

// The logo mark sits top-left as a header, scaled to 96 px. Same geometry as
// web/public/favicon.svg (viewBox 0 0 100 100).
const markSize = 96;
const markX = MARGIN;
const markY = MARGIN;
const s = markSize / 100;

const cell = (cx, cy, fill) =>
  fill === 'orange'
    ? `<rect x="${markX + 53 * s}" y="${markY + cy * s}" width="${41 * s}" height="${41 * s}" rx="${10 * s}" fill="${PRIMARY}" />`
    : `<rect x="${markX + cx * s}" y="${markY + cy * s}" width="${41 * s}" height="${41 * s}" rx="${10 * s}" fill="none" stroke="${GRAY}" stroke-width="${7 * s}" />`;

// Wordmark baseline, vertically centered against the mark.
const wordmarkX = markX + markSize + 28;
const wordmarkBaseline = markY + markSize * 0.72;

const FONT = 'Arial, Helvetica, sans-serif';
const textX = MARGIN;

// Catchphrase, the visual focus. Two white headline lines then the trailing
// list in gray. "StoreForge" is picked out in the primary orange.
const HEAD = 52;
const LIST = 40;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}" />
  ${cell(6, 6)}
  ${cell(53, 6)}
  ${cell(6, 53)}
  ${cell(53, 53, 'orange')}
  <text x="${wordmarkX}" y="${wordmarkBaseline}" font-family="${FONT}" font-size="46" font-weight="700" fill="${WHITE}">StoreForge</text>

  <text x="${textX}" y="300" font-family="${FONT}" font-size="${HEAD}" font-weight="700" fill="${WHITE}">Any generator makes a bin.</text>
  <text x="${textX}" y="372" font-family="${FONT}" font-size="${HEAD}" font-weight="700" fill="${WHITE}"><tspan fill="${PRIMARY}">StoreForge</tspan> makes your Gridfinity setup:</text>
  <text x="${textX}" y="452" font-family="${FONT}" font-size="${LIST}" font-weight="400" fill="${LIST_GRAY}">screw-fitted, tool-traced, labeled</text>
  <text x="${textX}" y="504" font-family="${FONT}" font-size="${LIST}" font-weight="400" fill="${LIST_GRAY}">and ready to print.</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
