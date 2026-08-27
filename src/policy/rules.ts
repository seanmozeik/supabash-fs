import { ROOT_PATH } from '../core/path.js';
import { checkDestructive, checkSegmentPaths, nextWorkingDirectory } from './checks.js';
import {
  isAllowedCommand,
  isDangerousCommand,
  isHostEscapeCommand,
  isNetworkCommand,
  isWrapperCommand,
} from './commands.js';
import { pipelineDepth, segmentsFromTokens, isFlag, type CommandSegment } from './segments.js';
import { tokenizeCommand } from './tokenize.js';
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

export const evaluateSegments = async (
  segments: readonly CommandSegment[],
  options: CommandPolicyOptions,
  depth = 0,
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
  let cwd = ROOT_PATH;
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
  if (nested !== undefined && 'missing' in nested) {
    return denyPolicy('unsupported-syntax', 'bash -c is missing a script.');
  }
  if (nested !== undefined && 'script' in nested) {
    return inspectNested(nested.script, options, depth + 1);
  }
  const paths = await checkSegmentPaths(segment, cwd, options);
  if (!paths.allow) {
    return paths;
  }
  return checkDestructive(segment, cwd, options);
};

const inspectNested = (
  command: string,
  options: CommandPolicyOptions,
  depth: number,
): Promise<CommandInspectDecision> => {
  if (command.length > (options.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH)) {
    return Promise.resolve(
      denyPolicy('command-too-long', 'Command exceeds the configured length limit.'),
    );
  }
  const tokens = tokenizeCommand(command);
  if (!tokens.ok) {
    return Promise.resolve(tokens.decision);
  }
  const segments = segmentsFromTokens(tokens.tokens);
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
  return evaluateSegments(segments, options, depth);
};

const unwrapSegment = (
  segment: CommandSegment,
): { ok: true; segment: CommandSegment } | { ok: false; decision: CommandInspectDecision } => {
  const tokens = [...segment.tokens];
  let guard = 0;
  while (tokens[0] !== undefined && isWrapperCommand(tokens[0]) && guard < WRAPPER_LIMIT) {
    const wrapper = tokens.shift();
    skipWrapperArgs(tokens, wrapper ?? '');
    guard += 1;
  }
  if (tokens[0] === undefined) {
    return {
      decision: denyPolicy('unsupported-syntax', 'Wrapper command is missing a target command.'),
      ok: false,
    };
  }
  if (tokens[0] === segment.head) {
    return { ok: true, segment };
  }
  return {
    ok: true,
    segment: {
      ...segment,
      args: tokens.slice(1).filter((token) => !isFlag(token) && token !== '--'),
      flags: tokens.filter((token, index) => index > 0 && isFlag(token)),
      head: tokens[0],
      tokens,
    },
  };
};

const skipWrapperArgs = (tokens: string[], wrapper: string): void => {
  while (tokens[0] !== undefined && isFlag(tokens[0])) {
    const flag = tokens.shift();
    if ((wrapper === 'timeout' && (flag === '-s' || flag === '--signal')) || flag === '--') {
      tokens.shift();
    }
  }
  if (wrapper === 'timeout' && tokens[0] !== undefined && /^\d/u.test(tokens[0])) {
    tokens.shift();
  }
  if (wrapper === 'env') {
    while (tokens[0]?.includes('=') === true) {
      tokens.shift();
    }
  }
};

const nestedShell = (
  segment: CommandSegment,
): { readonly missing: true } | { readonly script: string } | undefined => {
  if (segment.head !== 'bash' && segment.head !== 'sh') {
    return undefined;
  }
  for (const [index, token] of segment.tokens.entries()) {
    if (index > 0) {
      const isCommandFlag =
        token === '-c' || (token.startsWith('-') && !token.startsWith('--') && token.includes('c'));
      if (isCommandFlag) {
        const script = segment.tokens[index + 1];
        return script === undefined ? { missing: true } : { script };
      }
    }
  }
  return undefined;
};
