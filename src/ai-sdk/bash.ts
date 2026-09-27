import { tool, type Tool } from 'ai';
import { Bash } from 'just-bash/browser';

import type { Workspace } from '../api/contracts.js';
import { isSupabashError } from '../api/errors.js';
import { createCommandPolicy } from '../policy/inspect.js';
import { DEFAULT_MAX_COMMAND_LENGTH, type CommandInspectDecision } from '../policy/types.js';
import {
  bashInputSchema,
  describeBashTool,
  runBashCommand,
  truncateStream,
  type BashOutput,
} from './bash-surface.js';
import { DEFAULT_MAX_BASH_OUTPUT, assertPositiveLimit, boundText } from './bounds.js';
import type { BashToolOptions } from './options.js';
import { safeToolText } from './redact.js';

const SCOPED_ROOT_INSTRUCTIONS =
  'The filesystem exposes only the sources configured by the host. Use the exact visible paths; read-only mounts reject writes. Supported shell syntax includes pipelines, redirection, command and process substitution, loops, conditionals, functions, grouped commands, command chains, and find -exec. Do not select a bucket, user, prefix, access token, or storage client. Do not commit, discard, inspect history, checkpoint, diff, or restore.';
export const DEFAULT_MAX_BASH_EXECUTION_TIME_MS = 30_000;

/**
 * The policy inspects each command before it runs; a denial is a normal tool
 * result with exit code 126, so the model can correct the command.
 */
export const createWorkspaceBashTool = async (
  workspace: Pick<Workspace, 'fs'>,
  options: BashToolOptions = {},
): Promise<Tool> => {
  const maxCommandLength =
    options.policyOptions?.maxCommandLength ??
    options.limits?.maxCommandLength ??
    DEFAULT_MAX_COMMAND_LENGTH;
  const maxBashOutput = options.limits?.maxBashOutput ?? DEFAULT_MAX_BASH_OUTPUT;
  const maxExecutionTimeMs =
    options.limits?.maxExecutionTimeMs ?? DEFAULT_MAX_BASH_EXECUTION_TIME_MS;
  assertPositiveLimit(maxCommandLength, 'maxCommandLength');
  assertPositiveLimit(maxBashOutput, 'maxBashOutput');
  assertPositiveLimit(maxExecutionTimeMs, 'maxExecutionTimeMs');
  const policy =
    options.policy ??
    createCommandPolicy({ ...options.policyOptions, fs: workspace.fs, maxCommandLength });
  const sandbox = new Bash({
    cwd: '/',
    ...(options.customCommands !== undefined && { customCommands: [...options.customCommands] }),
    executionLimits: { maxExecutionTimeMs },
    fs: workspace.fs,
  });
  const bound = (text: string, stream: 'stderr' | 'stdout'): string =>
    safeToolText(truncateStream(text, maxBashOutput, stream), maxBashOutput, boundText);
  return tool({
    description: await describeBashTool(sandbox, SCOPED_ROOT_INSTRUCTIONS),
    execute: async (input): Promise<BashOutput> => {
      const command = commandFrom(input);
      if (command.length > maxCommandLength) {
        return denied('Command exceeds the length limit.');
      }
      const decision = await policy.inspect(command);
      if (!decision.allow) {
        return denied(formatDenial(decision));
      }
      let result: BashOutput;
      try {
        result = await runBashCommand(sandbox, command);
      } catch (error) {
        if (isSupabashError(error) && error.code === 'POLICY_DENIED') {
          return denied(`Policy denied: ${error.message}`);
        }
        throw error;
      }
      return {
        ...result,
        stderr: bound(result.stderr, 'stderr'),
        stdout: bound(result.stdout, 'stdout'),
      };
    },
    inputSchema: bashInputSchema(),
  });
};

const commandFrom = (input: unknown): string => {
  if (typeof input === 'object' && input !== null && 'command' in input) {
    const { command } = input;
    if (typeof command === 'string') {
      return command;
    }
  }
  throw new Error('Bash tool input must include a command string.');
};

const formatDenial = (decision: CommandInspectDecision): string => {
  if (decision.code === undefined) {
    return decision.reason ?? 'Command denied by policy.';
  }
  return `Policy denied (${decision.code}): ${decision.reason ?? 'Command denied by policy.'}`;
};

const denied = (stderr: string): BashOutput => ({ exitCode: 126, stderr, stdout: '' });
