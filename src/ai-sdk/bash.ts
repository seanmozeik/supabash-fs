import type { Tool } from 'ai';
import { createBashTool, type CommandResult } from 'bash-tool';
import { Bash } from 'just-bash/browser';

import type { Workspace } from '../api/contracts.js';
import { createCommandPolicy } from '../policy/inspect.js';
import type { CommandInspectDecision } from '../policy/types.js';
import { DEFAULT_MAX_BASH_OUTPUT, DEFAULT_MAX_COMMAND_LENGTH, boundText } from './bounds.js';
import type { BashToolOptions } from './options.js';
import { safeToolText } from './redact.js';

const SCOPED_ROOT_INSTRUCTIONS =
  'The filesystem root is already scoped to this workspace. Do not select a bucket, user, prefix, access token, or storage client. Do not commit, discard, inspect history, checkpoint, diff, or restore.';

/**
 * The bash-tool onBeforeBashCall hook is synchronous and cannot return a typed
 * deny decision, so this adapter wraps execute() and inspects the command first.
 */
export const createWorkspaceBashTool = async (
  workspace: Workspace,
  options: BashToolOptions = {},
): Promise<Tool> => {
  const maxCommandLength = options.limits?.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH;
  const maxBashOutput = options.limits?.maxBashOutput ?? DEFAULT_MAX_BASH_OUTPUT;
  const policy =
    options.policy ??
    createCommandPolicy({ maxCommandLength, ...options.policyOptions, fs: workspace.fs });
  const toolkit = await createBashTool({
    destination: '/',
    extraInstructions: SCOPED_ROOT_INSTRUCTIONS,
    maxOutputLength: maxBashOutput,
    onAfterBashCall: ({ result }) => ({
      result: {
        ...result,
        stderr: safeToolText(result.stderr, maxBashOutput, boundText),
        stdout: safeToolText(result.stdout, maxBashOutput, boundText),
      },
    }),
    sandbox: new Bash({ cwd: '/', fs: workspace.fs }),
  });
  const { execute } = toolkit.bash;
  if (execute === undefined) {
    throw new Error('bash-tool did not expose an execute method.');
  }
  return {
    ...toolkit.bash,
    execute: async (input, extra) => {
      const command = commandFrom(input);
      if (command.length > maxCommandLength) {
        return denied('Command exceeds the length limit.');
      }
      const decision = await policy.inspect(command);
      if (!decision.allow) {
        return denied(formatDenial(decision));
      }
      const result = await execute({ command }, extra);
      if (!isCommandResult(result)) {
        throw new Error('bash-tool returned a streaming result.');
      }
      return result;
    },
  };
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

const denied = (stderr: string): CommandResult => ({ exitCode: 126, stderr, stdout: '' });

const isCommandResult = (value: unknown): value is CommandResult =>
  typeof value === 'object' &&
  value !== null &&
  'exitCode' in value &&
  'stderr' in value &&
  'stdout' in value;
