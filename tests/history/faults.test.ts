import { describe, expect, test } from 'vitest';

import type { CommitCoordinator, CommitLease } from '../../src/api/commit.ts';
import type { SupabashError } from '../../src/api/errors.ts';
import type { ScopedStorage } from '../../src/core/storage.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import type { HistoryBlobStore } from '../../src/history/blob-store.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('workspace publish faults', () => {
  test('fails with COMMIT_COORDINATION when the lease is lost before publish', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage(), {
      coordinator: new CountLeaseCoordinator(1),
    });
    await workspace.fs.writeFile('/notes.md', 'alpha\n');
    await expect(workspace.commit()).rejects.toMatchObject({ code: 'COMMIT_COORDINATION' });
  });

  test('reports PARTIAL_COMMIT when head publication fails after visible writes', async () => {
    const inner = new MemoryStorage();
    const workspace = await createStorageWorkspace(
      withHistoryFault(inner, (key) => key.endsWith('head.json')),
    );
    await workspace.fs.writeFile('/notes.md', 'alpha\n');
    await expect(workspace.commit()).rejects.toMatchObject(partialError());
    expect(inner.text('/notes.md')).toBe('alpha\n');
  });

  test('keeps the last complete revision readable after a later partial commit', async () => {
    const inner = new MemoryStorage();
    const first = await createStorageWorkspace(inner);
    await first.fs.writeFile('/notes.md', 'one\n');
    const committed = await first.commit();
    const second = await createStorageWorkspace(
      withHistoryFault(inner, (key) => key.endsWith('head.json')),
    );
    await second.fs.writeFile('/notes.md', 'two\n');
    await expect(second.commit()).rejects.toMatchObject(partialError());
    const recovered = await createStorageWorkspace(inner);
    const view = await recovered.readRevision(committed.revision);
    const page = await recovered.history();
    expect({
      headFile: await recovered.fs.readFile('/notes.md'),
      historyCount: page.records.length,
      previous: await view.readFile('/notes.md'),
    }).toStrictEqual({ headFile: 'two\n', historyCount: 2, previous: 'one\n' });
  });
});

class CountLeaseCoordinator implements CommitCoordinator {
  private readonly loseOn: number;

  constructor(loseOn: number) {
    this.loseOn = loseOn;
  }

  acquire(): Promise<CommitLease> {
    let calls = 0;
    const { loseOn } = this;
    return Promise.resolve({
      lost: () => {
        calls += 1;
        return Promise.resolve(calls >= loseOn);
      },
      release: () => Promise.resolve(),
    });
  }
}

const withHistoryFault = (
  inner: MemoryStorage,
  failOn: (key: string) => boolean,
): ScopedStorage => ({
  delete: (entries) => inner.delete(entries),
  download: (entry) => inner.download(entry),
  head: (path) => inner.head(path),
  history: faultHistory(inner.history, failOn),
  list: () => inner.list(),
  upload: (entry) => inner.upload(entry),
});

const faultHistory = (
  inner: HistoryBlobStore,
  failOn: (key: string) => boolean,
): HistoryBlobStore => ({
  get: (key) => inner.get(key),
  list: (prefix) => inner.list(prefix),
  put: async (key, body) => {
    if (failOn(key)) {
      throw new Error(`history fault: ${key}`);
    }
    await inner.put(key, body);
  },
  remove: (keys) => inner.remove(keys),
});

const partialError = (): Partial<SupabashError> => ({ code: 'PARTIAL_COMMIT' });
