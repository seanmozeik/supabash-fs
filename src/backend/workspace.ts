import type { CommitOptions } from '../api/commit.js';
import type { CommitReceipt, WorkspaceChange } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
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
} from '../api/history.js';
import type { WorkspaceObservability } from '../api/observability.js';
import { POSTGRES_WORKSPACE_CAPABILITIES, type PostgresWorkspace } from '../api/postgres.js';
import { comparePaths } from '../core/entry-order.js';
import { startOperation } from '../core/observability.js';
import { isSameOrDescendant } from '../core/path.js';
import { isRuntimeOwnedPath } from '../core/runtime-paths.js';
import type { PendingChanges, UploadEntry } from '../core/storage.js';
import type { TrackedFileSystem } from '../core/tracked-file-system.js';
import {
  committedWorkspaceChanges,
  prepareUpload,
  previewWorkspaceChanges,
  resolvedCommitContext,
  visibleEntryCount,
} from '../core/workspace-changes.js';
import { validateWorkspaceConfiguration } from '../core/workspace-options.js';
import { commitFingerprint } from '../history/fingerprint.js';
import type { WorkspaceLimits } from '../history/limits.js';
import { assertCommitQuotas, diffPreviewLimit } from '../history/quota.js';
import type {
  BackendDocument,
  BackendMutation,
  PinnedSnapshot,
  WorkspaceBackend,
} from './contracts.js';
import {
  bodyLoader,
  decodeText,
  entriesFrom,
  projectSnapshot,
  readonlyView,
  requireHash,
  requireRevision,
  snapshotDetails,
  snapshotFromFileSystem,
  TEXT_FILE_MODE,
  type TextTreeProjection,
  unsupported,
} from './text-tree.js';

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
  private readonly limits: WorkspaceLimits;
  private readonly replaceSnapshotBodies: TextTreeProjection['replaceSnapshotBodies'];
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
    this.capabilities = POSTGRES_WORKSPACE_CAPABILITIES;
    this.fs = projection.filesystem;
    this.replaceSnapshotBodies = projection.replaceSnapshotBodies;
    this.snapshot = snapshot;
    this.limits = options.limits ?? {};
  }

  changes(): readonly WorkspaceChange[] {
    return publicChanges(this.fs);
  }

  checkpoint(options: CheckpointOptions = {}): Promise<CheckpointReceipt> {
    return this.backend.checkpoint(options);
  }

  checkpoints(): Promise<readonly CheckpointRecord[]> {
    return this.backend.checkpoints();
  }

  async commit(options: CommitOptions = {}): Promise<CommitReceipt> {
    const pending = persistentPending(this.fs);
    const context = resolvedCommitContext(options.context, this.restoreSourceRevision);
    this.fs.beginCommit();
    try {
      const prepared = await prepareChanges(this.fs, pending);
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
      const result = await this.backend.commit({
        changes,
        context,
        expectedRevision: this.snapshot.revision,
        fingerprint: await commitFingerprint(changes, context),
        mutations: mutationsFrom(this.fs, pending, prepared),
        ...(this.restoreSourceRevision !== undefined && {
          restoreSourceRevision: this.restoreSourceRevision,
        }),
        transactionId: crypto.randomUUID(),
      });
      this.snapshot = await snapshotFromFileSystem(this.fs, result.receipt);
      this.replaceSnapshotBodies(this.snapshot);
      await this.fs.finishCommit(entriesFrom(this.snapshot));
      this.restoreSourceRevision = undefined;
      return result.receipt;
    } catch (error) {
      this.fs.failCommit();
      throw error;
    }
  }

  deleteCheckpoint(checkpointId: string): Promise<void> {
    return this.backend.deleteCheckpoint(checkpointId);
  }

  async discard(): Promise<void> {
    await this.fs.discardChanges();
    this.restoreSourceRevision = undefined;
  }

  diff(input: RevisionDiffInput): Promise<RevisionDiff> {
    return snapshotFromFileSystem(this.fs).then((staged) =>
      this.backend.diff(
        { ...input, previewBytes: diffPreviewLimit(input.previewBytes, this.limits) },
        staged,
      ),
    );
  }

  history(query?: HistoryQuery): Promise<HistoryPage> {
    return this.backend.history(query);
  }

  purge(options: PurgeOptions): Promise<PurgeReceipt> {
    return this.backend.purge(options);
  }

  async readRevision(revision: string): Promise<ReadonlyWorkspaceView> {
    const snapshot = await this.backend.loadRevision(revision);
    return readonlyView(snapshot, revision);
  }

  async restore(revision: string): Promise<RestorePlan> {
    const target = await this.backend.loadRevision(revision);
    const diff = await this.backend.diff(
      {
        from: { revision: requireRevision(this.snapshot) },
        previewBytes: diffPreviewLimit(this.limits.maxDiffPreviewBytes, this.limits),
        to: { revision },
      },
      this.snapshot,
    );
    await this.fs.stageRemoteTree(entriesFrom(target), bodyLoader(target));
    this.restoreSourceRevision = revision;
    return { diff, sourceRevision: revision };
  }
}

