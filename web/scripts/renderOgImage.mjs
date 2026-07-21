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
const TAGLINE_GRAY = '#9a9a9a';

// The logo mark, scaled to 300 px and placed left of the wordmark. Same
// geometry as web/public/favicon.svg (viewBox 0 0 100 100).
const markSize = 300;
const markX = 150;
const markY = (630 - markSize) / 2;
const s = markSize / 100;

const cell = (cx, cy, fill) =>
  fill === 'orange'
    ? `<rect x="${markX + 53 * s}" y="${markY + cy * s}" width="${41 * s}" height="${41 * s}" rx="${10 * s}" fill="${PRIMARY}" />`
    : `<rect x="${markX + cx * s}" y="${markY + cy * s}" width="${41 * s}" height="${41 * s}" rx="${10 * s}" fill="none" stroke="${GRAY}" stroke-width="${7 * s}" />`;

const textX = markX + markSize + 70;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}" />
  ${cell(6, 6)}
  ${cell(53, 6)}
  ${cell(6, 53)}
  ${cell(53, 53, 'orange')}
  <text x="${textX}" y="300" font-family="Arial, Helvetica, sans-serif" font-size="110" font-weight="700" fill="${WHITE}">StoreForge</text>
  <text x="${textX}" y="370" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="400" fill="${TAGLINE_GRAY}">Plan, preview and print Gridfinity storage bins.</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
