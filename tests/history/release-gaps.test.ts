import { describe, expect, test } from 'vitest';

import type { CommitCoordinator, CommitLease } from '../../src/api/commit.ts';
import type { RemoteEntry, ScopedStorage, UploadEntry } from '../../src/core/storage.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import type { HistoryBlobStore } from '../../src/history/blob-store.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('history release guarantees', () => {
  test('rolls an initial incomplete commit back before reopening', async () => {
    const inner = new MemoryStorage();
    const failing = withOneHistoryFault(inner, (key) => key.includes('/revisions/'));
    const workspace = await createStorageWorkspace(failing);
    await workspace.fs.writeFile('/partial.md', 'not published\n');
    await expect(workspace.commit()).rejects.toMatchObject({ code: 'PARTIAL_COMMIT' });
    expect(inner.text('/partial.md')).toBe('not published\n');

    const reopened = await createStorageWorkspace(inner);
    await expect(reopened.fs.exists('/partial.md')).resolves.toBe(false);
    await expect(reopened.history()).resolves.toStrictEqual({ records: [] });
  });

  test('replays a completed commit after head publication failed', async () => {
    const inner = new MemoryStorage();
    const failing = withOneHistoryFault(inner, (key) => key.endsWith('/head.json'));
    const workspace = await createStorageWorkspace(failing);
    await workspace.fs.writeFile('/notes.md', 'published\n');
    const context = { actor: 'test', correlationId: 'retry', idempotencyKey: 'retry-1' };
    await expect(workspace.commit({ context })).rejects.toMatchObject({ code: 'PARTIAL_COMMIT' });
    const replay = await workspace.commit({ context });
    const history = await workspace.history();
    expect({ count: history.records.length, replay: replay.transactionId }).toStrictEqual({
      count: 1,
      replay: history.records[0]?.transactionId,
    });
  });

  test('serializes the final conflict check with the commit lease', async () => {
    const storage = new MemoryStorage();
    const coordinator = new SerialCoordinator();
    const left = await createStorageWorkspace(storage, { coordinator });
    const right = await createStorageWorkspace(storage, { coordinator });
    await left.fs.writeFile('/notes.md', 'left\n');
    await right.fs.writeFile('/notes.md', 'right\n');

    const results = await Promise.allSettled([left.commit(), right.commit()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'COMMIT_CONFLICT' } },
    ]);
  });

  test('serializes open-time recovery with an active commit lease', async () => {
    const inner = new MemoryStorage();
    const gate = gatedUploadStorage(inner);
    const coordinator = new SerialCoordinator();
    const workspace = await createStorageWorkspace(gate.storage, { coordinator });
    await workspace.fs.writeFile('/notes.md', 'published\n');
    const commit = workspace.commit();
    await gate.uploadStarted.promise;

    let opened = false;
    const opening = createStorageWorkspace(inner, { coordinator }).then((value) => {
      opened = true;
      return value;
    });
    expect({ opened, requests: coordinator.requests }).toStrictEqual({
      opened: false,
      requests: 3,
    });

    gate.releaseUpload.resolve(true);
    const [, reopened] = await Promise.all([commit, opening]);
    expect({ opened, text: await reopened.fs.readFile('/notes.md') }).toStrictEqual({
      opened: true,
      text: 'published\n',
    });
  });

  test('does not turn lease release failure into a failed completed commit', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage(), {
      coordinator: releaseFailureCoordinator,
    });
    await workspace.fs.writeFile('/notes.md', 'done\n');
    await expect(workspace.commit()).resolves.toMatchObject({ status: 'complete' });
    await expect(workspace.history()).resolves.toMatchObject({ records: [{ status: 'complete' }] });
  });

  test('does not expose an in-flight intent through history', async () => {
    const inner = new MemoryStorage();
    const initial = await createStorageWorkspace(inner);
    await initial.fs.writeFile('/notes.md', 'one\n');
    const first = await initial.commit();
    const gate = gatedUploadStorage(inner);
    const workspace = await createStorageWorkspace(gate.storage);
    await workspace.fs.writeFile('/notes.md', 'two\n');

    const commit = workspace.commit();
    await gate.uploadStarted.promise;
    try {
      await expect(workspace.history()).resolves.toMatchObject({
        records: [{ revision: first.revision }],
      });
    } finally {
      gate.releaseUpload.resolve();
    }
    const second = await commit;
    await expect(workspace.history()).resolves.toMatchObject({
      records: [{ revision: first.revision }, { revision: second.revision }],
    });
  });

  test('restores and commits after an incomplete transaction is recovered', async () => {
    const inner = new MemoryStorage();
    const workspace = await createStorageWorkspace(inner);
    await workspace.fs.writeFile('/notes.md', 'one\n');
    const first = await workspace.commit();
    await workspace.fs.writeFile('/notes.md', 'two\n');
    await workspace.commit();

    const failing = await createStorageWorkspace(
      withOneHistoryFault(inner, (key) => key.includes('/revisions/')),
    );
    await failing.fs.writeFile('/notes.md', 'partial\n');
    await expect(failing.commit()).rejects.toMatchObject({ code: 'PARTIAL_COMMIT' });

    const recovered = await createStorageWorkspace(inner);
    await expect(recovered.fs.readFile('/notes.md')).resolves.toBe('two\n');
    await recovered.restore(first.revision);
    const restored = await recovered.commit();
    const history = await recovered.history();
    expect({
      history: history.records.length,
      source: restored.metadata?.['sourceRevision'],
      text: await recovered.fs.readFile('/notes.md'),
    }).toStrictEqual({ history: 3, source: first.revision, text: 'one\n' });
  });
});

