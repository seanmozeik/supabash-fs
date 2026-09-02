import { isFlag, type CommandSegment, type CommandWord } from './segments.js';

export const pathArgs = (segment: CommandSegment): readonly CommandWord[] => {
  if (NON_PATH_HEADS.has(segment.head)) {
    return [];
  }
  if (segment.head === 'find') {
    return findRootWords(segment);
  }
  if (SEARCH_COMMANDS.has(segment.head)) {
    return searchPaths(segment);
  }
  if (segment.head === 'sed') {
    return sedPaths(segment);
  }
  if (segment.head === 'awk') {
    return awkPaths(segment);
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

const findRootWords = (segment: CommandSegment): readonly CommandWord[] => {
  const roots: CommandWord[] = [];
  for (const word of segment.words.slice(1)) {
    if (word.value.startsWith('-') || word.value === '!' || word.value === '(') {
      break;
    }
    roots.push(word);
  }
  return roots.length === 0 ? [{ kind: 'literal', value: '.' }] : roots;
};

const searchPaths = (segment: CommandSegment): readonly CommandWord[] => {
  const { operands, patternFiles, patternSpecified } = commandOperands(segment, {
    pathValueFlags: new Set(['-f', '--file']),
    valueFlags: SEARCH_VALUE_FLAGS,
  });
  return [...patternFiles, ...(patternSpecified ? operands : operands.slice(1))];
};

const sedPaths = (segment: CommandSegment): readonly CommandWord[] => {
  const { operands, patternFiles, patternSpecified } = commandOperands(segment, {
    pathValueFlags: new Set(['-f', '--file']),
    valueFlags: SED_VALUE_FLAGS,
  });
  return [...patternFiles, ...(patternSpecified ? operands : operands.slice(1))];
};

const awkPaths = (segment: CommandSegment): readonly CommandWord[] => {
  const { operands, patternFiles, patternSpecified } = commandOperands(segment, {
    pathValueFlags: new Set(['-f', '--file']),
    valueFlags: AWK_VALUE_FLAGS,
  });
  const files = patternSpecified ? operands : operands.slice(1);
  return [...patternFiles, ...files.filter((word) => !word.value.includes('='))];
};

interface OperandRules {
  readonly pathValueFlags: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
}

interface CommandOperands {
  readonly operands: readonly CommandWord[];
  readonly patternFiles: readonly CommandWord[];
  readonly patternSpecified: boolean;
}

const commandOperands = (segment: CommandSegment, rules: OperandRules): CommandOperands => {
  const operands: CommandWord[] = [];
  const patternFiles: CommandWord[] = [];
  let patternSpecified = false;
  let endOfFlags = false;
  const words = segment.words.slice(1);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word !== undefined && !endOfFlags && word.value === '--') {
      endOfFlags = true;
    } else if (word !== undefined) {
      const option = !endOfFlags && word.kind === 'literal' ? parseOption(word.value) : undefined;
      if (option === undefined) {
        operands.push(word);
      } else if (rules.valueFlags.has(option.name)) {
        patternSpecified ||=
          option.name === '-e' ||
          option.name === '--regexp' ||
          rules.pathValueFlags.has(option.name);
        const value = optionValue(option, words[index + 1]);
        if (rules.pathValueFlags.has(option.name) && value !== undefined) {
          patternFiles.push(value);
        }
        if (option.inlineValue === undefined && words[index + 1] !== undefined) {
          index += 1;
        }
      }
    }
  }
  return { operands, patternFiles, patternSpecified };
};

interface ParsedOption {
  readonly inlineValue?: string;
  readonly name: string;
}

const optionValue = (
  option: ParsedOption,
  next: CommandWord | undefined,
): CommandWord | undefined =>
  option.inlineValue === undefined ? next : { kind: 'literal', value: option.inlineValue };

const parseOption = (value: string): ParsedOption | undefined => {
  if (!isFlag(value)) {
    return undefined;
  }
  const equals = value.indexOf('=');
  if (equals !== -1) {
    return { inlineValue: value.slice(equals + 1), name: value.slice(0, equals) };
  }
  if (/^-[efmABC]\S+/u.test(value)) {
    const inlineValue = value.slice(2);
    return {
      inlineValue: inlineValue.startsWith('=') ? inlineValue.slice(1) : inlineValue,
      name: value.slice(0, 2),
    };
  }
  return { name: value };
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

const SEARCH_COMMANDS: ReadonlySet<string> = new Set(['egrep', 'fgrep', 'grep', 'rg']);
const SEARCH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-A',
  '-B',
  '-C',
  '-e',
  '-f',
  '-m',
  '--after-context',
  '--before-context',
  '--binary-files',
  '--context',
  '--directories',
  '--devices',
  '--exclude',
  '--exclude-dir',
  '--exclude-from',
  '--include',
  '--label',
  '--max-count',
  '--regexp',
]);
const SED_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '-f',
  '-l',
  '--expression',
  '--file',
  '--line-length',
]);
const AWK_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-F',
  '-f',
  '-v',
  '--assign',
  '--field-separator',
  '--file',
]);
