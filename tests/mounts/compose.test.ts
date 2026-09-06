import { describe, expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { createMountedFileSystem } from '../../src/mounts/compose.ts';
import { createFileSystemSnapshot } from '../../src/mounts/snapshot.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const setup = async () => {
  const workspace = await createStorageWorkspace(new MemoryStorage());
  await workspace.fs.writeFile('/note.md', 'private');
  await workspace.fs.mkdir('/.juno');
  await workspace.fs.writeFile('/.juno/secret.md', 'internal');
  const snapshot = await createFileSystemSnapshot({
    sourceId: 'docs',
    revision: 'release-1',
    files: [{ path: '/help.md', content: 'shared' }],
  });
  const mounted = createMountedFileSystem([
    {
      access: 'read-write',
      mountPoint: '/memories',
      sourceId: 'user-1',
      workspace,
      view: { hiddenRoots: ['/.juno'] },
    },
    { access: 'read-only', mountPoint: '/docs', snapshot },
  ]);
  return { workspace, snapshot, mounted };
};

describe('mounted filesystem', () => {
  test('composes listings and translates retrieval paths without moving stored documents', async () => {
    const { mounted } = await setup();
    expect({
      memory: await mounted.fs.readFile('/memories/note.md'),
      docs: await mounted.fs.readFile('/docs/help.md'),
      source: mounted.toSourcePath('/memories/note.md'),
      visible: mounted.toVirtualPath('/memories', '/note.md'),
    }).toStrictEqual({
      memory: 'private',
      docs: 'shared',
      source: { mountPoint: '/memories', path: '/note.md', sourceId: 'user-1' },
      visible: '/memories/note.md',
    });
    await expect(mounted.fs.readdir('/')).resolves.toStrictEqual(
      expect.arrayContaining(['docs', 'memories']),
    );
    expect(mounted.fs.getAllPaths()).not.toContain('/memories/.juno/secret.md');
    await expect(mounted.fs.readFile('/memories/.juno/secret.md')).rejects.toThrow(/outside/u);
    expect(() => mounted.toVirtualPath('/memories', '/.juno/secret.md')).toThrow(/outside/u);
  });

  test('rejects every shared mutation and protects mount boundaries before moving data', async () => {
    const { mounted, workspace } = await setup();
    for (const attempt of [
      () => mounted.fs.writeFile('/docs/help.md', 'bad'),
      () => mounted.fs.appendFile('/docs/help.md', 'bad'),
      () => mounted.fs.rm('/docs', { recursive: true }),
      () => mounted.fs.rm('/', { recursive: true }),
      () => mounted.fs.rm('/memories', { recursive: true }),
      () => mounted.fs.mkdir('/docs/new'),
      () => mounted.fs.chmod('/docs/help.md', 0o777),
      () => mounted.fs.utimes('/docs/help.md', new Date(), new Date()),
      () => mounted.fs.cp('/memories/note.md', '/docs/help.md'),
      () => mounted.fs.mv('/docs/help.md', '/memories/help.md'),
      () => mounted.fs.mv('/memories/note.md', '/docs/help.md'),
      () => mounted.fs.symlink('/docs/help.md', '/memories/link'),
      () => mounted.fs.link('/docs/help.md', '/memories/link'),
      () => mounted.fs.writeFile('/unmounted.md', 'bad'),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    await expect(workspace.fs.readFile('/note.md')).resolves.toBe('private');
    await expect(mounted.fs.readFile('/docs/help.md')).resolves.toBe('shared');
    await mounted.fs.cp('/docs/help.md', '/memories/copied.md');
    await expect(workspace.fs.readFile('/copied.md')).resolves.toBe('shared');
    await mounted.fs.writeFile('/dev/null', 'discard');
    await expect(mounted.fs.readFile('/dev/null')).resolves.toBe('');
  });

  test('keeps user state and history independent of shared snapshots', async () => {
    const { mounted, workspace, snapshot } = await setup();
    const original = await workspace.commit();
    const other = await createStorageWorkspace(new MemoryStorage());
    const second = createMountedFileSystem([
      { access: 'read-write', mountPoint: '/memories', sourceId: 'user-2', workspace: other },
      { access: 'read-only', mountPoint: '/docs', snapshot },
    ]);
    await mounted.fs.writeFile('/memories/note.md', 'changed');
    const changed = await workspace.commit();
    expect(changed.changes.every((change) => change.path.startsWith('/note'))).toBe(true);
    await workspace.restore(original.revision);
    await workspace.commit();
    await expect(mounted.fs.readFile('/memories/note.md')).resolves.toBe('private');
    await expect(second.fs.exists('/memories/note.md')).resolves.toBe(false);
    await expect(second.fs.readFile('/docs/help.md')).resolves.toBe('shared');
    expect(second.mounts[1]).toStrictEqual(mounted.mounts[1]);
  });

  test('rejects overlapping, reserved and noncanonical mount locations', async () => {
    const { workspace } = await setup();
    for (const point of [
      '/',
      'relative',
      '/memories/',
      '/memories/../docs',
      '/dev',
      '/dev/null',
      '/memories/nested',
    ]) {
      expect(() =>
        createMountedFileSystem([
          { access: 'read-write', mountPoint: '/memories', sourceId: 'user', workspace },
          { access: 'read-write', mountPoint: point, sourceId: 'other', workspace },
        ]),
      ).toThrow(/Mount points/u);
    }
  });

  test('rejects directory operations that would copy, delete or move hidden descendants', async () => {
    const { workspace } = await setup();
    await workspace.fs.mkdir('/topic/internal', { recursive: true });
    await workspace.fs.writeFile('/topic/internal/secret.md', 'hidden');
    const mounted = createMountedFileSystem([
      {
        access: 'read-write',
        mountPoint: '/memories',
        sourceId: 'user',
        workspace,
        view: { hiddenRoots: ['/topic/internal'] },
      },
    ]);
    for (const attempt of [
      () => mounted.fs.cp('/memories/topic', '/memories/copy', { recursive: true }),
      () => mounted.fs.mv('/memories/topic', '/memories/moved'),
      () => mounted.fs.rm('/memories/topic', { recursive: true }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    await expect(workspace.fs.readFile('/topic/internal/secret.md')).resolves.toBe('hidden');
    await expect(workspace.fs.exists('/copy')).resolves.toBe(false);
  });

  test('maps scoped sources and rejects moves between independent writable workspaces', async () => {
    const first = await createStorageWorkspace(new MemoryStorage());
    const second = await createStorageWorkspace(new MemoryStorage());
    await first.fs.mkdir('/stored');
    await first.fs.writeFile('/stored/note.md', 'private');
    const mounted = createMountedFileSystem([
      {
        access: 'read-write',
        sourceId: 'first',
        workspace: first,
        mountPoint: '/private/memories',
        view: { root: '/stored', hiddenRoots: ['private', '/private'] },
      },
      { access: 'read-write', sourceId: 'second', workspace: second, mountPoint: '/other' },
    ]);
    expect({
      source: mounted.toSourcePath('/private/memories/note.md'),
      visible: mounted.toVirtualPath('/private/memories', '/stored/note.md'),
      hidden: mounted.mounts[0]?.hiddenRoots,
    }).toStrictEqual({
      source: { mountPoint: '/private/memories', sourceId: 'first', path: '/stored/note.md' },
      visible: '/private/memories/note.md',
      hidden: ['/private'],
    });
    await expect(
      mounted.fs.mv('/private/memories/note.md', '/other/note.md'),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(first.fs.readFile('/stored/note.md')).resolves.toBe('private');
    await expect(second.fs.exists('/note.md')).resolves.toBe(false);
    expect(() =>
      createMountedFileSystem([
        {
          access: 'read-write',
          sourceId: 'first',
          workspace: first,
          mountPoint: '/memory',
          view: { hiddenRoots: ['/'] },
        },
      ]),
    ).toThrow(/cannot hide/u);
  });
});
