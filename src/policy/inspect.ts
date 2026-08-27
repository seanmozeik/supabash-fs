import { evaluateCommand } from './rules.js';
import {
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
  const decision = await evaluateCommand(command, options, depth);
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
