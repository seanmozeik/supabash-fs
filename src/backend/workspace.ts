import type { CommitOptions } from '../api/commit.js';
import type { CommitReceipt, WorkspaceChange } from '../api/contracts.js';
import type { TextDocumentCodec } from '../api/document-codec.js';
import { isSupabashError, isUnknownOutcomeSupabashError, SupabashError } from '../api/errors.js';
import type {
  CheckpointOptions,
  CheckpointReceipt,
  CheckpointRecord,
  HistoryPage,
  HistoryQuery,
  PurgeOptions,
  PurgeReceipt,
  RedactOptions,
  RedactReceipt,
  ReadonlyWorkspaceView,
  RestorePlan,
  RevisionDiff,
  RevisionDiffInput,
} from '../api/history.js';
import type { WorkspaceObservability } from '../api/observability.js';
import {
  POSTGRES_WORKSPACE_CAPABILITIES,
  type PostgresWorkspace,
  type PostgresWorkspaceSnapshot,
} from '../api/postgres.js';
import { startOperation } from '../core/observability.js';
import type { TrackedFileSystem } from '../core/tracked-file-system.js';
import {
  committedWorkspaceChanges,
  resolvedCommitContext,
  visibleEntryCount,
} from '../core/workspace-changes.js';
import { validateWorkspaceConfiguration } from '../core/workspace-options.js';
import { commitFingerprint } from '../history/fingerprint.js';
import type { WorkspaceLimits } from '../history/limits.js';
import {
  assertCommitQuotas,
  diffPreviewLimit,
  historyPageLimit,
  normalizePurgeOptions,
} from '../history/quota.js';
import { commitAttempt, type PendingCommitAttempt } from './commit-attempt.js';
import { committedTree } from './committed-tree.js';
import type { PinnedSnapshot, WorkspaceBackend } from './contracts.js';
import { persistentPending } from './pending.js';
import { publicSnapshot } from './public-snapshot.js';
import {
  bodyLoader,
  entriesFrom,
  projectSnapshot,
  readonlyView,
  requireRevision,
  snapshotDetails,
  snapshotFromFileSystem,
  type TextTreeProjection,
} from './text-tree.js';
import { mutationsFrom, prepareChanges, publicChanges } from './workspace-mutations.js';

export interface BackendWorkspaceOptions {
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly observability?: WorkspaceObservability;
}

export const createBackendWorkspace = async (
  backend: WorkspaceBackend,
  options: BackendWorkspaceOptions = {},
): Promise<PostgresWorkspace> => {
  validateWorkspaceConfiguration(options);
  const snapshot = await backend.loadSnapshot();
  const timer = startOperation(
    options.observability,
    backend.capabilities.backend,
    'filesystem-projection',
  );
  try {
    const projection = await projectSnapshot(snapshot, options.maxFileSystemBytes);
    timer.success(snapshotDetails(snapshot));
    return new BackendWorkspace(backend, projection, snapshot, options);
  } catch (error) {
    timer.failure(error, snapshotDetails(snapshot));
    throw error;
  }
};

class BackendWorkspace implements PostgresWorkspace {
  readonly capabilities;
  readonly fs: TrackedFileSystem;
  private readonly backend: WorkspaceBackend;
  private readonly documentCodec: TextDocumentCodec;
  private readonly limits: WorkspaceLimits;
  private readonly replaceSnapshotBodies: TextTreeProjection['replaceSnapshotBodies'];
  private pendingCommit: PendingCommitAttempt | undefined;
  private redactionInvalidated = false;
  private restoreSourceRevision: string | undefined;
  private snapshot: PinnedSnapshot;

  constructor(
    backend: WorkspaceBackend,
    projection: TextTreeProjection,
    snapshot: PinnedSnapshot,
    options: BackendWorkspaceOptions,
  ) {
    if (backend.capabilities.backend !== 'postgres') {
      throw new SupabashError('STORAGE', 'The text workspace requires a Postgres backend.');
    }
    this.backend = backend;
    this.documentCodec = backend.documentCodec;
    this.capabilities = POSTGRES_WORKSPACE_CAPABILITIES;
    this.fs = projection.filesystem;
    this.replaceSnapshotBodies = projection.replaceSnapshotBodies;
    this.snapshot = snapshot;
    this.limits = options.limits ?? {};
  }

  changes(): readonly WorkspaceChange[] {
    return publicChanges(this.fs);
  }

  committedSnapshot(): Promise<PostgresWorkspaceSnapshot> {
    return Promise.resolve().then(() => {
      this.assertRedactionValid();
      return publicSnapshot(this.snapshot);
    });
  }

  committedRevision(): string | null {
    return this.snapshot.revision;
  }

  checkpoint(options: CheckpointOptions = {}): Promise<CheckpointReceipt> {
    return this.backend.checkpoint(options);
  }

  checkpoints(): Promise<readonly CheckpointRecord[]> {
    return this.backend.checkpoints();
  }

