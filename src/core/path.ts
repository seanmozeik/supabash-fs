import { SupabashError } from '../api/errors.js';

const ENCODED_PATH_SYNTAX = /%(?:2e|2f|5c)/iu;
const RESERVED_SEGMENTS = new Set(['.supabash', '.supabash-directory']);

export const ROOT_PATH = '/';

export const normalizeVirtualPath = (input: string): string => {
  if (input.length === 0) {
    throw invalidPath(input, 'Path must not be empty.');
  }
  if (hasControlCharacter(input)) {
    throw invalidPath(input, 'Path must not contain control characters.');
  }
  if (input.includes('\\') || ENCODED_PATH_SYNTAX.test(input)) {
    throw invalidPath(input, 'Path contains ambiguous separator or traversal syntax.');
  }

  const segments: string[] = [];
  for (const segment of absoluteSegments(input)) {
    if (segment !== '' && segment !== '.') {
      if (segment === '..') {
        if (segments.length === 0) {
          throw invalidPath(input, 'Path attempts to leave the mounted root.');
        }
        segments.pop();
      } else {
        if (RESERVED_SEGMENTS.has(segment)) {
          throw invalidPath(input, `Path segment '${segment}' is reserved.`);
        }
        segments.push(segment);
      }
    }
  }

  return segments.length === 0 ? ROOT_PATH : `/${segments.join('/')}`;
};

export const relativeObjectPath = (path: string): string => {
  const normalized = normalizeVirtualPath(path);
  if (normalized === ROOT_PATH) {
    throw invalidPath(path, 'The mounted root is not an object path.');
  }
  return normalized.slice(1);
};

export const joinVirtualPath = (base: string, child: string): string =>
  normalizeVirtualPath(`${normalizeVirtualPath(base)}/${child}`);

export const isSameOrDescendant = (candidate: string, parent: string): boolean => {
  const normalizedCandidate = normalizeVirtualPath(candidate);
  const normalizedParent = normalizeVirtualPath(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent === ROOT_PATH ? '' : normalizedParent}/`)
  );
};

export const moveDescendant = (path: string, source: string, destination: string): string => {
  const normalizedPath = normalizeVirtualPath(path);
  const normalizedSource = normalizeVirtualPath(source);
  const normalizedDestination = normalizeVirtualPath(destination);
  if (!isSameOrDescendant(normalizedPath, normalizedSource)) {
    throw invalidPath(path, `Path is not inside '${source}'.`);
  }
  return normalizeVirtualPath(
    `${normalizedDestination}${normalizedPath.slice(normalizedSource.length)}`,
  );
};

export const parentPaths = (path: string): readonly string[] => {
  const normalized = normalizeVirtualPath(path);
  const segments = normalized.slice(1).split('/').filter(Boolean);
  return segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join('/')}`);
};

export const parentVirtualPath = (path: string): string => {
  const normalized = normalizeVirtualPath(path);
  if (normalized === ROOT_PATH) {
    return ROOT_PATH;
  }
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? ROOT_PATH : normalized.slice(0, index);
};

const absoluteSegments = (input: string): string[] =>
  (input.startsWith(ROOT_PATH) ? input : `/${input}`).split('/');

const hasControlCharacter = (input: string): boolean =>
  Array.from(input).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

const invalidPath = (path: string, message: string): SupabashError =>
  new SupabashError('INVALID_PATH', message, { path });