interface PreparedChanges {
  readonly documents: ReadonlyMap<string, BackendDocument>;
  readonly uploads: readonly UploadEntry[];
}

const prepareChanges = async (
  fs: TrackedFileSystem,
  pending: PendingChanges,
): Promise<PreparedChanges> => {
  const uploads: UploadEntry[] = [];
  const documents = new Map<string, BackendDocument>();
  for (const path of pending.upserts) {
    const draft = await fs.uploadEntry(path);
    if (draft.kind === 'directory') {
      throw unsupported(path, 'Empty directories are not durable in a UTF-8 text tree.');
    }
    if (draft.kind === 'symlink') {
      throw unsupported(path, 'Symbolic links are not supported by the UTF-8 text backend.');
    }
    if (draft.mode !== TEXT_FILE_MODE) {
      throw unsupported(path, 'File modes are not supported by the UTF-8 text backend.');
    }
    const body = decodeText(draft.body ?? new Uint8Array(), path);
    const upload = await prepareUpload(draft);
    uploads.push(upload);
    documents.set(path, {
      body,
      byteSize: upload.body?.byteLength ?? 0,
      contentHash: requireHash(upload.contentHash, path),
      path,
    });
  }
  return { documents, uploads };
};

const mutationsFrom = (
  fs: TrackedFileSystem,
  pending: PendingChanges,
  prepared: PreparedChanges,
): readonly BackendMutation[] => {
  const movedFrom = new Set(pending.moves.map(({ from }) => from));
  const movedTo = new Set(pending.moves.map(({ to }) => to));
  return [
    ...pending.moves.map(({ from, to }): BackendMutation => {
      const document = prepared.documents.get(to);
      const changed =
        document !== undefined && document.contentHash !== fs.baselineEntry(from)?.contentHash;
      return {
        from,
        kind: 'move',
        path: to,
        ...(changed && {
          body: document.body,
          bodyHash: document.contentHash,
          byteSize: document.byteSize,
        }),
      };
    }),
    ...pending.deletions
      .filter(({ path }) => !movedFrom.has(path))
      .map(({ path }) => ({ kind: 'delete' as const, path })),
    ...[...prepared.documents.values()]
      .filter(({ path }) => !movedTo.has(path))
      .map(({ body, byteSize, contentHash, path }) => ({
        body,
        byteSize,
        contentHash,
        kind: 'upsert' as const,
        path,
      })),
  ].toSorted((left, right) => comparePaths(left.path, right.path));
};

const persistentPending = (fs: TrackedFileSystem): PendingChanges => {
  const pending = fs.pendingPreview();
  const moves = pending.moves.filter(
    ({ from, to }) => !isRuntimeOwnedPath(from) && !isRuntimeOwnedPath(to),
  );
  const movedOut = pending.moves
    .filter(({ from, to }) => !isRuntimeOwnedPath(from) && isRuntimeOwnedPath(to))
    .flatMap(({ from }) => {
      const entry = fs.baselineEntry(from);
      return entry === undefined ? [] : [entry];
    });
  return {
    deletions: [...pending.deletions.filter(({ path }) => !isRuntimeOwnedPath(path)), ...movedOut],
    moves,
    upserts: pending.upserts.filter(
      (path) => !isRuntimeOwnedPath(path) && !derivedDirectory(fs, path),
    ),
  };
};

const publicChanges = (fs: TrackedFileSystem): readonly WorkspaceChange[] =>
  previewWorkspaceChanges(persistentPending(fs), (path) => fs.kindOf(path));

const derivedDirectory = (fs: TrackedFileSystem, path: string): boolean => {
  if (fs.kindOf(path) !== 'directory') {
    return false;
  }
  return fs
    .getAllPaths()
    .some(
      (candidate) =>
        candidate !== path &&
        !isRuntimeOwnedPath(candidate) &&
        isSameOrDescendant(candidate, path) &&
        fs.kindOf(candidate) !== 'directory',
    );
};
