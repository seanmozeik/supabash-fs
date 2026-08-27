import { describe, expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { applyPatch } from '../../src/patch/executor.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const workspaceWith = (files: readonly { path: string; body: string }[] = []) =>
  createStorageWorkspace(new MemoryStorage(files));

describe('applyPatch path and content guards', () => {
  test.each([
    '/.supabash/secret.md',
    '/../escape.md',
    String.raw`/docs\secret.md`,
    '/docs/%2Fsecret.md',
    '/docs/secret\u0000.md',
  ])('rejects unsafe path %s before mutation', async (path) => {
    const workspace = await workspaceWith();
    const result = await applyPatch(workspace, { diff: '+x\n', path, type: 'create_file' });
    expect(result.status).toBe('failed');
    expect(result.cause).toMatchObject({ code: 'INVALID_PATH' });
    expect(result.output).not.toContain('user-');
    expect(workspace.fs.getAllPaths()).toStrictEqual(['/']);
  });

  test('rejects an update of a missing file', async () => {
    const workspace = await workspaceWith();
    const result = await applyPatch(workspace, {
      diff: '-a\n+b\n',
      path: '/missing.md',
      type: 'update_file',
    });
    expect(result).toMatchObject({ output: 'Path does not exist.', status: 'failed' });
  });

  test('rejects deleting a missing path', async () => {
    const workspace = await workspaceWith();
    const result = await applyPatch(workspace, { path: '/missing.md', type: 'delete_file' });
    expect(result).toMatchObject({ output: 'Path does not exist.', status: 'failed' });
  });

  test('rejects a directory target', async () => {
    const workspace = await workspaceWith();
    await workspace.fs.mkdir('/notes');
    const result = await applyPatch(workspace, {
      diff: '-x\n+y\n',
      path: '/notes',
      type: 'update_file',
    });
    expect(result).toMatchObject({ output: 'Path is a directory.', status: 'failed' });
  });

  test('rejects a symbolic-link target', async () => {
    const workspace = await workspaceWith([{ body: 'target\n', path: '/file.md' }]);
    await workspace.fs.symlink('/file.md', '/alias');
    const result = await applyPatch(workspace, {
      diff: '-target\n+next\n',
      path: '/alias',
      type: 'update_file',
    });
    expect(result).toMatchObject({ output: 'Path is a symbolic link.', status: 'failed' });
    await expect(workspace.fs.readFile('/file.md')).resolves.toBe('target\n');
  });

  test('rejects non-UTF-8 content', async () => {
    const workspace = await workspaceWith();
    await workspace.fs.writeFile('/binary.bin', new Uint8Array([0xff, 0xfe, 0xfd]));
    const result = await applyPatch(workspace, {
      diff: '-x\n+y\n',
      path: '/binary.bin',
      type: 'update_file',
    });
    expect(result.status).toBe('failed');
    expect(result.cause).toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
  });

  test('rejects moveTo when the destination exists', async () => {
    const workspace = await workspaceWith([
      { body: 'source\n', path: '/from.md' },
      { body: 'dest\n', path: '/to.md' },
    ]);
    const result = await applyPatch(workspace, {
      diff: ' source',
      moveTo: '/to.md',
      path: '/from.md',
      type: 'update_file',
    });
    expect(result).toMatchObject({ output: 'Destination path already exists.', status: 'failed' });
    await expect(workspace.fs.readFile('/from.md')).resolves.toBe('source\n');
  });

  test('rejects malformed create syntax without writing', async () => {
    const workspace = await workspaceWith();
    const result = await applyPatch(workspace, {
      diff: 'not plus prefixed',
      path: '/created.md',
      type: 'create_file',
    });
    expect(result.status).toBe('failed');
    expect(result.cause).toMatchObject({ code: 'INVALID_PATCH' });
    await expect(workspace.fs.exists('/created.md')).resolves.toBe(false);
  });

  test('rejects a patch larger than the configured limit', async () => {
    const workspace = await workspaceWith();
    const result = await applyPatch(
      workspace,
      { diff: `+${'a'.repeat(20)}`, path: '/big.md', type: 'create_file' },
      { maxPatchSize: 8 },
    );
    expect(result.status).toBe('failed');
    expect(result.cause).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(workspace.fs.exists('/big.md')).resolves.toBe(false);
  });
});
