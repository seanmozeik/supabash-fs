import type { IFileSystem } from 'just-bash/browser';

import type { CommitOptions, CommitStatus } from './commit.js';
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
} from './history.js';

export type WorkspaceChangeKind = 'delete' | 'upsert';
export type WorkspaceEntryKind = 'directory' | 'file' | 'symlink';

export interface WorkspaceChange {
  readonly afterHash?: string;
  readonly afterSize?: number;
  readonly beforeHash?: string;
  readonly beforeSize?: number;
  readonly contentHash?: string;
  readonly entryKind: WorkspaceEntryKind;
  readonly etag?: string;
  readonly kind: WorkspaceChangeKind;
  readonly path: string;
}

export interface CommitReceipt {
  readonly actor: string;
  readonly cause?: string;
  readonly changes: readonly WorkspaceChange[];
  readonly committedAt: Date;
  readonly correlationId: string;
  readonly cursor: string;
  readonly parentRevision: string | null;
  readonly revision: string;
  readonly schemaVersion: number;
  readonly scope: string;
  readonly status: CommitStatus;
  readonly transactionId: string;
}

export interface Workspace {
  readonly fs: IFileSystem;
  readonly changes: () => readonly WorkspaceChange[];
  readonly checkpoint: (options?: CheckpointOptions) => Promise<CheckpointReceipt>;
  readonly commit: (options?: CommitOptions) => Promise<CommitReceipt>;
  readonly discard: () => Promise<void>;
  readonly diff: (input: RevisionDiffInput) => Promise<RevisionDiff>;
  readonly history: (query?: HistoryQuery) => Promise<HistoryPage>;
  readonly purge: (options: PurgeOptions) => Promise<PurgeReceipt>;
  readonly readRevision: (revision: string) => Promise<ReadonlyWorkspaceView>;
  readonly restore: (revision: string) => Promise<RestorePlan>;
}
