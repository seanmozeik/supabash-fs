import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, type ToolSet } from 'ai';
import { InMemoryFs } from 'just-bash/browser';
import { describe, expect, test } from 'vitest';

import { createTools } from '../../src/ai-sdk/index.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// Captured from bash-tool 1.3.19, which built this surface before Supabash
// owned it. A change here changes provider requests and their prompt caches.
const DESCRIPTION_HEAD =
  'Execute bash commands in the sandbox environment.\n\nWORKING DIRECTORY: /\nAll commands execute from this directory. Use relative paths from here.\n\n';
const DESCRIPTION_TAIL =
  "Common operations:\n  ls -la              # List files with details\n  find . -name '*.ts' # Find files by pattern\n  grep -r 'pattern' . # Search file contents\n  cat <file>          # View file contents\n\nThe filesystem exposes only the sources configured by the host. Use the exact visible paths; read-only mounts reject writes. Supported shell syntax includes pipelines, redirection, command and process substitution, loops, conditionals, functions, grouped commands, command chains, and find -exec. Do not select a bucket, user, prefix, access token, or storage client. Do not commit, discard, inspect history, checkpoint, diff, or restore.";
const JUST_BASH_TOOLS =
  'Available tools: awk, cat, column, comm, cut, diff, expand, find, fold, grep, head, html-to-markdown, join, jq, nl, od, paste, printf, rev, sed, sort, split, strings, tail, tee, tr, unexpand, uniq, wc, xargs, and more\n\n';
const PARAMETERS =
  '{"type":"object","properties":{"command":{"type":"string","description":"The bash command to execute"}},"required":["command"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}';
const MISSING_COMMAND =
  'AI_InvalidToolInputError: Invalid input for tool bash: AI_TypeValidationError: Type validation failed: Value: {"cmd":"ls"}.\nError message: [\n  {\n    "code": "invalid_type",\n    "expected": "string",\n    "received": "undefined",\n    "path": [\n      "command"\n    ],\n    "message": "Required"\n  }\n]';

describe('model-facing Bash surface', () => {
  test('describes a workspace without bin directories', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const { tools } = await createTools({ filesystem: workspace.fs });
    expect(tools['bash']?.description).toBe(`${DESCRIPTION_HEAD}${DESCRIPTION_TAIL}`);
  });

  test('lists the known commands a just-bash filesystem exposes', async () => {
    const { tools } = await createTools({ filesystem: new InMemoryFs() });
    expect(tools['bash']?.description).toBe(
      `${DESCRIPTION_HEAD}${JUST_BASH_TOOLS}${DESCRIPTION_TAIL}`,
    );
  });

  test('sends the same tool definition and results to the provider', async () => {
    const bodies = await providerBodies({ filesystem: new InMemoryFs() });
    const final = parseProviderBody(bodies.at(-1) ?? '{}');
    const [bash] = final.tools;
    expect({
      outputs: final.input.filter((item) => item.type === 'function_call_output'),
      parameters: JSON.stringify(bash?.parameters),
    }).toStrictEqual({
      outputs: [
        {
          call_id: 'call_1',
          output: '{"stdout":"hi\\n","stderr":"err\\n","exitCode":0}',
          type: 'function_call_output',
        },
        { call_id: 'call_2', output: MISSING_COMMAND, type: 'function_call_output' },
      ],
      parameters: PARAMETERS,
    });
    expect(bash?.name).toBe('bash');
    expect(bash?.description).toBe(`${DESCRIPTION_HEAD}${JUST_BASH_TOOLS}${DESCRIPTION_TAIL}`);
    expect(Object.keys(bash ?? {})).toStrictEqual(['type', 'name', 'description', 'parameters']);
  });

  test('reports each invalid input the way the Zod 3 schema did', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const { tools } = await createTools({ filesystem: workspace.fs });
    const validate = await inputValidator(tools);
    await expect(validate({ command: 'ls', extra: 1 })).resolves.toStrictEqual({ command: 'ls' });
    await expect(validate(null)).resolves.toBe(
      '[\n  {\n    "code": "invalid_type",\n    "expected": "object",\n    "received": "null",\n    "path": [],\n    "message": "Expected object, received null"\n  }\n]',
    );
    await expect(validate({ command: 1 })).resolves.toBe(
      '[\n  {\n    "code": "invalid_type",\n    "expected": "string",\n    "received": "number",\n    "path": [\n      "command"\n    ],\n    "message": "Expected string, received number"\n  }\n]',
    );
    await expect(validate([])).resolves.toContain('"received": "array"');
    await expect(validate({})).resolves.toContain('"message": "Required"');
  });

  test('keeps the per-stream truncation notice when redaction shortens it', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const { tools } = await createTools({
      bash: { limits: { maxBashOutput: 60 } },
      filesystem: workspace.fs,
    });
    const execute = tools['bash']?.execute;
    const result: unknown = await execute?.(
      { command: `printf 'Bearer ${'x'.repeat(100)}'` },
      { context: {}, messages: [], toolCallId: 'tool-1' },
    );
    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: '',
      stdout: '[redacted]\n\n[stdout truncated: 47 characters removed]',
    });
  });
});

