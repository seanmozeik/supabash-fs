import { describe, expect, test, vi } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { preserveAncestry, retainedChain } from '../../src/history/ancestry.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('retained Storage ancestry', () => {
  test('paginates checkpointed revisions across repeated purge gaps after reopening', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    // Equal timestamps cannot establish commit order; ancestry must do so.
    const clock = vi.useFakeTimers({ toFake: ['Date'] });
    clock.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      await workspace.fs.writeFile('/memory.md', 'A');
      const first = await workspace.commit();
      const checkpoint = await workspace.checkpoint();
      await workspace.fs.writeFile('/memory.md', 'B');
      const second = await workspace.commit();
      await workspace.fs.writeFile('/memory.md', 'C');
      const third = await workspace.commit();
      await workspace.purge({ maxRevisions: 1 });

      const reopened = await createStorageWorkspace(storage);
      const recovered = await reopened.history({ cursor: second.cursor, cursorMissing: 'oldest' });
      expect(recovered.records.map((record) => record.revision)).toStrictEqual([
        first.revision,
        third.revision,
      ]);
      const page = await reopened.history({
        cursor: second.cursor,
        cursorMissing: 'oldest',
        limit: 1,
      });
      const rest = await reopened.history({ cursor: first.cursor, limit: 1 });
      expect({
        first: page.records.map((record) => record.revision),
        next: page.nextCursor,
        rest: rest.records.map((record) => record.revision),
        end: rest.nextCursor,
      }).toStrictEqual({
        first: [first.revision],
        next: first.cursor,
        rest: [third.revision],
        end: undefined,
      });
      await reopened.deleteCheckpoint(checkpoint.checkpointId);
      // Counts and retention floors also cross gaps without counting missing revisions.
      await reopened.purge({ maxRevisions: 2 });
      await reopened.purge({ maxRevisions: 0, keepAfterRevision: first.revision });
      await expect(reopened.readRevision(first.revision)).resolves.toMatchObject({
        revision: first.revision,
      });
      await reopened.fs.writeFile('/memory.md', 'D');
      const fourth = await reopened.commit();
      await reopened.purge({ maxRevisions: 1 });
      const final = await reopened.history();
      expect(final.records.map((record) => record.revision)).toStrictEqual([fourth.revision]);
    } finally {
      clock.useRealTimers();
    }
  });

  test('does not write ancestry during dry-run or delete before ancestry is durable', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/memory.md', 'A');
    const first = await workspace.commit();
    await workspace.fs.writeFile('/memory.md', 'B');
    const second = await workspace.commit();
    await workspace.purge({ maxRevisions: 1, dryRun: true });
    await expect(storage.history.list('.supabash/ancestry/')).resolves.toStrictEqual([]);
    const put = vi
      .spyOn(storage.history, 'put')
      .mockRejectedValue(new Error('ancestry write failed'));
    try {
      await expect(workspace.purge({ maxRevisions: 1 })).rejects.toThrow('ancestry write failed');
      const history = await workspace.history();
      expect(history.records.map((record) => record.revision)).toStrictEqual([
        first.revision,
        second.revision,
      ]);
      await expect(workspace.readRevision(first.revision)).resolves.toMatchObject({
        revision: first.revision,
      });
    } finally {
      put.mockRestore();
    }
  });

  test('rejects cycles through purged links and never retains missing records', async () => {
    const storage = new MemoryStorage();
    const records = [{ revision: 'C', parentRevision: 'B' }];
    await expect(retainedChain(storage.history, records, 'C')).resolves.toStrictEqual(records);
    await preserveAncestry(storage.history, [{ revision: 'B', parentRevision: 'C' }]);
    await expect(retainedChain(storage.history, records, 'C')).rejects.toMatchObject({
      code: 'HISTORY_CORRUPTION',
    });
  });

  test('does not checkpoint a head whose revision manifest is missing', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/memory.md', 'A');
    const first = await workspace.commit();
    await storage.history.remove([`.supabash/revisions/${first.revision}.json`]);
    await expect(workspace.checkpoint()).rejects.toMatchObject({ code: 'HISTORY_CORRUPTION' });
    await expect(workspace.checkpoints()).resolves.toStrictEqual([]);
  });
});
