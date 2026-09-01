import type { ToolSet } from 'ai';
import { latin1FromBytes } from 'just-bash';
import { defineCommand } from 'just-bash/browser';
import { describe, expect, test } from 'vitest';

import { createTools } from '../../src/ai-sdk/index.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('workspace AI SDK tools', () => {
  test('runs Bash and Apply Patch on one staged filesystem without committing', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    const { tools } = await createTools({ workspace });
    expect({
      toolKeys: Object.keys(tools).toSorted(),
      workspaceInTools: 'workspace' in tools,
    }).toStrictEqual({ toolKeys: ['apply_patch', 'bash'], workspaceInTools: false });
    const bashResult = await invoke(tools['bash'], {
      command: String.raw`printf 'alpha\n' > /notes.md`,
    });
    const patchResult = await invoke(tools['apply_patch'], {
      callId: 'call-1',
      operation: { diff: '-alpha\n+beta\n', path: '/notes.md', type: 'update_file' },
    });
    expect({
      bashExit: resultField(bashResult, 'exitCode'),
      durable: storage.text('/notes.md'),
      patch: patchResult,
      staged: await workspace.fs.readFile('/notes.md'),
    }).toStrictEqual({
      bashExit: 0,
      durable: undefined,
      patch: { output: 'OK update_file /notes.md', status: 'completed' },
      staged: 'beta\n',
    });
  });

  test('loads view_image only when enabled and rejects a symlink', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/pixel.png', pngBytes());
    await workspace.fs.symlink('/pixel.png', '/alias.png');
    const { tools } = await createTools({ viewImage: { enabled: true }, workspace });
    await expect(invoke(tools['view_image'], { path: '/alias.png' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
    });
    await expect(invoke(tools['view_image'], { path: '/pixel.png' })).resolves.toMatchObject({
      mediaType: 'image/png',
      path: '/pixel.png',
    });
    const output = await invoke(tools['view_image'], { path: '/pixel.png' });
    await expect(modelOutput(tools['view_image'], output)).resolves.toMatchObject({
      type: 'content',
      value: [{ mediaType: 'image/png', type: 'file' }],
    });
  });

  test('denies a command through the optional policy hook', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const { tools } = await createTools({
      bash: {
        policy: {
          inspect: (command: string) =>
            command.includes('rm')
              ? { allow: false, code: 'denied', reason: 'rm is blocked.' }
              : { allow: true },
        },
      },
      workspace,
    });
    await expect(invoke(tools['bash'], { command: 'rm /notes.md' })).resolves.toMatchObject({
      exitCode: 126,
      stderr: 'Policy denied (denied): rm is blocked.',
    });
  });

  test('runs an explicitly allowed custom command in pipelines and redirections', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const upper = defineCommand('upper', (_args, context) =>
      Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: latin1FromBytes(context.stdin).toUpperCase(),
      }),
    );
    const { tools } = await createTools({
      bash: { customCommands: [upper], policyOptions: { extraAllowCommands: ['upper'] } },
      workspace,
    });

    const result = await invoke(tools['bash'], {
      command: "printf 'memory' | upper > /result.txt && cat /result.txt",
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: 'MEMORY' });
    await expect(workspace.fs.readFile('/result.txt')).resolves.toBe('MEMORY');
  });

  test('requires a positive Bash execution time limit', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await expect(
      createTools({ bash: { limits: { maxExecutionTimeMs: 0 } }, workspace }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  test('enforces the Bash execution deadline', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const { tools } = await createTools({
      bash: { limits: { maxExecutionTimeMs: 10 } },
      workspace,
    });
    const result = await invoke(tools['bash'], { command: 'sleep 1' });
    expect({
      exitCode: resultField(result, 'exitCode'),
      hasDeadline: String(resultField(result, 'stderr')).includes('deadline'),
    }).toStrictEqual({ exitCode: 124, hasDeadline: true });
  });

  test('bounds Bash output with a stable marker', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const { tools } = await createTools({ bash: { limits: { maxBashOutput: 24 } }, workspace });
    const result = await invoke(tools['bash'], { command: "printf 'abcdefghijklmnopqrstuvwxyz'" });
    expect(resultField(result, 'stdout')).toBe('abcdefghijk\n[truncated]\n');
  });

  test('accepts a command-length boundary and denies the next character', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const { tools } = await createTools({ bash: { limits: { maxCommandLength: 7 } }, workspace });
    await expect(invoke(tools['bash'], { command: 'echo hi' })).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(invoke(tools['bash'], { command: 'echo hii' })).resolves.toMatchObject({
      exitCode: 126,
      stderr: 'Command exceeds the length limit.',
    });
  });

  test('rejects invalid image limits before exposing the tool', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await expect(
      createTools({ viewImage: { enabled: true, maxBytes: 0 }, workspace }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

type WorkspaceTool = ToolSet[string];

const invoke = (tool: WorkspaceTool | undefined, input: unknown): Promise<unknown> => {
  const execute = tool?.execute;
  if (execute === undefined) {
    return Promise.reject(new Error('Tool execute is missing.'));
  }
  return Promise.resolve(execute(input, { context: {}, messages: [], toolCallId: 'tool-1' }));
};

const modelOutput = (tool: WorkspaceTool | undefined, output: unknown): Promise<unknown> => {
  const convert = tool?.toModelOutput;
  if (convert === undefined) {
    return Promise.reject(new Error('Tool model output adapter is missing.'));
  }
  return Promise.resolve(convert({ input: { path: '/pixel.png' }, output, toolCallId: 'tool-1' }));
};

const resultField = (value: unknown, key: string): unknown => {
  if (!isRecord(value) || !(key in value)) {
    return undefined;
  }
  return value[key];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const pngBytes = (): Uint8Array =>
  Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
