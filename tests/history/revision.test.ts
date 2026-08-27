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
    expect(plan.sourceRevision).toBe(first.revision);
    await expect(workspace.fs.readFile('/notes.md')).resolves.toBe('one\n');
    expect(storage.text('/notes.md')).toBe('two\n');
    const restored = await workspace.commit();
    expect(restored.parentRevision).toBeTypeOf('string');
    expect(storage.text('/notes.md')).toBe('one\n');
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
