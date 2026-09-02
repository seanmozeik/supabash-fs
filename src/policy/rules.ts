import { ROOT_PATH } from '../core/path.js';
import { commandProgram } from './ast.js';
import { checkDestructive, checkSegmentPaths, nextWorkingDirectory } from './checks.js';
import {
  isAllowedCommand,
  isDangerousCommand,
  isHostEscapeCommand,
  isNetworkCommand,
  isWrapperCommand,
} from './commands.js';
import {
  dynamicWord,
  isFlag,
  pipelineDepth,
  segmentFromWords,
  type CommandSegment,
  type CommandWord,
} from './segments.js';
import {
  DEFAULT_MAX_COMMAND_LENGTH,
  DEFAULT_MAX_PIPELINE_DEPTH,
  DEFAULT_MAX_SEGMENTS,
  allowPolicy,
  denyPolicy,
  type CommandInspectDecision,
  type CommandPolicyOptions,
} from './types.js';

const WRAPPER_LIMIT = 4;

export const evaluateCommand = (
  command: string,
  options: CommandPolicyOptions,
  depth = 0,
  initialCwd = ROOT_PATH,
): Promise<CommandInspectDecision> => {
  if (command.length > (options.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH)) {
    return Promise.resolve(
      denyPolicy('command-too-long', 'Command exceeds the configured length limit.'),
    );
  }
  const program = commandProgram(command);
  if (!program.ok) {
    return Promise.resolve(program.decision);
  }
  const { segments } = program;
  if (segments.length > (options.maxSegments ?? DEFAULT_MAX_SEGMENTS)) {
    return Promise.resolve(
      denyPolicy('too-many-segments', 'Command has too many chained segments.'),
    );
  }
  if (pipelineDepth(segments) > (options.maxPipelineDepth ?? DEFAULT_MAX_PIPELINE_DEPTH)) {
    return Promise.resolve(
      denyPolicy('pipeline-too-deep', 'Pipeline exceeds the configured depth limit.'),
    );
  }
  return evaluateSegments(segments, options, depth, initialCwd);
};

export const evaluateSegments = async (
  segments: readonly CommandSegment[],
  options: CommandPolicyOptions,
  depth = 0,
  initialCwd = ROOT_PATH,
): Promise<CommandInspectDecision> => {
  if (depth > WRAPPER_LIMIT) {
    return denyPolicy('unsupported-syntax', 'Nested shell invocation is too deep to inspect.');
  }
  const extraAllow =
    options.extraAllowCommands === undefined
      ? new Set<string>()
      : new Set(options.extraAllowCommands);
  const extraDeny =
    options.extraDenyCommands === undefined
      ? new Set<string>()
      : new Set(options.extraDenyCommands);
  let cwd = initialCwd;
  for (const segment of segments) {
    const unwrapped = unwrapSegment(segment);
    if (!unwrapped.ok) {
      return unwrapped.decision;
    }
    const decision = await evaluateSegment(
      unwrapped.segment,
      cwd,
      options,
      extraAllow,
      extraDeny,
      depth,
    );
    if (!decision.allow) {
      return decision;
    }
    const working = nextWorkingDirectory(unwrapped.segment, cwd);
    if ('decision' in working) {
      return working.decision;
    }
    ({ cwd } = working);
  }
  return allowPolicy();
};

const evaluateSegment = async (
  segment: CommandSegment,
  cwd: string,
  options: CommandPolicyOptions,
  extraAllow: ReadonlySet<string>,
  extraDeny: ReadonlySet<string>,
  depth: number,
): Promise<CommandInspectDecision> => {
  const { head } = segment;
  if (head === '') {
    return denyPolicy('unsupported-syntax', 'Command segment is missing a command name.');
  }
  if (segment.words[0]?.kind !== 'dynamic') {
    if (extraDeny.has(head) || isDangerousCommand(head)) {
      return denyPolicy('dangerous-command', `Command '${head}' is blocked by policy.`);
    }
    if (isHostEscapeCommand(head)) {
      return denyPolicy('host-escape', `Command '${head}' could escape onto the host.`);
    }
    if (isNetworkCommand(head) && options.allowNetwork !== true) {
      return denyPolicy('network-disabled', `Network command '${head}' is disabled.`);
    }
    if (!isAllowedCommand(head, extraAllow)) {
      return denyPolicy('unsupported-command', `Command '${head}' is not in the allow list.`);
    }
    const nested = nestedShell(segment);
    if (nested?.kind === 'missing') {
      return denyPolicy('unsupported-syntax', 'bash -c is missing a script.');
    }
    if (nested?.kind === 'script') {
      const decision = await evaluateCommand(nested.script, options, depth + 1, cwd);
      if (!decision.allow) {
        return decision;
      }
    }
    const findExec = findExecSegments(segment);
    if (!findExec.ok) {
      return findExec.decision;
    }
    for (const command of findExec.segments) {
      const decision = await evaluateSegments([command], options, depth + 1, cwd);
      if (!decision.allow) {
        return decision;
      }
    }
  }
  const paths = await checkSegmentPaths(segment, cwd, options);
  if (!paths.allow) {
    return paths;
  }
  return checkDestructive(segment, cwd, options);
};

