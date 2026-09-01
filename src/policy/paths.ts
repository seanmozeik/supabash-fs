import { ROOT_PATH, VirtualPathError, normalizeVirtualPath } from '../core/path.js';
import type { CommandWord } from './segments.js';
import { denyPolicy, type CommandInspectDecision, type PolicyReasonCode } from './types.js';

export type ResolvedPath =
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'glob'; readonly value: string }
  | { readonly kind: 'deny'; readonly decision: CommandInspectDecision };

const HOME_PATH_PATTERN = /^(?:~|\$home|\$\{home\})(?:\/|$)/iu;

export const resolveCommandWord = (word: CommandWord, cwd: string): ResolvedPath => {
  if (word.kind === 'dynamic') {
    return deny('unsupported-syntax', 'Variable path expansion cannot be inspected safely.');
  }
  return resolveCommandPath(word.value, cwd);
};

export const resolveCommandPath = (input: string, cwd: string): ResolvedPath => {
  if (HOME_PATH_PATTERN.test(input)) {
    return deny('path-out-of-root', 'Home-directory paths are outside the mounted root.');
  }
  if (input.includes('$') || input.includes('`')) {
    return deny('unsupported-syntax', 'Variable path expansion cannot be inspected safely.');
  }
  const joined = input.startsWith('/') ? input : joinRelative(cwd, input);
  if (isUnboundedGlob(input) || isUnboundedGlob(joined)) {
    return { kind: 'glob', value: joined };
  }
  try {
    return { kind: 'path', value: normalizeVirtualPath(joined) };
  } catch (error) {
    return pathError(error);
  }
};

export const isRootTarget = (resolved: ResolvedPath, cwd: string): boolean => {
  if (resolved.kind === 'glob') {
    return cwd === ROOT_PATH || resolved.value === '*' || resolved.value === '/*';
  }
  return resolved.kind === 'path' && resolved.value === ROOT_PATH;
};

const joinRelative = (cwd: string, input: string): string => {
  if (cwd === ROOT_PATH) {
    return `/${input}`;
  }
  return `${cwd}/${input}`;
};

const isUnboundedGlob = (value: string): boolean =>
  value === '*' || value === '/*' || value === './*' || value === './**' || value === '**';

const pathError = (error: unknown): ResolvedPath => {
  if (error instanceof VirtualPathError) {
    if (error.issue === 'reserved') {
      return deny('reserved-path', 'Command addresses a reserved internal path.');
    }
    if (error.issue === 'out-of-root') {
      return deny('path-out-of-root', 'Command addresses a path outside the mounted root.');
    }
    return deny('ambiguous-path', 'Command contains an ambiguous or encoded path.');
  }
  throw error;
};

const deny = (code: PolicyReasonCode, reason: string): ResolvedPath => ({
  decision: denyPolicy(code, reason),
  kind: 'deny',
});
