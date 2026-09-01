import { parentVirtualPath } from '../core/path.js';
import {
  isRootTarget,
  resolveCommandPath,
  resolveCommandWord,
  type ResolvedPath,
} from './paths.js';
import { hasShortFlag, isFlag, type CommandSegment, type CommandWord } from './segments.js';
import {
  allowPolicy,
  denyPolicy,
  type CommandInspectDecision,
  type CommandPolicyFileSystem,
  type CommandPolicyOptions,
} from './types.js';

export const checkSegmentPaths = async (
  segment: CommandSegment,
  cwd: string,
  options: CommandPolicyOptions,
): Promise<CommandInspectDecision> => {
  for (const redirect of segment.redirects.filter((entry) => isPathRedirect(entry.op))) {
    const decision = await checkResolved(resolveCommandWord(redirect.target, cwd), cwd, options);
    if (!decision.allow) {
      return decision;
    }
  }
  for (const arg of pathArgs(segment)) {
    const decision = await checkResolved(resolveCommandWord(arg, cwd), cwd, options);
    if (!decision.allow) {
      return decision;
    }
  }
  return allowPolicy();
};

export const checkDestructive = (
  segment: CommandSegment,
  cwd: string,
  options: CommandPolicyOptions,
): CommandInspectDecision => {
  if (segment.head === 'find' && segment.tokens.includes('-exec')) {
    return denyPolicy('unsupported-syntax', 'find -exec cannot be inspected safely.');
  }
  if (
    segment.head === 'rm' &&
    pathArgs(segment).some((arg) => isRootTarget(resolveCommandWord(arg, cwd), cwd))
  ) {
    return denyPolicy('recursive-root', 'Deleting the mounted root is blocked.');
  }
  if (isRecursiveRoot(segment, cwd) && options.allowRecursiveRoot !== true) {
    return denyPolicy(
      'recursive-root',
      'Recursive operations against the mounted root are blocked.',
    );
  }
  if (segment.head === 'chmod' && hasShortFlag(segment, 'R') && segment.tokens.includes('777')) {
    return denyPolicy('dangerous-command', 'Recursive chmod 777 is blocked.');
  }
  if (isUnboundedRm(segment, cwd)) {
    return denyPolicy('unbounded-work', 'Unbounded deletion from the mounted root is blocked.');
  }
  return allowPolicy();
};
export const nextWorkingDirectory = (
  segment: CommandSegment,
  cwd: string,
): { readonly cwd: string } | { readonly decision: CommandInspectDecision } => {
  if (segment.head !== 'cd') {
    return { cwd };
  }
  const [target] = pathArgs(segment);
  if (target === undefined) {
    return { cwd };
  }
  const resolved = resolveCommandWord(target, cwd);
  if (resolved.kind === 'deny') {
    return { decision: resolved.decision };
  }
  if (resolved.kind === 'glob') {
    return { decision: denyPolicy('unbounded-work', 'cd cannot use an unbounded glob.') };
  }
  return { cwd: resolved.value };
};

const checkResolved = (
  resolved: ResolvedPath,
  cwd: string,
  options: CommandPolicyOptions,
): Promise<CommandInspectDecision> => {
  if (resolved.kind === 'deny') {
    return Promise.resolve(resolved.decision);
  }
  if (resolved.kind === 'glob' && isRootTarget(resolved, cwd)) {
    return Promise.resolve(
      denyPolicy('unbounded-work', 'Unbounded glob against the mounted root is blocked.'),
    );
  }
  if (resolved.kind === 'path') {
    return checkSymlink(resolved.value, options.fs);
  }
  return Promise.resolve(allowPolicy());
};

const checkSymlink = async (
  path: string,
  fs: CommandPolicyFileSystem | undefined,
): Promise<CommandInspectDecision> => {
  if (fs === undefined) {
    return allowPolicy();
  }
  try {
    const stat = await fs.lstat(path);
    if (!stat.isSymbolicLink) {
      return allowPolicy();
    }
    const target = await fs.readlink(path);
    const resolved = resolveCommandPath(target, parentVirtualPath(path));
    if (resolved.kind === 'deny') {
      return resolved.decision;
    }
    if (resolved.kind === 'glob') {
      return denyPolicy('unbounded-work', 'Symbolic link target is an unbounded glob.');
    }
    return allowPolicy();
  } catch {
    return allowPolicy();
  }
};

const isRecursiveRoot = (segment: CommandSegment, cwd: string): boolean => {
  if (segment.head === 'find' && segment.tokens.includes('-delete')) {
    return findRoots(segment, cwd).some((resolved) => isRootTarget(resolved, cwd));
  }
  if (!hasRecursiveFlag(segment)) {
    return false;
  }
  return pathArgs(segment).some((arg) => isRootTarget(resolveCommandWord(arg, cwd), cwd));
};

const isUnboundedRm = (segment: CommandSegment, cwd: string): boolean => {
  if (segment.head !== 'rm') {
    return false;
  }
  return pathArgs(segment).some((arg) => {
    const resolved = resolveCommandWord(arg, cwd);
    return resolved.kind === 'glob' && isRootTarget(resolved, cwd);
  });
};

const hasRecursiveFlag = (segment: CommandSegment): boolean => {
  if (segment.head === 'find') {
    return segment.tokens.includes('-delete');
  }
  return (
    hasShortFlag(segment, 'r') ||
    hasShortFlag(segment, 'R') ||
    segment.flags.includes('--recursive')
  );
};

const findRoots = (segment: CommandSegment, cwd: string): readonly ResolvedPath[] => {
  const roots: CommandWord[] = [];
  for (const word of segment.words.slice(1)) {
    if (word.value.startsWith('-')) {
      break;
    }
    roots.push(word);
  }
  const checked = roots.length === 0 ? [{ kind: 'literal' as const, value: '.' }] : roots;
  return checked.map((root) => resolveCommandWord(root, cwd));
};

const pathArgs = (segment: CommandSegment): readonly CommandWord[] => {
  if (NON_PATH_HEADS.has(segment.head)) {
    return [];
  }
  const words = positionalWords(segment);
  if (segment.head === 'chmod') {
    return words.filter((word) => !isMode(word.value));
  }
  if (segment.head === 'ln') {
    return words;
  }
  if (segment.head === 'bash' || segment.head === 'sh') {
    return words.filter((word) => word.value !== '-c' && !isFlag(word.value));
  }
  return words;
};

const positionalWords = (segment: CommandSegment): readonly CommandWord[] => {
  const words: CommandWord[] = [];
  let endOfFlags = false;
  for (const word of segment.words.slice(1)) {
    if (!endOfFlags && word.value === '--') {
      endOfFlags = true;
    } else if (endOfFlags || !isFlag(word.value)) {
      words.push(word);
    }
  }
  return words;
};

const isPathRedirect = (operator: string): boolean =>
  operator === '>' ||
  operator === '>>' ||
  operator === '<' ||
  operator === '<>' ||
  operator === '>|' ||
  operator === '&>' ||
  operator === '&>>';

const isMode = (value: string): boolean =>
  /^[0-7]{3,4}$/u.test(value) || /[ugoa]*[+-=]/u.test(value);

const NON_PATH_HEADS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'true',
  'false',
  'expr',
  'seq',
  'sleep',
  'test',
  '[',
  'export',
  'unset',
  'set',
  'shift',
  'return',
  'let',
  'umask',
  'pwd',
  'whoami',
  'hostname',
  'date',
  'clear',
  'help',
  'history',
  'which',
  'type',
]);
