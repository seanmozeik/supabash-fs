import type { CommitReceipt, Workspace, WorkspaceChange } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import { mapInBatches } from './batches.js';
import { contentTypeForPath } from './content-type.js';
import { comparePaths } from './entry-order.js';
import { sha256 } from './hash.js';
import type { RemoteEntry, ScopedStorage, UploadDraft, UploadEntry } from './storage.js';
import { TrackedFileSystem } from './tracked-file-system.js';

export interface StorageWorkspaceOptions {
  readonly maxFileSystemBytes?: number;
  readonly uploadConcurrency?: number;
}

export const createStorageWorkspace = async (
  storage: ScopedStorage,
  options: StorageWorkspaceOptions = {},
): Promise<Workspace> => {
  const entries = await storage.list();
  const filesystem = await TrackedFileSystem.create(
    entries,
    (entry) => storage.download(entry),
    options.maxFileSystemBytes,
  );
  return new StorageWorkspace(storage, filesystem, options.uploadConcurrency ?? 4);
};

class StorageWorkspace implements Workspace {
  readonly fs: TrackedFileSystem;
  private readonly storage: ScopedStorage;
  private readonly uploadConcurrency: number;

  constructor(storage: ScopedStorage, filesystem: TrackedFileSystem, uploadConcurrency: number) {
    if (!Number.isSafeInteger(uploadConcurrency) || uploadConcurrency < 1) {
      throw new RangeError('uploadConcurrency must be a positive integer.');
    }
    this.storage = storage;
    this.fs = filesystem;
    this.uploadConcurrency = uploadConcurrency;
  }

  async commit(): Promise<CommitReceipt> {
    const pending = this.fs.beginCommit();
    try {
      const uploads = await mapInBatches(pending.upserts, this.uploadConcurrency, async (path) =>
        prepareUpload(await this.fs.uploadEntry(path)),
      );
      await this.assertNoConflicts(pending.deletions, uploads);
      const uploaded = await mapInBatches(uploads, this.uploadConcurrency, (entry) =>
        this.storage.upload(entry),
      );
      await this.storage.delete(pending.deletions);
      this.fs.finishCommit(uploaded);
      return receiptFor(pending.deletions, uploaded);
    } catch (error) {
      this.fs.failCommit();
      throw asSupabashError(error);
    }
  }

  async discard(): Promise<void> {
    await this.fs.discardChanges();
  }

  private async assertNoConflicts(
    deletions: readonly RemoteEntry[],
    uploads: readonly UploadEntry[],
  ): Promise<void> {
    await mapInBatches(deletions, this.uploadConcurrency, async (entry) => {
      const current = await this.storage.head(entry.path);
      if (current !== undefined && !sameRemoteVersion(entry, current)) {
        throw conflict(entry.path);
      }
    });
    await mapInBatches(uploads, this.uploadConcurrency, async (upload) => {
      const baseline = this.fs.baselineEntry(upload.path);
      const current = await this.storage.head(upload.path);
      const uploadAlreadyApplied = current?.versionHash === upload.versionHash;
      const storageChanged =
        baseline === undefined ? current !== undefined : !sameOptionalVersion(baseline, current);
      if (!uploadAlreadyApplied && storageChanged) {
        throw conflict(upload.path);
      }
    });
  }
}

const prepareUpload = async (entry: UploadDraft): Promise<UploadEntry> => {
  const contentHash = await contentHashFor(entry);
  const versionHash = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        contentHash,
        kind: entry.kind,
        mode: entry.mode,
        modifiedAt: entry.modifiedAt.toISOString(),
        target: entry.target,
      }),
    ),
  );
  return {
    ...entry,
    contentHash,
    contentType: entry.contentType ?? contentTypeForPath(entry.path),
    versionHash,
  };
};

const contentHashFor = (entry: UploadDraft): Promise<string> => {
  if (entry.body !== undefined) {
    return sha256(entry.body);
  }
  return sha256(new TextEncoder().encode(entry.target ?? ''));
};

const sameOptionalVersion = (baseline: RemoteEntry, current: RemoteEntry | undefined): boolean =>
  current !== undefined && sameRemoteVersion(baseline, current);

const sameRemoteVersion = (baseline: RemoteEntry, current: RemoteEntry): boolean => {
  if (baseline.kind !== current.kind) {
    return false;
  }
  if (baseline.etag !== undefined && current.etag !== undefined) {
    return baseline.etag === current.etag;
  }
  if (baseline.versionHash !== undefined && current.versionHash !== undefined) {
    return baseline.versionHash === current.versionHash;
  }
  return (
    baseline.size === current.size && baseline.modifiedAt.getTime() === current.modifiedAt.getTime()
  );
};

const receiptFor = (
  deletions: readonly RemoteEntry[],
  uploads: readonly RemoteEntry[],
): CommitReceipt => ({
  changes: [
    ...deletions.map((entry) => changeForDelete(entry)),
    ...uploads.map((entry) => changeForUpload(entry)),
  ].toSorted((left, right) => comparePaths(left.path, right.path)),
  committedAt: new Date(),
  revision: crypto.randomUUID(),
});

const changeForDelete = (entry: RemoteEntry): WorkspaceChange => ({
  entryKind: entry.kind,
  kind: 'delete',
  path: entry.path,
});

const changeForUpload = (entry: RemoteEntry): WorkspaceChange => ({
  ...(entry.contentHash !== undefined && { contentHash: entry.contentHash }),
  entryKind: entry.kind,
  ...(entry.etag !== undefined && { etag: entry.etag }),
  kind: 'upsert',
  path: entry.path,
});

const conflict = (path: string): SupabashError =>
  new SupabashError('COMMIT_CONFLICT', 'Stored entry changed after the workspace opened.', {
    path,
  });

const asSupabashError = (error: unknown): SupabashError =>
  error instanceof SupabashError
    ? error
    : new SupabashError('STORAGE', 'Workspace storage operation failed.', { cause: error });
