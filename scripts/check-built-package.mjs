import { readFile } from 'node:fs/promises';

import {
  isRetryableSupabashError,
  isUnknownOutcomeSupabashError,
  Supabash,
  SupabashError,
} from '../dist/index.js';

if (
  !Object.hasOwn(Supabash, 'open') ||
  !Object.hasOwn(Supabash, 'openDelegated') ||
  !Object.hasOwn(Supabash, 'openPostgres')
) {
  throw new TypeError('The built package does not export every workspace open method.');
}

if (new SupabashError('STORAGE', 'Package smoke check').code !== 'STORAGE') {
  throw new TypeError('The built package does not export SupabashError.');
}
const retryable = new SupabashError('STORAGE', 'Package smoke check', {
  outcomeUnknown: true,
  retryable: true,
});
if (!isRetryableSupabashError(retryable) || !isUnknownOutcomeSupabashError(retryable)) {
  throw new TypeError('The built package does not export its error classifiers.');
}

const source = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
if (
  source.includes('createTools') ||
  source.includes('@ai-sdk/openai') ||
  source.includes('bash-tool')
) {
  throw new TypeError('The root bundle loaded AI SDK dependencies.');
}
