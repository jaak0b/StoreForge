import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'opentype.js';
import type { Font } from 'opentype.js';

let instance: Promise<Font> | null = null;

/** Load the bundled label font from disk once per test run. */
export function loadLabelFont(): Promise<Font> {
  if (!instance) {
    const path = fileURLToPath(
      new URL('../../src/assets/fonts/roboto-medium.ttf', import.meta.url),
    );
    instance = readFile(path).then((buffer) =>
      parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
    );
  }
  return instance;
}
