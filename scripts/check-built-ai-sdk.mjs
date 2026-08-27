import { createTools } from '../dist/ai-sdk.js';
import { Supabash } from '../dist/index.js';

if (typeof createTools !== 'function') {
  throw new TypeError('The built AI SDK export does not provide createTools.');
}
if (!Object.hasOwn(Supabash, 'open')) {
  throw new TypeError('The root export is missing from the AI SDK smoke check.');
}