interface ProviderBody {
  readonly input: readonly { readonly type?: string }[];
  readonly tools: readonly {
    readonly name?: string;
    readonly description?: string;
    readonly parameters?: unknown;
  }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isProviderInput = (value: unknown): value is ProviderBody['input'][number] =>
  isRecord(value) && (value['type'] === undefined || typeof value['type'] === 'string');

const isProviderTool = (value: unknown): value is ProviderBody['tools'][number] =>
  isRecord(value) &&
  (value['name'] === undefined || typeof value['name'] === 'string') &&
  (value['description'] === undefined || typeof value['description'] === 'string');

const parseProviderBody = (source: string): ProviderBody => {
  const body: unknown = JSON.parse(source);
  if (!isRecord(body)) {
    throw new TypeError('Expected a provider request object.');
  }
  const input: unknown = body['input'];
  const tools: unknown = body['tools'];
  if (
    !Array.isArray(input) ||
    !input.every((item) => isProviderInput(item)) ||
    !Array.isArray(tools) ||
    !tools.every((tool) => isProviderTool(tool))
  ) {
    throw new TypeError('Expected provider input and tools arrays.');
  }
  return { input, tools };
};

const inputValidator = async (tools: ToolSet): Promise<(value: unknown) => Promise<unknown>> => {
  const { asSchema } = await import('ai');
  const schema = asSchema(tools['bash']?.inputSchema);
  return async (value) => {
    const result = await schema.validate?.(value);
    if (result === undefined) {
      throw new Error('The Bash input schema has no validator.');
    }
    const valueOrError: unknown = result.success ? result.value : String(result.error);
    return valueOrError;
  };
};

const providerBodies = async (options: Parameters<typeof createTools>[0]): Promise<string[]> => {
  const bodies: string[] = [];
  const fetchStub = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== 'string') {
      throw new TypeError('Expected a JSON request body.');
    }
    bodies.push(init.body);
    return Promise.resolve(responseFor(bodies.length));
  };
  const openai = createOpenAI({
    apiKey: 'test-key',
    fetch: Object.assign(fetchStub, { preconnect: fetch.preconnect }),
  });
  const { tools } = await createTools(options);
  await generateText({
    model: openai.responses('gpt-test'),
    prompt: 'go',
    stopWhen: stepCountIs(3),
    tools,
  });
  return bodies;
};

const responseFor = (call: number): Response => {
  const output =
    call === 1
      ? [
          functionCall('call_1', String.raw`{"command":"printf 'hi\\n'; echo err >&2"}`),
          functionCall('call_2', '{"cmd":"ls"}'),
        ]
      : [
          {
            content: [{ annotations: [], text: 'done', type: 'output_text' }],
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            type: 'message',
          },
        ];
  return Response.json({
    created_at: 1,
    id: `resp_${call}`,
    model: 'gpt-test',
    object: 'response',
    output,
    status: 'completed',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
};

const functionCall = (callId: string, argumentsText: string): Record<string, string> => ({
  arguments: argumentsText,
  call_id: callId,
  id: `fc_${callId}`,
  name: 'bash',
  status: 'completed',
  type: 'function_call',
});
