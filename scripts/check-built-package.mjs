import { Supabash, SupabashError } from '../dist/index.js';

if (!Object.hasOwn(Supabash, 'open')) {
  throw new TypeError('The built package does not export Supabash.open.');
}

const error = new SupabashError('STORAGE', 'Package smoke check.');
if (error.name !== 'SupabashError' || error.code !== 'STORAGE') {
  throw new TypeError('The built package does not export SupabashError.');
}
