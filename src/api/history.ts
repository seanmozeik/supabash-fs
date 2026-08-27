import type { WorkspaceChange, WorkspaceEntryKind } from './contracts.js';
import type { JsonValue } from './json.js';

export interface CheckpointOptions {
  readonly idempotencyKey?: string;
  readonly label?: string;
  readonly retentionClass?: string;
}

export interface CheckpointReceipt {
  readonly checkpointId: string;
  readonly createdAt: Date;
  readonly revision: string;
}

export interface CheckpointRecord extends CheckpointReceipt {
  readonly idempotencyKey?: string;
  readonly label?: string;
  readonly retentionClass?: string;
}

export interface HistoryQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface HistoryRecord {
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
  readonly status: 'complete' | 'partial';
  readonly transactionId: string;
}

export interface HistoryPage {
  readonly nextCursor?: string;
  readonly records: readonly HistoryRecord[];
}

export type RevisionDiffRef =
  | { readonly revision: string }
  | { readonly checkpoint: string }
  | { readonly staged: true };

export interface RevisionDiffInput {
  readonly from: RevisionDiffRef;
  readonly paths?: readonly string[];
  readonly previewBytes?: number;
  readonly to: RevisionDiffRef;
}

export type RevisionDiffKind =
  | 'added'
  | 'deleted'
  | 'metadata'
  | 'modified'
  | 'moved'
  | 'type-change'
  | 'unavailable';

export interface RevisionDiffEntry {
  readonly afterHash?: string;
  readonly beforeHash?: string;
  readonly kind: RevisionDiffKind;
  readonly moveFrom?: string;
  readonly moveTo?: string;
  readonly path: string;
  readonly preview?: string;
}

export interface RevisionDiff {
  readonly entries: readonly RevisionDiffEntry[];
  readonly fromRevision: string;
  readonly toRevision: string;
}

export interface RestorePlan {
  readonly diff: RevisionDiff;
  readonly sourceRevision: string;
}

export interface PurgeOptions {
  readonly dryRun?: boolean;
  readonly maxAgeMs?: number;
  readonly maxRevisions?: number;
}

export interface PurgeReceipt {
  readonly bytes: number;
  readonly dryRun: boolean;
  readonly objects: readonly string[];
}

export interface RevisionEntry {
  readonly contentHash?: string;
  readonly entryKind: WorkspaceEntryKind;
  readonly etag?: string;
  readonly mode: number;
  readonly path: string;
  readonly size: number;
  readonly target?: string;
}

export interface ReadonlyWorkspaceView {
  readonly entries: readonly RevisionEntry[];
  readonly readFile: (path: string) => Promise<string>;
  readonly revision: string;
}
