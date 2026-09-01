export type SegmentJoiner = '&&' | '||' | '|' | '|&' | ';' | '&';

export interface CommandRedirect {
  readonly op: string;
  readonly target: string;
}

export interface CommandSegment {
  readonly args: readonly string[];
  readonly flags: readonly string[];
  readonly head: string;
  readonly joiner?: SegmentJoiner;
  readonly redirects: readonly CommandRedirect[];
  readonly tokens: readonly string[];
}

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
  joiner?: SegmentJoiner,
): CommandSegment => {
  const flags = words.filter((word, index) => index > 0 && isFlag(word));
  const args = positionalArgs(words);
  const segment: CommandSegment = { args, flags, head: words[0] ?? '', redirects, tokens: words };
  return joiner === undefined ? segment : { ...segment, joiner };
};

export const segmentFromWords = (
  words: readonly string[],
  redirects: readonly CommandRedirect[] = [],
  joiner?: SegmentJoiner,
): CommandSegment => toSegment(words, redirects, joiner);

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
