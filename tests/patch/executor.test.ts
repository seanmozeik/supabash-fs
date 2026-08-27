import { Bash } from 'just-bash/browser';
import { describe, expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { applyPatch, applyPatchOperations } from '../../src/patch/executor.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const lines = (...values: string[]): string => values.join('\n');

const workspaceWith = (files: readonly { path: string; body: string }[] = []) =>
  createStorageWorkspace(new MemoryStorage(files));

describe('applyPatch executor', () => {
  test('creates a file and leaves the change staged', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    const result = await applyPatch(workspace, {
      diff: lines('+hello', '+'),
      path: '/notes.md',
      type: 'create_file',
    });
    expect(result.status).toBe('completed');
    await expect(workspace.fs.readFile('/notes.md')).resolves.toBe('hello\n');
    expect(storage.text('/notes.md')).toBeUndefined();
  });

  test('rejects creating a file that already exists', async () => {
    const workspace = await workspaceWith([{ body: 'old\n', path: '/notes.md' }]);
    const result = await applyPatch(workspace, {
      diff: '+new\n',
      path: '/notes.md',
      type: 'create_file',
    });
    expect({
      output: result.output,
      status: result.status,
      text: await workspace.fs.readFile('/notes.md'),
    }).toStrictEqual({ output: 'Path already exists.', status: 'failed', text: 'old\n' });
  });

  test('updates a staged file and supports moveTo without a duplicate', async () => {
    const workspace = await workspaceWith([{ body: 'legacy\n', path: '/old.md' }]);
    const result = await applyPatch(workspace, {
      diff: lines('-legacy', '+current'),
      moveTo: '/docs/new.md',
      path: '/old.md',
      type: 'update_file',
    });
    expect(result.status).toBe('completed');
    expect({
      destination: await workspace.fs.readFile('/docs/new.md'),
      sourceExists: await workspace.fs.exists('/old.md'),
    }).toStrictEqual({ destination: 'current\n', sourceExists: false });
  });

  test('deletes an existing file', async () => {
    const workspace = await workspaceWith([{ body: 'remove\n', path: '/gone.md' }]);
    const result = await applyPatch(workspace, { path: '/gone.md', type: 'delete_file' });
    expect(result.status).toBe('completed');
    await expect(workspace.fs.exists('/gone.md')).resolves.toBe(false);
  });

  test('rolls back a failed all-or-nothing batch', async () => {
    const workspace = await workspaceWith([{ body: 'keep\n', path: '/keep.md' }]);
    const result = await applyPatchOperations(workspace, [
      { diff: '+created\n', path: '/created.md', type: 'create_file' },
      { diff: '-missing', path: '/missing.md', type: 'update_file' },
    ]);
    expect(result.status).toBe('failed');
    expect({
      created: await workspace.fs.exists('/created.md'),
      keep: await workspace.fs.readFile('/keep.md'),
    }).toStrictEqual({ created: false, keep: 'keep\n' });
  });

  test('keeps earlier mutations in ordered batch mode', async () => {
    const workspace = await workspaceWith();
    const result = await applyPatchOperations(
      workspace,
      [
        { diff: '+first\n', path: '/first.md', type: 'create_file' },
        { diff: '+second\n', path: '/first.md', type: 'create_file' },
      ],
      { mode: 'ordered' },
    );
    expect(result.status).toBe('failed');
    await expect(workspace.fs.readFile('/first.md')).resolves.toBe('first');
  });

  test('applies after staged Bash edits and remains uncommitted', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    const bash = new Bash({ cwd: '/', fs: workspace.fs });
    const created = await bash.exec(String.raw`printf 'alpha\n' > /notes.md`);
    expect(created.exitCode).toBe(0);
    const patched = await applyPatch(workspace, {
      diff: lines('-alpha', '+beta'),
      path: '/notes.md',
      type: 'update_file',
    });
    expect({
      durableBefore: storage.text('/notes.md'),
      staged: await workspace.fs.readFile('/notes.md'),
      status: patched.status,
    }).toStrictEqual({ durableBefore: undefined, staged: 'beta\n', status: 'completed' });
    const receipt = await workspace.commit();
    expect({
      durable: storage.text('/notes.md'),
      paths: receipt.changes.map((change) => change.path),
    }).toStrictEqual({ durable: 'beta\n', paths: ['/notes.md'] });
  });

  test('lets Bash see a staged patch before commit', async () => {
    const workspace = await workspaceWith();
    await applyPatch(workspace, { diff: '+hello\n', path: '/notes.md', type: 'create_file' });
    const bash = new Bash({ cwd: '/', fs: workspace.fs });
    const result = await bash.exec('cat /notes.md');
    expect({ exitCode: result.exitCode, stdout: result.stdout }).toStrictEqual({
      exitCode: 0,
      stdout: 'hello',
    });
  });
});
