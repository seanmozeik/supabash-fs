import type { Tool } from 'ai';
import { createBashTool, type CommandResult } from 'bash-tool';
import { Bash } from 'just-bash/browser';

import type { Workspace } from '../api/contracts.js';
import { DEFAULT_MAX_BASH_OUTPUT, DEFAULT_MAX_COMMAND_LENGTH, boundText } from './bounds.js';
import type { BashToolOptions, CommandInspectDecision } from './options.js';
import { safeToolText } from './redact.js';

const SCOPED_ROOT_INSTRUCTIONS =
  'The filesystem root is already scoped to this workspace. Do not select a bucket, user, prefix, access token, or storage client. Do not commit, discard, inspect history, checkpoint, diff, or restore.';

export const createWorkspaceBashTool = async (
  workspace: Workspace,
  options: BashToolOptions = {},
): Promise<Tool> => {
  const maxCommandLength = options.limits?.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH;
  const maxBashOutput = options.limits?.maxBashOutput ?? DEFAULT_MAX_BASH_OUTPUT;
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
      const decision = await Promise.resolve(inspectCommand(options, command));
      if (!decision.allow) {
        return denied(decision.reason ?? 'Command denied by policy.');
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

const inspectCommand = (
  options: BashToolOptions,
  command: string,
): CommandInspectDecision | Promise<CommandInspectDecision> =>
  options.policy === undefined ? { allow: true } : options.policy.inspect(command);

const denied = (stderr: string): CommandResult => ({ exitCode: 126, stderr, stdout: '' });

const isCommandResult = (value: unknown): value is CommandResult =>
  typeof value === 'object' &&
  value !== null &&
  'exitCode' in value &&
  'stderr' in value &&
  'stdout' in value;
