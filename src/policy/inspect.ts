import { evaluateSegments } from './rules.js';
import { pipelineDepth, segmentsFromTokens } from './segments.js';
import { tokenizeCommand } from './tokenize.js';
import {
  DEFAULT_MAX_COMMAND_LENGTH,
  DEFAULT_MAX_PIPELINE_DEPTH,
  DEFAULT_MAX_SEGMENTS,
  allowPolicy,
  denyPolicy,
  type CommandInspectDecision,
  type CommandInspector,
  type CommandPolicyOptions,
} from './types.js';

/**
 * Inspect a command string before Just Bash executes it.
 *
 * Inspired by Tripwire's segment-then-rule design. This is new code, not a
 * copy of Tripwire, and it is a damage limiter rather than an auth boundary.
 */
export const inspectCommand = async (
  command: string,
  options: CommandPolicyOptions = {},
  depth = 0,
): Promise<CommandInspectDecision> => {
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/u.test(command)) {
    return denyPolicy('dangerous-command', 'Fork-bomb pattern is blocked.');
  }
  const maxCommandLength = options.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH;
  if (command.length > maxCommandLength) {
    return denyPolicy('command-too-long', 'Command exceeds the configured length limit.');
  }
  const tokens = tokenizeCommand(command);
  if (!tokens.ok) {
    return tokens.decision;
  }
  const segments = segmentsFromTokens(tokens.tokens);
  if (segments.length > (options.maxSegments ?? DEFAULT_MAX_SEGMENTS)) {
    return denyPolicy('too-many-segments', 'Command has too many chained segments.');
  }
  if (pipelineDepth(segments) > (options.maxPipelineDepth ?? DEFAULT_MAX_PIPELINE_DEPTH)) {
    return denyPolicy('pipeline-too-deep', 'Pipeline exceeds the configured depth limit.');
  }
  const decision = await evaluateSegments(segments, options, depth);
  if (!decision.allow) {
    return decision;
  }
  return runExtraInspectors(command, options);
};

export const createCommandPolicy = (options: CommandPolicyOptions = {}): CommandInspector => ({
  inspect: (command) => inspectCommand(command, options),
});

const runExtraInspectors = async (
  command: string,
  options: CommandPolicyOptions,
): Promise<CommandInspectDecision> => {
  for (const inspector of options.inspectors ?? []) {
    const decision = await inspector.inspect(command);
    if (!decision.allow) {
      return decision;
    }
  }
  return allowPolicy();
};
