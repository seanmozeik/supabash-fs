import { readdir, readFile } from 'node:fs/promises';

import { createTools } from '../dist/ai-sdk.js';
import { Supabash } from '../dist/index.js';

if (typeof createTools !== 'function') {
  throw new TypeError('The built AI SDK export does not provide createTools.');
}
if (!Object.hasOwn(Supabash, 'open')) {
  throw new TypeError('The root export is missing from the AI SDK smoke check.');
}

const source = await readFile(new URL('../dist/ai-sdk.js', import.meta.url), 'utf8');
const chunks = await readdir(new URL('../dist/ai-sdk-chunks/', import.meta.url));
if (source.includes('File is not a supported image type.') || chunks.length === 0) {
  throw new TypeError('Optional image support was folded into the main AI SDK bundle.');
}