const findExecSegments = (
  segment: CommandSegment,
):
  | { readonly ok: true; readonly segments: readonly CommandSegment[] }
  | { readonly decision: CommandInspectDecision; readonly ok: false } => {
  if (segment.head !== 'find') {
    return { ok: true, segments: [] };
  }
  const commands: CommandSegment[] = [];
  const { words } = segment;
  for (let index = 1; index < words.length; index += 1) {
    const marker = words[index];
    if (marker?.kind === 'literal' && FIND_EXEC_MARKERS.has(marker.value)) {
      const command: CommandWord[] = [];
      index += 1;
      while (index < words.length) {
        const word = words[index];
        if (word?.kind === 'literal' && (word.value === ';' || word.value === '+')) {
          break;
        }
        if (word !== undefined) {
          command.push(
            word.kind === 'literal' && word.value === '{}'
              ? dynamicWord(word.value, 'placeholder')
              : word,
          );
        }
        index += 1;
      }
      if (command.length === 0 || index >= words.length) {
        return {
          decision: denyPolicy('unsupported-syntax', 'find -exec is missing a complete command.'),
          ok: false,
        };
      }
      commands.push(segmentFromWords(command));
    }
  }
  return { ok: true, segments: commands };
};

const FIND_EXEC_MARKERS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const unwrapSegment = (
  segment: CommandSegment,
): { ok: true; segment: CommandSegment } | { ok: false; decision: CommandInspectDecision } => {
  const words = [...segment.words];
  let guard = 0;
  while (
    words[0]?.kind === 'literal' &&
    isWrapperCommand(words[0].value) &&
    guard < WRAPPER_LIMIT
  ) {
    const wrapper = words.shift()?.value ?? '';
    skipWrapperWords(words, wrapper);
    guard += 1;
  }
  const [head] = words;
  if (head === undefined) {
    return {
      decision: denyPolicy('unsupported-syntax', 'Wrapper command is missing a target command.'),
      ok: false,
    };
  }
  if (head.kind === 'dynamic') {
    return { ok: true, segment: segmentFromWords(words, segment.redirects, segment.joiner) };
  }
  if (head.value === segment.head) {
    return { ok: true, segment };
  }
  return { ok: true, segment: segmentFromWords(words, segment.redirects, segment.joiner) };
};

const skipWrapperWords = (words: CommandWord[], wrapper: string): void => {
  while (words[0] !== undefined && isFlag(words[0].value)) {
    const flag = words.shift()?.value;
    if ((wrapper === 'timeout' && (flag === '-s' || flag === '--signal')) || flag === '--') {
      words.shift();
    }
  }
  if (wrapper === 'timeout' && words[0] !== undefined && /^\d/u.test(words[0].value)) {
    words.shift();
  }
  if (wrapper === 'env') {
    while (words[0]?.value.includes('=') === true) {
      words.shift();
    }
  }
};

const nestedShell = (
  segment: CommandSegment,
):
  | { readonly kind: 'dynamic' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'script'; readonly script: string }
  | undefined => {
  if (segment.head !== 'bash' && segment.head !== 'sh') {
    return undefined;
  }
  const scriptIndex = segment.words.findIndex((word) => word.value === '-c');
  if (scriptIndex === -1) {
    return undefined;
  }
  const script = segment.words[scriptIndex + 1];
  if (script === undefined) {
    return { kind: 'missing' };
  }
  return script.kind === 'dynamic' ? { kind: 'dynamic' } : { kind: 'script', script: script.value };
};
