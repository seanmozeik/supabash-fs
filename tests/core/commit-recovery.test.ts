import { describe, expect, test } from 'vitest';

import type { SupabashError } from '../../src/api/errors.ts';
import type { RemoteEntry, ScopedStorage, UploadEntry } from '../../src/core/storage.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('workspace commit recovery', () => {
  test('retries safely after uploads succeed and deletion fails', async () => {
    const inner = new MemoryStorage([
      { body: 'old value\n', path: '/keep.md' },
      { body: 'remove me\n', path: '/remove.md' },
    ]);
    const storage = new DeleteOnceStorage(inner);
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/keep.md', 'new value\n');
    await workspace.fs.rm('/remove.md');

    await expect(workspace.commit()).rejects.toMatchObject(storageError());
    expect({ kept: inner.text('/keep.md'), removed: inner.text('/remove.md') }).toStrictEqual({
      kept: 'new value\n',
      removed: 'remove me\n',
    });

    const receipt = await workspace.commit();
    expect({
      changes: receipt.changes.map(({ kind, path }) => ({ kind, path })),
      kept: inner.text('/keep.md'),
      removed: inner.text('/remove.md'),
      uploadPaths: [...new Set(storage.uploads)].toSorted(),
    }).toStrictEqual({
      changes: [
        { kind: 'upsert', path: '/keep.md' },
        { kind: 'delete', path: '/remove.md' },
      ],
      kept: 'new value\n',
      removed: undefined,
      uploadPaths: ['/keep.md', '/remove.md'],
    });
  });

  test('blocks filesystem mutation while a commit is running', async () => {
    const gate = gatedUploadStorage(new MemoryStorage());
    const workspace = await createStorageWorkspace(gate.storage);
    await workspace.fs.writeFile('/entry.md', 'value\n');

    const commit = workspace.commit();
    await gate.uploadStarted.promise;
    try {
      await expect(workspace.fs.writeFile('/late.md', 'late\n')).rejects.toMatchObject(
        commitInProgressError(),
      );
    } finally {
      gate.releaseUpload.resolve(true);
    }
    await expect(commit).resolves.toMatchObject({
      changes: [{ kind: 'upsert', path: '/entry.md' }],
    });
  });

  test('blocks discard while a commit is running', async () => {
    const gate = gatedUploadStorage(new MemoryStorage());
    const workspace = await createStorageWorkspace(gate.storage);
    await workspace.fs.writeFile('/entry.md', 'value\n');

    const commit = workspace.commit();
    await gate.uploadStarted.promise;
    try {
      await expect(workspace.discard()).rejects.toMatchObject(commitInProgressError());
      await expect(workspace.fs.writeFile('/late.md', 'late\n')).rejects.toMatchObject(
        commitInProgressError(),
      );
    } finally {
      gate.releaseUpload.resolve(true);
    }
    await expect(commit).resolves.toMatchObject({
      changes: [{ kind: 'upsert', path: '/entry.md' }],
    });
  });
});

class DeleteOnceStorage implements ScopedStorage {
  readonly uploads: string[] = [];
  private deleteShouldFail = true;
  private readonly inner: MemoryStorage;

  constructor(inner: MemoryStorage) {
    this.inner = inner;
  }

  get history() {
    return this.inner.history;
  }

  list(): Promise<readonly RemoteEntry[]> {
    return this.inner.list();
  }

  download(entry: RemoteEntry): Promise<Uint8Array> {
    return this.inner.download(entry);
  }

  head(path: string): Promise<RemoteEntry | undefined> {
    return this.inner.head(path);
  }

  upload(entry: UploadEntry): Promise<RemoteEntry> {
    this.uploads.push(entry.path);
    return this.inner.upload(entry);
  }

  delete(entries: readonly RemoteEntry[]): Promise<void> {
    if (this.deleteShouldFail) {
      this.deleteShouldFail = false;
      return Promise.reject(new Error('delete failed'));
    }
    return this.inner.delete(entries);
  }
}

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

const storageError = (): Partial<SupabashError> => ({ code: 'PARTIAL_COMMIT' });

const commitInProgressError = (): Partial<SupabashError> => ({ code: 'COMMIT_IN_PROGRESS' });
