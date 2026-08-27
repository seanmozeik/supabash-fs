import { HISTORY_SCHEMA_VERSION } from '../api/commit.js';
import type { WorkspaceChange } from '../api/contracts.js';
import type { RevisionEntry } from '../api/history.js';
import type { JsonValue } from '../api/json.js';

export interface HeadRecord {
  readonly committedAt: string;
  readonly revision: string;
  readonly schemaVersion: number;
  readonly transactionId: string;
}

export interface IntentRecord {
  readonly actor: string;
  readonly cause?: string;
  readonly changes: readonly WorkspaceChange[];
  readonly correlationId: string;
  readonly createdAt: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly newRevision: string;
  readonly parentRevision: string | null;
  readonly schemaVersion: number;
  readonly transactionId: string;
}

export interface CompleteRecord extends IntentRecord {
  readonly committedAt: string;
  readonly status: 'complete';
}

export interface RevisionRecord {
  readonly committedAt: string;
  readonly entries: readonly RevisionEntry[];
  readonly parentRevision: string | null;
  readonly revision: string;
  readonly schemaVersion: number;
  readonly transactionId: string;
}

export interface CheckpointRecord {
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly idempotencyKey?: string;
  readonly label?: string;
  readonly retentionClass?: string;
  readonly revision: string;
  readonly schemaVersion: number;
}

export interface IdempotencyRecord {
  readonly revision: string;
  readonly schemaVersion: number;
  readonly transactionId: string;
}

export const currentSchema = (): number => HISTORY_SCHEMA_VERSION;
