import type { ToolSet } from 'ai';
import { expect, test } from 'vitest';

import { createTools } from '../../src/ai-sdk/create-tools.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { createMountedFileSystem } from '../../src/mounts/compose.ts';
import { createFileSystemSnapshot } from '../../src/mounts/snapshot.ts';
import { applyPatchOperations } from '../../src/patch/executor.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

test('bash and Apply Patch share permissions and leave shared sources out of commits', async () => {
  const storage = new MemoryStorage();
  const workspace = await createStorageWorkspace(storage);
  const docs = await createFileSystemSnapshot({
    sourceId: 'app-docs',
    revision: 'v1',
    files: [{ path: '/help.md', content: 'Use the calendar.\n' }],
  });
  const mounted = createMountedFileSystem([
    { access: 'read-write', sourceId: 'user-1', mountPoint: '/memories', workspace },
    { access: 'read-only', mountPoint: '/docs', snapshot: docs },
  ]);
  const { tools } = await createTools({
    filesystem: mounted.fs,
    bash: { policyOptions: { allowRecursiveRoot: true } },
  });
  await expect(
    invoke(tools['bash'], { command: 'cat /docs/help.md > /memories/note.md' }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    invoke(tools['apply_patch'], {
      callId: 'edit-memory',
      operation: {
        type: 'update_file',
        path: '/memories/note.md',
        diff: '-Use the calendar.\n+Prefers the calendar.\n',
      },
    }),
  ).resolves.toMatchObject({ status: 'completed' });
  await expect(
    invoke(tools['bash'], { command: "printf 'bad' > /docs/help.md" }),
  ).resolves.toMatchObject({ exitCode: 126 });
  await expect(
    invoke(tools['apply_patch'], {
      callId: 'edit-docs',
      operation: { type: 'update_file', path: '/docs/help.md', diff: '-Use the calendar.\n+bad\n' },
    }),
  ).resolves.toMatchObject({ status: 'failed' });
  const receipt = await workspace.commit();
  expect({
    paths: receipt.changes.map((change) => change.path),
    memory: storage.text('/note.md'),
    shared: await docs.fs.readFile('/help.md'),
  }).toStrictEqual({
    paths: ['/note.md'],
    memory: 'Prefers the calendar.\n',
    shared: 'Use the calendar.\n',
  });
});

test('a failed mixed-mount patch rolls back the staged private edit', async () => {
  const workspace = await createStorageWorkspace(new MemoryStorage());
  await workspace.fs.writeFile('/note.md', 'before\n');
  const snapshot = await createFileSystemSnapshot({
    sourceId: 'docs',
    revision: 'v1',
    files: [{ path: '/help.md', content: 'reference\n' }],
  });
  const mounted = createMountedFileSystem([
    { access: 'read-write', mountPoint: '/memories', sourceId: 'user', workspace },
    { access: 'read-only', mountPoint: '/docs', snapshot },
  ]);
  const result = await applyPatchOperations(mounted, [
    { type: 'update_file', path: '/memories/note.md', diff: '-before\n+after\n' },
    { type: 'delete_file', path: '/docs/help.md' },
  ]);
  expect(result.status).toBe('failed');
  await expect(workspace.fs.readFile('/note.md')).resolves.toBe('before\n');
  await expect(snapshot.fs.readFile('/help.md')).resolves.toBe('reference\n');
});

const invoke = (tool: ToolSet[string] | undefined, input: unknown): Promise<unknown> => {
  if (tool?.execute === undefined) {
    throw new Error('Missing tool executor.');
  }
  return Promise.resolve(
    tool.execute(input, { context: {}, messages: [], toolCallId: 'mount-test' }),
  );
};
