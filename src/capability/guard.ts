import type { DelegatedOperation } from '../api/capability.js';
import type { CommitOptions } from '../api/commit.js';
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
} from '../api/history.js';
import { restrictFileSystem } from './readonly-fs.js';

export const guardWorkspace = (
  workspace: Workspace,
  operations: ReadonlySet<DelegatedOperation>,
  actor: string,
  correlationId: string,
): Workspace => new GuardedWorkspace(workspace, operations, actor, correlationId);

class GuardedWorkspace implements Workspace {
  readonly fs: Workspace['fs'];
  private readonly actor: string;
  private readonly correlationId: string;
  private readonly inner: Workspace;
  private readonly operations: ReadonlySet<DelegatedOperation>;

  constructor(
    inner: Workspace,
    operations: ReadonlySet<DelegatedOperation>,
    actor: string,
    correlationId: string,
  ) {
    this.inner = inner;
    this.operations = operations;
    this.actor = actor;
    this.correlationId = correlationId;
    this.fs = restrictFileSystem(inner.fs, filesystemAccess(operations));
  }

  changes(): readonly WorkspaceChange[] {
    this.assertOneOf('read', 'write');
    return this.inner.changes();
  }

  checkpoint(options?: CheckpointOptions): Promise<CheckpointReceipt> {
    return this.allow('checkpoint', () => this.inner.checkpoint(options));
  }

  commit(options: CommitOptions = {}): Promise<CommitReceipt> {
    return this.allow('commit', () =>
      this.inner.commit({
        context: { ...options.context, actor: this.actor, correlationId: this.correlationId },
      }),
    );
  }

  discard(): Promise<void> {
    return this.allow('write', () => this.inner.discard());
  }

  diff(input: RevisionDiffInput): Promise<RevisionDiff> {
    return this.allow('history', () => this.inner.diff(input));
  }

  history(query?: HistoryQuery): Promise<HistoryPage> {
    return this.allow('history', () => this.inner.history(query));
  }

  purge(options: PurgeOptions): Promise<PurgeReceipt> {
    return this.allow('purge', () => this.inner.purge(options));
  }

  readRevision(revision: string): Promise<ReadonlyWorkspaceView> {
    return this.allow('history', () => this.inner.readRevision(revision));
  }

  restore(revision: string): Promise<RestorePlan> {
    return this.allow('restore', () => this.inner.restore(revision));
  }

  private allow<T>(operation: DelegatedOperation, work: () => Promise<T>): Promise<T> {
    try {
      this.assertOneOf(operation);
    } catch (error) {
      if (!(error instanceof SupabashError)) {
        throw error;
      }
      return Promise.reject(error);
    }
    return work();
  }

  private assertOneOf(...operations: readonly DelegatedOperation[]): void {
    if (!operations.some((operation) => this.operations.has(operation))) {
      throw new SupabashError(
        'AUTHORIZATION',
        'Delegated capability does not allow this workspace operation.',
      );
    }
  }
}

const filesystemAccess = (
  operations: ReadonlySet<DelegatedOperation>,
): 'none' | 'read' | 'write' => {
  if (operations.has('write')) {
    return 'write';
  }
  if (operations.has('read')) {
    return 'read';
  }
  return 'none';
};
