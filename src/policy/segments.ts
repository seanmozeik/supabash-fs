export type SegmentJoiner = '&&' | '||' | '|' | '|&' | ';' | '&';

export type CommandWordKind = 'dynamic' | 'literal';

export interface CommandWord {
  readonly kind: CommandWordKind;
  readonly value: string;
}

export interface CommandRedirect {
  readonly op: string;
  readonly target: CommandWord;
}

export interface CommandSegment {
  readonly args: readonly string[];
  readonly flags: readonly string[];
  readonly head: string;
  readonly joiner?: SegmentJoiner;
  readonly redirects: readonly CommandRedirect[];
  readonly tokens: readonly string[];
  readonly words: readonly CommandWord[];
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

export const literalWord = (value: string): CommandWord => ({ kind: 'literal', value });

export const dynamicWord = (value: string): CommandWord => ({ kind: 'dynamic', value });

export const segmentFromWords = (
  words: readonly CommandWord[],
  redirects: readonly CommandRedirect[] = [],
  joiner?: SegmentJoiner,
): CommandSegment => {
  const tokens = words.map((word) => word.value);
  const flags = words
    .filter((word, index) => index > 0 && isFlag(word.value))
    .map(({ value }) => value);
  const args = positionalArgs(words);
  const segment: CommandSegment = {
    args,
    flags,
    head: words[0]?.value ?? '',
    redirects,
    tokens,
    words,
  };
  return joiner === undefined ? segment : { ...segment, joiner };
};

const positionalArgs = (words: readonly CommandWord[]): readonly string[] => {
  const args: string[] = [];
  let endOfFlags = false;
  for (const word of words.slice(1)) {
    if (!endOfFlags && word.value === '--') {
      endOfFlags = true;
    } else if (endOfFlags || !isFlag(word.value)) {
      args.push(word.value);
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
