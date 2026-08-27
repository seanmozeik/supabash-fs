import type { CommitContext, CommitCoordinator, CommitOptions } from '../api/commit.js';
import type { CommitReceipt, Workspace, WorkspaceChange } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type {
  CheckpointOptions,
  CheckpointReceipt,
  HistoryPage,
  HistoryQuery,
  PurgeOptions,
  PurgeReceipt,
  ReadonlyWorkspaceView,
  RestorePlan,
  RevisionDiff,
  RevisionDiffInput,
  RevisionEntry,
} from '../api/history.js';
import { createCheckpoint } from '../history/checkpoint.js';
import { diffRevisions } from '../history/diff.js';
import type { WorkspaceLimits } from '../history/limits.js';
import {
  existingIdempotentReceipt,
  finalizePublish,
  withLease,
  writeIntent,
} from '../history/publish.js';
import { purgeHistory } from '../history/purge.js';
import { readHistoryPage } from '../history/query.js';
import { assertCommitQuotas } from '../history/quota.js';
import { readRevisionView } from '../history/readonly.js';
import { planRestore } from '../history/restore.js';
import { overlayByPath } from '../history/snapshot.js';
import { mapInBatches } from './batches.js';
import { contentTypeForPath } from './content-type.js';
import { comparePaths } from './entry-order.js';
import { sha256 } from './hash.js';
import type { RemoteEntry, ScopedStorage, UploadDraft, UploadEntry } from './storage.js';
import { TrackedFileSystem } from './tracked-file-system.js';

export interface StorageWorkspaceOptions {
  readonly coordinator?: CommitCoordinator;
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly scope?: string;
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
  return new StorageWorkspace(storage, filesystem, options);
};

class StorageWorkspace implements Workspace {
  readonly fs: TrackedFileSystem;
  private readonly coordinator: CommitCoordinator | undefined;
  private readonly limits: WorkspaceLimits;
  private readonly scope: string;
  private readonly storage: ScopedStorage;
  private readonly uploadConcurrency: number;

  constructor(
    storage: ScopedStorage,
    filesystem: TrackedFileSystem,
    options: StorageWorkspaceOptions,
  ) {
    const uploadConcurrency = options.uploadConcurrency ?? 4;
    if (!Number.isSafeInteger(uploadConcurrency) || uploadConcurrency < 1) {
      throw new RangeError('uploadConcurrency must be a positive integer.');
    }
    this.storage = storage;
    this.fs = filesystem;
    this.uploadConcurrency = uploadConcurrency;
    this.scope = options.scope ?? 'local';
    this.coordinator = options.coordinator;
    this.limits = options.limits ?? {};
  }

  changes(): readonly WorkspaceChange[] {
    const pending = this.fs.pendingPreview();
    return [
      ...pending.deletions.map(changeForDelete),
      ...pending.upserts.map((path) => ({
        entryKind: this.fs.kindOf(path),
        kind: 'upsert' as const,
        path,
      })),
    ].toSorted((left, right) => comparePaths(left.path, right.path));
  }

  checkpoint(options: CheckpointOptions = {}): Promise<CheckpointReceipt> {
    return createCheckpoint(this.storage.history, options);
  }

  async commit(options: CommitOptions = {}): Promise<CommitReceipt> {
    const context = commitContext(options.context);
    const replay = await existingIdempotentReceipt(this.storage.history, context, this.scope);
    if (replay !== undefined) {
      return replay;
    }
    const pending = this.fs.beginCommit();
    const publish = { intentWritten: false };
    try {
      const uploads = await mapInBatches(pending.upserts, this.uploadConcurrency, async (path) =>
        prepareUpload(await this.fs.uploadEntry(path)),
      );
      assertCommitQuotas(
        uploads,
        pending.deletions,
        visibleCount(this.fs.baselineEntries(), pending.deletions, uploads),
        context.metadata,
        this.limits,
      );
      await this.assertNoConflicts(pending.deletions, uploads);
      const transactionId = crypto.randomUUID();
      const revision = crypto.randomUUID();
      return await withLease(this.coordinator, this.scope, transactionId, async (lost) => {
        const publishInput = {
          baseline: this.fs.baselineEntries(),
          changes: this.changesFrom(pending, uploads),
          context,
          deletions: pending.deletions,
          history: this.storage.history,
          scope: this.scope,
          storage: this.storage,
        };
        const intent = await writeIntent(publishInput, transactionId, revision);
        publish.intentWritten = true;
        const uploaded = await mapInBatches(uploads, this.uploadConcurrency, (entry) =>
          this.storage.upload(entry),
        );
        await this.storage.delete(pending.deletions);
        const receipt = await finalizePublish({ ...publishInput, uploads: uploaded }, intent, lost);
        this.fs.finishCommit(uploaded);
        return receipt;
      });
    } catch (error) {
      this.fs.failCommit();
      throw publish.intentWritten ? partial(error) : asSupabashError(error);
    }
  }

  discard(): Promise<void> {
    return this.fs.discardChanges();
  }

  async diff(input: RevisionDiffInput): Promise<RevisionDiff> {
    return diffRevisions(
      this.storage.history,
      input,
      { entries: await this.stagedEntries(), label: 'staged' },
      this.limits,
    );
  }

