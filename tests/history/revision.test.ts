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
    expect(restored.metadata).toMatchObject({ sourceRevision: first.revision });
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

  test('rejects reuse of an idempotency key for a different commit', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/notes.md', 'alpha\n');
    const context = { actor: 'test', correlationId: 'c1', idempotencyKey: 'job-1' };
    const first = await workspace.commit({ context });
    await workspace.fs.writeFile('/notes.md', 'beta\n');
    await expect(workspace.commit({ context })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(first.transactionId).toBeTypeOf('string');
    expect(storage.text('/notes.md')).toBe('alpha\n');
  });

  test('records moves as one auditable change and one moved diff', async () => {
    const workspace = await createStorageWorkspace(
      new MemoryStorage([{ body: 'move me\n', path: '/old.md' }]),
    );
    const before = await workspace.commit();
    await workspace.fs.mv('/old.md', '/new.md');
    const moved = await workspace.commit();
    const diff = await workspace.diff({
      from: { revision: before.revision },
      to: { revision: moved.revision },
    });
    expect({ changes: moved.changes, diff: diff.entries }).toMatchObject({
      changes: [
        {
          afterSize: 8,
          beforeSize: 8,
          kind: 'move',
          moveFrom: '/old.md',
          moveTo: '/new.md',
          path: '/new.md',
        },
      ],
      diff: [{ kind: 'moved', moveFrom: '/old.md', moveTo: '/new.md', path: '/new.md' }],
    });
  });

  test('normalizes paths in read-only revision views', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/notes.md', 'stored\n');
    const receipt = await workspace.commit();
    const view = await workspace.readRevision(receipt.revision);
    await expect(view.readFile('notes.md')).resolves.toBe('stored\n');
    await expect(view.readFile('/.supabash/head.json')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  test('preserves complete audit fields in receipts and reopened history', async () => {
    const storage = new MemoryStorage([{ body: 'before\n', path: '/notes.md' }]);
    const workspace = await createStorageWorkspace(storage, { scope: 'audit-scope' });
    await workspace.commit();
    await workspace.fs.writeFile('/notes.md', 'after value\n');
    const context = {
      actor: 'reviewer',
      cause: 'update',
      correlationId: 'audit-1',
      idempotencyKey: 'audit-key',
      metadata: { source: 'test' },
    } as const;
    const receipt = await workspace.commit({ context });
    const reopened = await createStorageWorkspace(storage, { scope: 'audit-scope' });
    const history = await reopened.history();
    const record = history.records.at(-1);
    for (const value of [receipt, record]) {
      expect(value).toMatchObject({
        actor: 'reviewer',
        cause: 'update',
        correlationId: 'audit-1',
        idempotencyKey: 'audit-key',
        metadata: { source: 'test' },
        scope: 'audit-scope',
      });
      const change = value?.changes[0];
      expect({
        afterEtag: typeof change?.afterEtag,
        afterHash: typeof change?.afterHash,
        afterSize: change?.afterSize,
        beforeEtag: typeof change?.beforeEtag,
        beforeHash: typeof change?.beforeHash,
        beforeSize: change?.beforeSize,
        kind: change?.kind,
        path: change?.path,
      }).toStrictEqual({
        afterEtag: 'string',
        afterHash: 'string',
        afterSize: 12,
        beforeEtag: 'string',
        beforeHash: 'string',
        beforeSize: 7,
        kind: 'upsert',
        path: '/notes.md',
      });
    }
  });
});