  async commit(options: CommitOptions = {}): Promise<CommitReceipt> {
    this.assertRedactionValid();
    const pending = persistentPending(this.fs);
    const context = resolvedCommitContext(
      options.context ?? this.pendingCommit?.context,
      this.restoreSourceRevision,
    );
    this.fs.beginCommit();
    try {
      const prepared = await prepareChanges(this.fs, pending, this.documentCodec);
      const changes = committedWorkspaceChanges(
        pending,
        prepared.uploads,
        this.fs.baselineEntries(),
        (path) => this.fs.baselineEntry(path),
      );
      assertCommitQuotas(
        prepared.uploads,
        pending.deletions,
        visibleEntryCount(this.fs.baselineEntries(), pending.deletions, prepared.uploads),
        context.metadata,
        this.limits,
      );
      const fingerprint = await commitFingerprint(changes, context);
      const attempt = commitAttempt(this.pendingCommit, context, fingerprint);
      this.pendingCommit = attempt;
      const result = await this.backend.commit({
        changes,
        context,
        expectedRevision: this.snapshot.revision,
        expectedRedactionEpoch: this.snapshot.redactionEpoch ?? null,
        fingerprint,
        mutations: mutationsFrom(this.fs, pending, prepared),
        ...(this.restoreSourceRevision !== undefined && {
          restoreSourceRevision: this.restoreSourceRevision,
        }),
        transactionId: attempt.transactionId,
      });
      this.snapshot = committedTree(this.snapshot, pending, prepared.documents, result.receipt);
      this.replaceSnapshotBodies(this.snapshot);
      await this.fs.finishCommit(entriesFrom(this.snapshot));
      this.pendingCommit = undefined;
      this.restoreSourceRevision = undefined;
      return result.receipt;
    } catch (error) {
      this.fs.failCommit();
      if (!isUnknownOutcomeSupabashError(error)) {
        this.pendingCommit = undefined;
      }
      throw error;
    }
  }

  deleteCheckpoint(checkpointId: string): Promise<void> {
    return this.backend.deleteCheckpoint(checkpointId);
  }

  async discard(): Promise<void> {
    await this.fs.discardChanges();
    this.pendingCommit = undefined;
    this.restoreSourceRevision = undefined;
  }

  async diff(input: RevisionDiffInput): Promise<RevisionDiff> {
    const staged =
      'staged' in input.from || 'staged' in input.to
        ? await snapshotFromFileSystem(this.fs, this.documentCodec)
        : { documents: [], revision: null };
    return this.backend.diff(
      { ...input, previewBytes: diffPreviewLimit(input.previewBytes, this.limits) },
      staged,
    );
  }

  history(query?: HistoryQuery): Promise<HistoryPage> {
    return Promise.resolve().then(() =>
      this.backend.history({ ...query, limit: historyPageLimit(query?.limit, this.limits) }),
    );
  }

  purge(options: PurgeOptions): Promise<PurgeReceipt> {
    return Promise.resolve().then(() => this.backend.purge(normalizePurgeOptions(options)));
  }

  async redact(options: RedactOptions): Promise<RedactReceipt> {
    if (options.dryRun === true) {
      return this.backend.redact(options);
    }
    this.fs.beginCommit();
    let applied = false;
    try {
      const receipt = await this.backend.redact(options);
      applied = true;
      // Drop all cached/staged content before adopting a newer epoch. In
      // particular, a staged restore must never inherit that newer epoch.
      this.clearSnapshot();
      const snapshot = await this.backend.loadSnapshot();
      this.snapshot = snapshot;
      this.replaceSnapshotBodies(snapshot);
      await this.fs.finishCommit(entriesFrom(snapshot));
      this.redactionInvalidated = false;
      return receipt;
    } catch (error) {
      if (applied || isUnknownOutcomeSupabashError(error)) {
        this.clearSnapshot();
        await this.fs.finishCommit([]);
      } else {
        this.fs.failCommit();
      }
      throw error;
    }
  }

  private clearSnapshot(): void {
    this.redactionInvalidated = true;
    this.pendingCommit = undefined;
    this.restoreSourceRevision = undefined;
    this.snapshot = { documents: [], revision: null };
    this.replaceSnapshotBodies(this.snapshot);
  }

  private assertRedactionValid(): void {
    if (this.redactionInvalidated) {
      throw new SupabashError('REDACTION_INVALIDATED', 'Reopen the workspace after redaction.');
    }
  }

  restoreFloor(): Promise<string | null> {
    return this.backend.restoreFloor();
  }

  async readRevision(revision: string): Promise<ReadonlyWorkspaceView> {
    try {
      const snapshot = await this.backend.loadRevision(revision);
      return readonlyView(snapshot, revision);
    } catch (error) {
      if (isSupabashError(error) && error.code === 'RESTORE_CROSSES_REDACTION') {
        throw new SupabashError(
          'REDACTED',
          'The requested historical view crosses a redaction boundary.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  async restore(revision: string): Promise<RestorePlan> {
    const target = await this.backend.loadRevision(revision);
    const diff = await this.backend.diff(
      {
        from: { revision: requireRevision(this.snapshot) },
        previewBytes: diffPreviewLimit(this.limits.maxDiffPreviewBytes, this.limits),
        to: { revision },
      },
      { documents: [], revision: null },
    );
    await this.fs.stageRemoteTree(entriesFrom(target), bodyLoader(target));
    this.restoreSourceRevision = revision;
    return { diff, sourceRevision: revision };
  }
}
