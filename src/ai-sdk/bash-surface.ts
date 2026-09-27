import { jsonSchema, type Schema } from 'ai';
import type { Bash } from 'just-bash/browser';

/**
 * The model-facing Bash surface, kept byte-identical to what bash-tool 1.3.19
 * produced for this adapter (destination `/`, no uploaded files, no tee
 * transform), so provider requests and their prompt caches do not change.
 * Supabash now owns this surface instead of loading bash-tool, whose Node
 * entry pulls the Node build of just-bash into Edge bundles.
 */

export interface BashInput {
  readonly command: string;
}

export interface BashOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const BASH_WORKING_DIRECTORY = '/';

// Key order is part of the provider request bytes.
const BASH_INPUT_JSON_SCHEMA = {
  type: 'object',
  properties: { command: { type: 'string', description: 'The bash command to execute' } },
  required: ['command'],
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
} as const;

interface InputIssue {
  readonly code: 'invalid_type';
  readonly expected: 'object' | 'string';
  readonly received: string;
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * Renders as its issue list alone, like a Zod 3 error, because the AI SDK
 * quotes `toString()` in the invalid-input result the model reads.
 */
class BashInputError extends Error {
  override readonly name = 'BashInputError';

  constructor(inputIssue: InputIssue) {
    super(JSON.stringify([inputIssue], null, 2));
  }

  override toString(): string {
    return this.message;
  }
}

type InputValidation =
  | { readonly success: true; readonly value: BashInput }
  | { readonly success: false; readonly error: Error };

/** Zod 3's name for a parsed JSON value type. */
const receivedType = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    return 'nan';
  }
  return typeof value;
};

const issue = (
  expected: InputIssue['expected'],
  value: unknown,
  path: readonly string[],
): InputIssue => {
  const received = receivedType(value);
  return {
    code: 'invalid_type',
    expected,
    received,
    path,
    message: received === 'undefined' ? 'Required' : `Expected ${expected}, received ${received}`,
  };
};

/** Validates the way bash-tool's Zod 3 object did: unknown keys are dropped. */
const validateBashInput = (value: unknown): InputValidation => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: new BashInputError(issue('object', value, [])), success: false };
  }
  const command: unknown = 'command' in value ? value.command : undefined;
  if (typeof command !== 'string') {
    return { error: new BashInputError(issue('string', command, ['command'])), success: false };
  }
  return { success: true, value: { command } };
};

export const bashInputSchema = (): Schema<BashInput> =>
  jsonSchema<BashInput>(BASH_INPUT_JSON_SCHEMA, { validate: validateBashInput });

/** The command names bash-tool knows, in its discovery order. */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'grep',
  'sed',
  'awk',
  'cat',
  'head',
  'tail',
  'sort',
  'uniq',
  'cut',
  'tr',
  'wc',
  'find',
  'xargs',
  'diff',
  'jq',
  'yq',
  'tee',
  'paste',
  'column',
  'printf',
  'comm',
  'rev',
  'fold',
  'nl',
  'split',
  'join',
  'expand',
  'unexpand',
  'strings',
  'od',
  'xxd',
  'iconv',
  'curl',
  'html-to-markdown',
  'node',
  'python',
  'xan',
]);

/** Lists the known commands the sandbox exposes in its bin directories. */
const discoverTools = async (sandbox: Bash): Promise<string> => {
  const result = await sandbox.exec('ls /usr/bin /usr/local/bin /bin /sbin /usr/sbin 2>/dev/null');
  if (result.exitCode !== 0 && result.stdout === '') {
    return '';
  }
  const available = new Set(
    result.stdout
      .split('\n')
      .filter((name) => name !== '' && !name.endsWith(':') && KNOWN_TOOLS.has(name)),
  );
  if (available.size === 0) {
    return '';
  }
  return `Available tools: ${[...available].toSorted().join(', ')}, and more`;
};

export const describeBashTool = async (sandbox: Bash, instructions: string): Promise<string> => {
  const toolPrompt = await discoverTools(sandbox);
  return [
    'Execute bash commands in the sandbox environment.',
    '',
    `WORKING DIRECTORY: ${BASH_WORKING_DIRECTORY}`,
    'All commands execute from this directory. Use relative paths from here.',
    '',
    ...(toolPrompt === '' ? [] : [toolPrompt, '']),
    'Common operations:',
    '  ls -la              # List files with details',
    "  find . -name '*.ts' # Find files by pattern",
    "  grep -r 'pattern' . # Search file contents",
    '  cat <file>          # View file contents',
    '',
    instructions,
  ]
    .join('\n')
    .trim();
};

/** Runs a command from the working directory, as bash-tool did. */
export const runBashCommand = async (sandbox: Bash, command: string): Promise<BashOutput> => {
  const { exitCode, stderr, stdout } = await sandbox.exec(
    `cd "${BASH_WORKING_DIRECTORY}" && ${command}`,
  );
  return { stdout, stderr, exitCode };
};

/** Per-stream truncation from bash-tool, applied before the Supabash bounds. */
export const truncateStream = (
  output: string,
  maxLength: number,
  stream: 'stderr' | 'stdout',
): string => {
  if (output.length <= maxLength) {
    return output;
  }
  const removed = output.length - maxLength;
  return `${output.slice(0, maxLength)}\n\n[${stream} truncated: ${removed} characters removed]`;
};
