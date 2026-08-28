import { normalizeVirtualPath } from './path.js';

export const RUNTIME_OWNED_ROOTS = Object.freeze([
  '/bin',
  '/dev',
  '/proc',
  '/tmp',
  '/usr',
] as const);

export const isRuntimeOwnedPath = (path: string): boolean => {
  const normalized = normalizeVirtualPath(path);
  return RUNTIME_OWNED_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
};
