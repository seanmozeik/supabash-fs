import type { IFileSystem } from 'just-bash/browser';

import type { CommitOptions, CommitStatus } from './commit.js';
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
} from './history.js';
import type { JsonValue } from './json.js';

export type WorkspaceChangeKind = 'delete' | 'move' | 'upsert';
export type WorkspaceEntryKind = 'directory' | 'file' | 'symlink';

export type WorkspaceBackendKind = 'postgres' | 'storage';

export interface WorkspaceCapabilities {
  readonly backend: WorkspaceBackendKind;
  readonly content: 'byte-tree' | 'utf8-text-tree';
  readonly durableEmptyDirectories: boolean;
  readonly modes: boolean;
  readonly symbolicLinks: boolean;
}

export interface WorkspaceChange {
  readonly afterEtag?: string;
  readonly afterHash?: string;
  readonly afterSize?: number;
  readonly beforeEtag?: string;
  readonly beforeHash?: string;
  readonly beforeSize?: number;
  readonly contentHash?: string;
  readonly entryKind: WorkspaceEntryKind;
  readonly etag?: string;
  readonly kind: WorkspaceChangeKind;
  readonly moveFrom?: string;
  readonly moveTo?: string;
  readonly path: string;
}

export interface CommitReceipt {
  readonly actor: string;
  readonly cause?: string;
  readonly changes: readonly WorkspaceChange[];
  readonly committedAt: Date;
  readonly correlationId: string;
  readonly cursor: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
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
  readonly checkpoints: () => Promise<readonly CheckpointRecord[]>;
  readonly commit: (options?: CommitOptions) => Promise<CommitReceipt>;
  readonly deleteCheckpoint: (checkpointId: string) => Promise<void>;
  readonly discard: () => Promise<void>;
  readonly diff: (input: RevisionDiffInput) => Promise<RevisionDiff>;
  readonly history: (query?: HistoryQuery) => Promise<HistoryPage>;
  readonly purge: (options: PurgeOptions) => Promise<PurgeReceipt>;
  readonly readRevision: (revision: string) => Promise<ReadonlyWorkspaceView>;
  readonly restore: (revision: string) => Promise<RestorePlan>;
}
