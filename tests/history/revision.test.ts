import { describe, expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { historyKey } from '../../src/history/keys.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('workspace revisions', () => {
  test('commits an immutable revision that survives reopen', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage, { scope: 'scope-a' });
    await workspace.fs.writeFile('/notes.md', 'alpha\n');
    const receipt = await workspace.commit({ context: { actor: 'test', correlationId: 'corr-1' } });
    expect(receipt.parentRevision).toBeNull();
    expect(receipt.status).toBe('complete');
    const reopened = await createStorageWorkspace(storage, { scope: 'scope-a' });
    const page = await reopened.history();
    const view = await reopened.readRevision(receipt.revision);
    expect({
      historyRevision: page.records[0]?.revision,
      hidden: storage.history.text(historyKey.head)?.includes('"revision"'),
      listed: await reopened.fs.readdir('/'),
      restored: await view.readFile('/notes.md'),
    }).toStrictEqual({
      historyRevision: receipt.revision,
      hidden: true,
      listed: ['notes.md'],
      restored: 'alpha\n',
    });
  });

  test('restores a previous revision as a staged forward change', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/notes.md', 'one\n');
    const first = await workspace.commit();
    await workspace.fs.writeFile('/notes.md', 'two\n');
    await workspace.commit();
    const plan = await workspace.restore(first.revision);
    expect({
      changes: workspace.changes().map(({ kind, path }) => ({ kind, path })),
      live: await workspace.fs.readFile('/notes.md'),
      remote: storage.text('/notes.md'),
      source: plan.sourceRevision,
    }).toStrictEqual({
      changes: [{ kind: 'upsert', path: '/notes.md' }],
      live: 'one\n',
      remote: 'two\n',
      source: first.revision,
    });
    const restored = await workspace.commit();
    expect({
      parent: typeof restored.parentRevision,
      remote: storage.text('/notes.md'),
    }).toStrictEqual({ parent: 'string', remote: 'one\n' });
  });

  test('restores file contents without recreating an unchanged symlink', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/notes.md', 'one\n');
    await workspace.fs.symlink('/notes.md', '/current');
    const first = await workspace.commit();
    await workspace.fs.writeFile('/notes.md', 'two\n');
    await workspace.commit();
    const plan = await workspace.restore(first.revision);
    expect(plan.sourceRevision).toBe(first.revision);
    await expect(workspace.fs.readFile('/notes.md')).resolves.toBe('one\n');
    await expect(workspace.fs.readlink('/current')).resolves.toBe('/notes.md');
  });

  test('restores over a dangling symlink and drops uncommitted extras', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/notes.md', 'one\n');
    await workspace.fs.symlink('/notes.md', '/current');
    const first = await workspace.commit();
    await workspace.fs.rm('/notes.md');
    await workspace.fs.writeFile('/scratch.md', 'temp\n');
    await workspace.restore(first.revision);
    await expect(workspace.fs.readFile('/notes.md')).resolves.toBe('one\n');
    await expect(workspace.fs.readlink('/current')).resolves.toBe('/notes.md');
    await expect(workspace.fs.exists('/scratch.md')).resolves.toBe(false);
  });

  test('replays an idempotent commit without a second transaction', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/notes.md', 'alpha\n');
    const context = { actor: 'test', correlationId: 'c1', idempotencyKey: 'job-1' };
    const first = await workspace.commit({ context });
    await workspace.fs.writeFile('/notes.md', 'beta\n');
    const second = await workspace.commit({ context });
    expect(second.transactionId).toBe(first.transactionId);
    expect(storage.text('/notes.md')).toBe('alpha\n');
  });
});
