import { readFile } from 'node:fs/promises';

import { Supabash, SupabashError } from '../dist/index.js';

if (!Object.hasOwn(Supabash, 'open') || !Object.hasOwn(Supabash, 'openDelegated')) {
  throw new TypeError('The built package does not export Supabash.open and openDelegated.');
}

if (new SupabashError('STORAGE', 'Package smoke check').code !== 'STORAGE') {
  throw new TypeError('The built package does not export SupabashError.');
}

const source = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
if (
  source.includes('createTools') ||
  source.includes('@ai-sdk/openai') ||
  source.includes('bash-tool')
) {
  throw new TypeError('The root bundle loaded AI SDK dependencies.');
}
