import type { CommandSegment } from './segments.js';
import { allowPolicy, denyPolicy, type CommandInspectDecision } from './types.js';

const COMPRESSION_COMMANDS: ReadonlySet<string> = new Set(['gzip', 'gunzip', 'zcat']);

/** Value options from just-bash 3.4.2's rg parser, before its short-flag scan. */
const RG_SHORT_VALUES: ReadonlySet<string> = new Set(['g', 't', 'T', 'm', 'e', 'f', 'r', 'd', 'j']);
const RG_LONG_VALUES: ReadonlySet<string> = new Set([
  '--glob',
  '--iglob',
  '--type',
  '--type-not',
  '--type-add',
  '--type-clear',
  '--max-count',
  '--regexp',
  '--file',
  '--replace',
  '--max-depth',
  '--max-filesize',
  '--context-separator',
  '--threads',
  '--ignore-file',
  '--pre-glob',
  '--sort',
]);

export const checkCompression = (segment: CommandSegment): CommandInspectDecision => {
  const name = segment.head.slice(segment.head.lastIndexOf('/') + 1);
  if (COMPRESSION_COMMANDS.has(name)) {
    return denyPolicy(
      'compression-unsupported',
      `Compression is not supported: ${name} is disabled.`,
    );
  }
  if (name !== 'rg') {
    return allowPolicy();
  }
  return checkRipgrepCompression(segment.words.slice(1));
};

const checkRipgrepCompression = (words: CommandSegment['words']): CommandInspectDecision => {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word?.kind === 'literal') {
      const { value } = word;
      const denied = checkRipgrepLongOption(value);
      if (denied !== undefined) {
        return denied;
      }
      if (RG_LONG_VALUES.has(value) || /^-[ABC]$/u.test(value)) {
        index += 1;
      } else if (isShortOptionCluster(value)) {
        const skippedWords = checkRipgrepShortOptions(value);
        if (skippedWords === undefined) {
          return zipDenied();
        }
        index += skippedWords;
      }
    }
  }
  return allowPolicy();
};

/** Returns the consumed word count, or undefined when compression is enabled. */
const checkRipgrepShortOptions = (value: string): number | undefined => {
  // Leading value options consume the rest of the same token (e.g. -ez is
  // the pattern "z"). In a cluster such as -nez, e consumes the NEXT word
  // and z still enables compression. This is how the upstream parser works.
  if (RG_SHORT_VALUES.has(value[1] ?? '')) {
    return value.length === 2 ? 1 : 0;
  }
  let skippedWords = 0;
  for (const flag of value.slice(1)) {
    if (flag === 'z') {
      return undefined;
    }
    if (RG_SHORT_VALUES.has(flag)) {
      skippedWords += 1;
    }
  }
  return skippedWords;
};

const isShortOptionCluster = (value: string): boolean =>
  value.startsWith('-') && !value.startsWith('--') && !/^-[ABC]\d+$/u.test(value);

const checkRipgrepLongOption = (value: string): CommandInspectDecision | undefined => {
  if (value === '--search-zip' || value.startsWith('--search-zip=')) {
    return zipDenied();
  }
  if (value === '--pre' || value.startsWith('--pre=')) {
    return denyPolicy(
      'compression-unsupported',
      'Compression is not supported: rg --pre is disabled because preprocessors can invoke compression outside policy inspection.',
    );
  }
  return undefined;
};

const zipDenied = (): CommandInspectDecision =>
  denyPolicy(
    'compression-unsupported',
    'Compression is not supported: rg -z / --search-zip is disabled.',
  );
