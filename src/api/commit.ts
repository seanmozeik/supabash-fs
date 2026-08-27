import type { JsonValue } from './json.js';

export interface CommitLeaseInput {
  readonly scope: string;
  readonly transactionId: string;
}

export interface CommitLease {
  readonly lost: () => Promise<boolean>;
  readonly release: () => Promise<void>;
}

export interface CommitCoordinator {
  readonly acquire: (input: CommitLeaseInput) => Promise<CommitLease>;
}

export interface CommitContext {
  readonly actor: string;
  readonly cause?: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface CommitOptions {
  readonly context?: CommitContext;
}

export type CommitStatus = 'complete' | 'partial';

export const HISTORY_SCHEMA_VERSION = 1;
