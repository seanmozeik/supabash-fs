import type { SegmentOp, Token } from './tokenize.js';

export interface CommandRedirect {
  readonly op: string;
  readonly target: string;
}

export interface CommandSegment {
  readonly args: readonly string[];
  readonly flags: readonly string[];
  readonly head: string;
  readonly joiner?: SegmentOp;
  readonly redirects: readonly CommandRedirect[];
  readonly tokens: readonly string[];
}

export const segmentsFromTokens = (tokens: readonly Token[]): readonly CommandSegment[] => {
  const segments: CommandSegment[] = [];
  let words: string[] = [];
  let redirects: CommandRedirect[] = [];
  for (const token of tokens) {
    if (token.kind === 'op') {
      if (words.length > 0 || redirects.length > 0) {
        segments.push(toSegment(words, redirects, token.value));
        words = [];
        redirects = [];
      }
    } else if (token.kind === 'redirect') {
      redirects.push({ op: token.op, target: token.target });
    } else if (!isGroupingToken(token.value)) {
      words.push(token.value);
    }
  }
  if (words.length > 0 || redirects.length > 0) {
    segments.push(toSegment(words, redirects));
  }
  return segments;
};

const isGroupingToken = (value: string): boolean =>
  value === '{' || value === '}' || value === '(' || value === ')' || value === '!';

export const pipelineDepth = (segments: readonly CommandSegment[]): number => {
  let current = 1;
  let deepest = 1;
  for (const segment of segments) {
    if (segment.joiner === '|' || segment.joiner === '|&') {
      current += 1;
      deepest = Math.max(deepest, current);
    } else {
      current = 1;
    }
  }
  return deepest;
};

const toSegment = (
  words: readonly string[],
  redirects: readonly CommandRedirect[],
  joiner?: SegmentOp,
): CommandSegment => {
  const flags = words.filter((word, index) => index > 0 && isFlag(word));
  const args = positionalArgs(words);
  const segment: CommandSegment = { args, flags, head: words[0] ?? '', redirects, tokens: words };
  return joiner === undefined ? segment : { ...segment, joiner };
};

const positionalArgs = (words: readonly string[]): readonly string[] => {
  const args: string[] = [];
  let endOfFlags = false;
  for (const word of words.slice(1)) {
    if (!endOfFlags && word === '--') {
      endOfFlags = true;
    } else if (endOfFlags || !isFlag(word)) {
      args.push(word);
    }
  }
  return args;
};

export const isFlag = (word: string): boolean => word.startsWith('-') && word !== '-';

export const hasShortFlag = (segment: CommandSegment, flag: string): boolean =>
  segment.flags.some((value) => {
    if (value === `-${flag}` || value === `--${flag}`) {
      return true;
    }
    return value.startsWith('-') && !value.startsWith('--') && value.includes(flag);
  });
