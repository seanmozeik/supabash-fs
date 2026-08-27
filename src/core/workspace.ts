import type { CommitCoordinator, CommitOptions } from '../api/commit.js';
import type { CommitReceipt, Workspace, WorkspaceChange } from '../api/contracts.js';
import type {
  CheckpointOptions,
  CheckpointReceipt,
  CheckpointRecord,
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
import { createCheckpoint, listCheckpoints, removeCheckpoint } from '../history/checkpoint.js';
import { diffRevisions } from '../history/diff.js';
import { commitFingerprint } from '../history/fingerprint.js';
import type { WorkspaceLimits } from '../history/limits.js';
import {
  existingIdempotentReceipt,
  finalizePublish,
  receiptForTransaction,
  withLease,
  writeIntent,
} from '../history/publish.js';
import { purgeHistory } from '../history/purge.js';
import { readHistoryPage } from '../history/query.js';
import { assertCommitQuotas } from '../history/quota.js';
import { readRevisionView } from '../history/readonly.js';
import { recoverWorkspace } from '../history/recover.js';
import { planRestore } from '../history/restore.js';
import { overlayByPath } from '../history/snapshot.js';
import { mapInBatches } from './batches.js';
import type { PendingChanges, RemoteEntry, ScopedStorage, UploadEntry } from './storage.js';
import { TrackedFileSystem } from './tracked-file-system.js';
import {
  asSupabashError,
  committedWorkspaceChanges,
  conflictError,
  mergeAuditBaseline,
  partialCommitError,
  prepareUpload,
  previewWorkspaceChanges,
  remoteAsRevision,
  resolvedCommitContext,
  sameRemoteVersion,
  visibleEntryCount,
} from './workspace-changes.js';
import { validateWorkspaceConfiguration } from './workspace-options.js';

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
  validateWorkspaceConfiguration(options);
  await withLease(options.coordinator, options.scope ?? 'local', crypto.randomUUID(), () =>
    recoverWorkspace(storage),
  );
  const filesystem = await TrackedFileSystem.create(
    await storage.list(),
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
  private partialTransactionId: string | undefined;
  private restoreSourceRevision: string | undefined;

  constructor(
    storage: ScopedStorage,
    filesystem: TrackedFileSystem,
    options: StorageWorkspaceOptions,
  ) {
    const uploadConcurrency = options.uploadConcurrency ?? 4;
    this.storage = storage;
    this.fs = filesystem;
    this.uploadConcurrency = uploadConcurrency;
    this.scope = options.scope ?? 'local';
    this.coordinator = options.coordinator;
    this.limits = options.limits ?? {};
  }

  changes(): readonly WorkspaceChange[] {
    return previewWorkspaceChanges(this.fs.pendingPreview(), (path) => this.fs.kindOf(path));
  }

  checkpoint(options: CheckpointOptions = {}): Promise<CheckpointReceipt> {
    return createCheckpoint(this.storage.history, options);
  }

  checkpoints(): Promise<readonly CheckpointRecord[]> {
    return listCheckpoints(this.storage.history);
  }

  async commit(options: CommitOptions = {}): Promise<CommitReceipt> {
    const context = resolvedCommitContext(options.context, this.restoreSourceRevision);
    const pending = this.fs.beginCommit();
    const publish = { intentWritten: false };
    const transactionId = crypto.randomUUID();
    try {
      const uploads = await mapInBatches(pending.upserts, this.uploadConcurrency, async (path) =>
        prepareUpload(await this.fs.uploadEntry(path)),
      );
      const auditBaseline = await this.auditBaseline(pending);
      const plannedChanges = this.changesFrom(pending, uploads, auditBaseline);
      const fingerprint = await commitFingerprint(plannedChanges, context);
      const revision = crypto.randomUUID();
      return await withLease(this.coordinator, this.scope, transactionId, async (lost) => {
        let publishChanges = pending;
        if (await recoverWorkspace(this.storage)) {
          this.fs.refreshBaseline(await this.storage.list());
          publishChanges = this.fs.pendingPreview();
        }
        const prior =
          this.partialTransactionId === undefined
            ? undefined
            : await receiptForTransaction(
                this.storage.history,
                this.partialTransactionId,
                this.scope,
                fingerprint,
              );
        if (prior !== undefined) {
          await this.finishPublishedCommit();
          return prior;
        }
        const replay = await existingIdempotentReceipt(
          this.storage.history,
          context,
          this.scope,
          fingerprint,
        );
        if (replay !== undefined) {
          await this.finishPublishedCommit();
          return replay;
        }
        await this.assertNoConflicts(publishChanges.deletions, uploads);
        const baseline = await this.storage.list();
        const changeBaseline = mergeAuditBaseline(baseline, auditBaseline);
        const changes = this.changesFrom(publishChanges, uploads, changeBaseline);
        assertCommitQuotas(
          uploads,
          publishChanges.deletions,
          visibleEntryCount(baseline, publishChanges.deletions, uploads),
          context.metadata,
          this.limits,
        );
        const publishInput = {
          baseline,
          changes,
          context,
          deletions: publishChanges.deletions,
          fingerprint,
          history: this.storage.history,
          scope: this.scope,
          storage: this.storage,
        };
        const intent = await writeIntent(publishInput, transactionId, revision);
        publish.intentWritten = true;
        const uploaded = await mapInBatches(uploads, this.uploadConcurrency, (entry) =>
          this.storage.upload(entry),
        );
        await this.storage.delete(publishChanges.deletions);
        const receipt = await finalizePublish(
          {
            ...publishInput,
            changes: this.changesFrom(publishChanges, uploaded, changeBaseline),
            uploads: uploaded,
          },
          intent,
          lost,
        );
        await this.finishPublishedCommit();
        return receipt;
      });
    } catch (error) {
      if (publish.intentWritten) {
        this.partialTransactionId = transactionId;
      }
      this.fs.failCommit();
      throw publish.intentWritten ? partialCommitError(error) : asSupabashError(error);
    }
  }

  deleteCheckpoint(checkpointId: string): Promise<void> {
    return removeCheckpoint(this.storage.history, checkpointId);
  }

  async discard(): Promise<void> {
    if (this.partialTransactionId === undefined) {
      await this.fs.discardChanges();
    } else {
      await withLease(this.coordinator, this.scope, this.partialTransactionId, () =>
        recoverWorkspace(this.storage),
      );
      await this.fs.finishCommit(await this.storage.list());
      this.partialTransactionId = undefined;
    }
    this.restoreSourceRevision = undefined;
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

  async restore(revision: string): Promise<RestorePlan> {
    const plan = await planRestore(this.storage.history, this.fs, revision);
    this.restoreSourceRevision = plan.sourceRevision;
    return plan;
  }

  private changesFrom(
    pending: PendingChanges,
    uploads: readonly (RemoteEntry | UploadEntry)[],
    baseline: readonly RemoteEntry[],
  ): readonly WorkspaceChange[] {
    return committedWorkspaceChanges(pending, uploads, baseline, (path) =>
      this.fs.baselineEntry(path),
    );
  }

  private async finishPublishedCommit(): Promise<void> {
    await this.fs.finishCommit(await this.storage.list());
    this.partialTransactionId = undefined;
    this.restoreSourceRevision = undefined;
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

  private async auditBaseline(pending: PendingChanges): Promise<readonly RemoteEntry[]> {
    const touched = new Set([
      ...pending.deletions.map((entry) => entry.path),
      ...pending.moves.map((move) => move.from),
      ...pending.upserts,
    ]);
    const baseline = new Map(this.fs.baselineEntries().map((entry) => [entry.path, entry]));
    for (const path of touched) {
      const entry = await this.fs.baselineEntryForAudit(path);
      if (entry !== undefined) {
        baseline.set(path, entry);
      }
    }
    return [...baseline.values()];
  }

  private async assertNoConflicts(
    deletions: readonly RemoteEntry[],
    uploads: readonly UploadEntry[],
  ): Promise<void> {
    await mapInBatches(deletions, this.uploadConcurrency, async (entry) => {
      const current = await this.storage.head(entry.path);
      if (current !== undefined && !sameRemoteVersion(entry, current)) {
        throw conflictError(entry.path);
      }
    });
    await mapInBatches(uploads, this.uploadConcurrency, async (upload) => {
      const baseline = this.fs.baselineEntry(upload.path);
      const current = await this.storage.head(upload.path);
      const uploadAlreadyApplied = current?.versionHash === upload.versionHash;
      const storageChanged =
        baseline === undefined
          ? current !== undefined
          : current === undefined || !sameRemoteVersion(baseline, current);
      if (!uploadAlreadyApplied && storageChanged) {
        throw conflictError(upload.path);
      }
    });
  }
}
