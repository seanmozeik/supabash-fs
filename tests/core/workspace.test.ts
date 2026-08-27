import { Bash } from 'just-bash/browser';
import { describe, expect, test } from 'vitest';

import type { SupabashError } from '../../src/api/errors.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('storage workspace', () => {
  test('keeps remote bodies lazy through stat and directory listing', async () => {
    const storage = seededStorage();
    const workspace = await createStorageWorkspace(storage);

    const stat = await workspace.fs.stat('/notes/alpha.md');
    expect(stat.size).toBe(12);
    await expect(workspace.fs.readdir('/notes')).resolves.toStrictEqual(['alpha.md', 'beta.md']);
    expect(storage.downloads).toStrictEqual([]);

    const reads = await Promise.all([
      workspace.fs.readFile('/notes/alpha.md'),
      workspace.fs.readFile('/notes/alpha.md'),
    ]);
    expect(reads).toStrictEqual(['alpha value\n', 'alpha value\n']);
    expect(storage.downloads).toStrictEqual(['/notes/alpha.md']);
  });

  test('runs Just Bash search and commits only changed entries', async () => {
    const storage = seededStorage();
    const workspace = await createStorageWorkspace(storage);
    const bash = new Bash({ cwd: '/', fs: workspace.fs });

    const search = await bash.exec('grep -R "value" /notes');
    expect({
      exitCode: search.exitCode,
      foundValue: search.stdout.includes('alpha value'),
    }).toStrictEqual({ exitCode: 0, foundValue: true });

    const mutation = await bash.exec(
      String.raw`printf 'updated\n' > /notes/alpha.md; rm /notes/beta.md; mkdir -p /archive; cp /notes/alpha.md /archive/alpha.md`,
    );
    expect(mutation.exitCode).toBe(0);

    const receipt = await workspace.commit();
    expect(
      receipt.changes.map(({ entryKind, kind, path }) => ({ entryKind, kind, path })),
    ).toStrictEqual([
      { entryKind: 'directory', kind: 'upsert', path: '/archive' },
      { entryKind: 'file', kind: 'upsert', path: '/archive/alpha.md' },
      { entryKind: 'file', kind: 'upsert', path: '/notes/alpha.md' },
      { entryKind: 'file', kind: 'delete', path: '/notes/beta.md' },
    ]);
    expect({
      archived: storage.text('/archive/alpha.md'),
      removed: storage.text('/notes/beta.md'),
      updated: storage.text('/notes/alpha.md'),
    }).toStrictEqual({ archived: 'updated\n', removed: undefined, updated: 'updated\n' });
  });

  test('restores directories and symbolic links after reopening', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);

    await workspace.fs.mkdir('/empty', { recursive: true });
    await workspace.fs.symlink('/empty', '/shortcut');
    await workspace.commit();

    const reopened = await createStorageWorkspace(storage);
    const emptyStat = await reopened.fs.lstat('/empty');
    const shortcutStat = await reopened.fs.lstat('/shortcut');
    expect(emptyStat.isDirectory).toBe(true);
    expect(shortcutStat.isSymbolicLink).toBe(true);
    await expect(reopened.fs.readlink('/shortcut')).resolves.toBe('/empty');
  });

  test('reopens a dangling symbolic link without following its target', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/notes.md', 'one\n');
    await workspace.fs.symlink('/notes.md', '/current');
    await workspace.commit();
    await workspace.fs.rm('/notes.md');
    await workspace.commit();

    const reopened = await createStorageWorkspace(storage);
    await expect(reopened.fs.readlink('/current')).resolves.toBe('/notes.md');
    await expect(reopened.fs.exists('/notes.md')).resolves.toBe(false);
  });

  test('discards staged changes without another storage read', async () => {
    const storage = seededStorage();
    const workspace = await createStorageWorkspace(storage);

    await workspace.fs.writeFile('/notes/alpha.md', 'temporary\n');
    await workspace.discard();

    expect(storage.downloads).toStrictEqual([]);
    await expect(workspace.fs.readFile('/notes/alpha.md')).resolves.toBe('alpha value\n');
  });

  test('does not expose mutable file storage through readFileBuffer', async () => {
    const storage = seededStorage();
    const workspace = await createStorageWorkspace(storage);

    const body = await workspace.fs.readFileBuffer('/notes/alpha.md');
    body.fill(0);

    await expect(workspace.fs.readFile('/notes/alpha.md')).resolves.toBe('alpha value\n');
    await expect(workspace.commit()).resolves.toMatchObject({ changes: [] });
  });

  test('records the target changed by utimes through a symbolic link', async () => {
    const storage = seededStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.symlink('/notes/alpha.md', '/latest');
    await workspace.commit();

    const modifiedAt = new Date('2026-08-26T16:00:00.000Z');
    await workspace.fs.utimes('/latest', modifiedAt, modifiedAt);
    const receipt = await workspace.commit();

    expect(receipt.changes.map(({ path }) => path)).toStrictEqual(['/notes/alpha.md']);
    const reopened = await createStorageWorkspace(storage);
    await expect(reopened.fs.readlink('/latest')).resolves.toBe('/notes/alpha.md');
    await expect(reopened.fs.stat('/notes/alpha.md')).resolves.toMatchObject({ mtime: modifiedAt });
  });

  test('rejects a commit when a stored entry changed', async () => {
    const storage = seededStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/notes/alpha.md', 'local\n');
    storage.putExternal('/notes/alpha.md', 'remote\n');

    const expectedError = {
      code: 'COMMIT_CONFLICT',
      path: '/notes/alpha.md',
    } satisfies Partial<SupabashError>;
    await expect(workspace.commit()).rejects.toMatchObject(expectedError);
  });

  test('rejects filesystem writes that attempt to leave the mounted root', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());

    const expectedError = { code: 'INVALID_PATH' } satisfies Partial<SupabashError>;
    await expect(workspace.fs.writeFile('/../../outside.md', 'blocked')).rejects.toMatchObject(
      expectedError,
    );
  });
});

const seededStorage = (): MemoryStorage =>
  new MemoryStorage([
    { body: 'alpha value\n', path: '/notes/alpha.md' },
    { body: 'beta value\n', path: '/notes/beta.md' },
  ]);
