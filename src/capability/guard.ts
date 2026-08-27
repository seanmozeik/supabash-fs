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
import { readOnlyFileSystem } from './readonly-fs.js';

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
    this.fs = operations.has('write') ? inner.fs : readOnlyFileSystem(inner.fs);
  }

  changes(): readonly WorkspaceChange[] {
    this.assert('read');
    return this.inner.changes();
  }

  async checkpoint(options?: CheckpointOptions): Promise<CheckpointReceipt> {
    this.assert('checkpoint');
    const receipt = await this.inner.checkpoint(options);
    return receipt;
  }

  async commit(options: CommitOptions = {}): Promise<CommitReceipt> {
    this.assert('commit');
    const receipt = await this.inner.commit({
      context: options.context ?? { actor: this.actor, correlationId: this.correlationId },
    });
    return receipt;
  }

  async discard(): Promise<void> {
    this.assert('write');
    await this.inner.discard();
  }

  async diff(input: RevisionDiffInput): Promise<RevisionDiff> {
    this.assert('history');
    const diff = await this.inner.diff(input);
    return diff;
  }

  async history(query?: HistoryQuery): Promise<HistoryPage> {
    this.assert('history');
    const page = await this.inner.history(query);
    return page;
  }

  async purge(options: PurgeOptions): Promise<PurgeReceipt> {
    this.assert('purge');
    const receipt = await this.inner.purge(options);
    return receipt;
  }

  async readRevision(revision: string): Promise<ReadonlyWorkspaceView> {
    this.assert('history');
    const view = await this.inner.readRevision(revision);
    return view;
  }

  async restore(revision: string): Promise<RestorePlan> {
    this.assert('restore');
    const plan = await this.inner.restore(revision);
    return plan;
  }

  private assert(operation: DelegatedOperation): void {
    if (!this.operations.has(operation)) {
      throw new SupabashError(
        'AUTHORIZATION',
        'Delegated capability does not allow this workspace operation.',
      );
    }
  }
}