class SerialCoordinator implements CommitCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  requests = 0;

  async acquire(): Promise<CommitLease> {
    this.requests += 1;
    const previous = this.tail;
    const release = Promise.withResolvers<boolean>();
    this.tail = previous.then(() => release.promise);
    await previous;
    return {
      lost: () => Promise.resolve(false),
      release: () => {
        release.resolve(true);
        return Promise.resolve();
      },
    };
  }
}

const releaseFailureCoordinator: CommitCoordinator = {
  acquire: () =>
    Promise.resolve({
      lost: () => Promise.resolve(false),
      release: () => Promise.reject(new Error('release failed')),
    }),
};

const withOneHistoryFault = (
  inner: MemoryStorage,
  matches: (key: string) => boolean,
): ScopedStorage => {
  let failed = false;
  return {
    delete: (entries: readonly RemoteEntry[]) => inner.delete(entries),
    download: (entry: RemoteEntry) => inner.download(entry),
    head: (path: string) => inner.head(path),
    history: faultOnce(
      inner.history,
      (key) => !failed && matches(key),
      () => {
        failed = true;
      },
    ),
    list: () => inner.list(),
    upload: (entry: UploadEntry) => inner.upload(entry),
  };
};

const faultOnce = (
  inner: HistoryBlobStore,
  matches: (key: string) => boolean,
  markFailed: () => void,
): HistoryBlobStore => ({
  get: (key) => inner.get(key),
  list: (prefix) => inner.list(prefix),
  put: async (key, body) => {
    if (matches(key)) {
      markFailed();
      throw new Error(`history fault: ${key}`);
    }
    await inner.put(key, body);
  },
  remove: (keys) => inner.remove(keys),
});

const gatedUploadStorage = (inner: MemoryStorage) => {
  const releaseUpload = Promise.withResolvers<boolean>();
  const uploadStarted = Promise.withResolvers<boolean>();
  const storage: ScopedStorage = {
    delete: (entries) => inner.delete(entries),
    download: (entry) => inner.download(entry),
    head: (path) => inner.head(path),
    history: inner.history,
    list: () => inner.list(),
    upload: async (entry) => {
      uploadStarted.resolve(true);
      await releaseUpload.promise;
      return inner.upload(entry);
    },
  };
  return { releaseUpload, storage, uploadStarted };
};