  history(query?: HistoryQuery): Promise<HistoryPage> {
    return readHistoryPage(this.storage.history, this.scope, query, this.limits);
  }

  purge(options: PurgeOptions): Promise<PurgeReceipt> {
    return purgeHistory(this.storage.history, options);
  }

  readRevision(revision: string): Promise<ReadonlyWorkspaceView> {
    return readRevisionView(this.storage.history, revision);
  }

  restore(revision: string): Promise<RestorePlan> {
    return planRestore(this.storage.history, this.fs, revision);
  }

  private changesFrom(
    pending: { deletions: readonly RemoteEntry[]; upserts: readonly string[] },
    uploads: readonly UploadEntry[],
  ): readonly WorkspaceChange[] {
    const uploaded = new Map(uploads.map((entry) => [entry.path, entry]));
    return [
      ...pending.deletions.map(changeForDelete),
      ...pending.upserts.map((path) =>
        changeForUpload(uploaded.get(path) ?? this.fs.baselineEntry(path)),
      ),
    ].toSorted((left, right) => comparePaths(left.path, right.path));
  }

  private async stagedEntries(): Promise<readonly RevisionEntry[]> {
    const pending = this.fs.pendingPreview();
    const upserts: RevisionEntry[] = [];
    for (const path of pending.upserts) {
      const draft = await this.fs.uploadEntry(path);
      upserts.push({
        entryKind: draft.kind,
        mode: draft.mode,
        path: draft.path,
        size: draft.body?.byteLength ?? 0,
        ...(draft.contentHash !== undefined && { contentHash: draft.contentHash }),
        ...(draft.target !== undefined && { target: draft.target }),
      });
    }
    return overlayByPath(
      this.fs.baselineEntries().map((entry) => remoteAsRevision(entry)),
      pending.deletions,
      upserts,
    );
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

const visibleCount = (
  baseline: readonly RemoteEntry[],
  deletions: readonly RemoteEntry[],
  uploads: readonly UploadEntry[],
): number => {
  const deleted = new Set(deletions.map((entry) => entry.path));
  const visible = new Set(baseline.map((entry) => entry.path).filter((path) => !deleted.has(path)));
  for (const upload of uploads) {
    visible.add(upload.path);
  }
  return visible.size;
};

const sameOptionalVersion = (baseline: RemoteEntry, current: RemoteEntry | undefined): boolean =>
  current !== undefined && sameRemoteVersion(baseline, current);

const sameRemoteVersion = (baseline: RemoteEntry, current: RemoteEntry): boolean => {
  if (baseline.etag !== undefined || current.etag !== undefined) {
    return baseline.etag === current.etag;
  }
  if (baseline.versionHash !== undefined || current.versionHash !== undefined) {
    return baseline.versionHash === current.versionHash;
  }
  return (
    baseline.size === current.size && baseline.modifiedAt.getTime() === current.modifiedAt.getTime()
  );
};

const changeForDelete = (entry: RemoteEntry): WorkspaceChange => ({
  entryKind: entry.kind,
  kind: 'delete',
  path: entry.path,
  ...(entry.contentHash !== undefined && {
    beforeHash: entry.contentHash,
    contentHash: entry.contentHash,
  }),
  ...(entry.etag !== undefined && { etag: entry.etag }),
  beforeSize: entry.size,
});

const changeForUpload = (entry: RemoteEntry | UploadEntry | undefined): WorkspaceChange => {
  if (entry === undefined) {
    throw new SupabashError('STORAGE', 'Upload is missing from the commit set.');
  }
  const etag = 'etag' in entry ? entry.etag : undefined;
  const afterSize = 'size' in entry ? entry.size : entry.body?.byteLength;
  return {
    entryKind: entry.kind,
    kind: 'upsert',
    path: entry.path,
    ...(entry.contentHash !== undefined && {
      afterHash: entry.contentHash,
      contentHash: entry.contentHash,
    }),
    ...(etag !== undefined && { etag }),
    ...(afterSize !== undefined && { afterSize }),
  };
};

const remoteAsRevision = (entry: RemoteEntry): RevisionEntry => ({
  entryKind: entry.kind,
  mode: entry.mode,
  path: entry.path,
  size: entry.size,
  ...(entry.contentHash !== undefined && { contentHash: entry.contentHash }),
  ...(entry.etag !== undefined && { etag: entry.etag }),
  ...(entry.target !== undefined && { target: entry.target }),
});

const commitContext = (context: CommitContext | undefined): CommitContext =>
  context ?? { actor: 'workspace', correlationId: crypto.randomUUID() };

const conflict = (path: string): SupabashError =>
  new SupabashError('COMMIT_CONFLICT', 'Stored entry changed after the workspace opened.', {
    path,
  });

const partial = (error: unknown): SupabashError =>
  new SupabashError('PARTIAL_COMMIT', 'Commit did not finish publishing a complete revision.', {
    cause: asSupabashError(error),
  });

const asSupabashError = (error: unknown): SupabashError =>
  error instanceof SupabashError
    ? error
    : new SupabashError('STORAGE', 'Workspace storage operation failed.', { cause: error });
