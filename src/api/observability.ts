import type { WorkspaceBackendKind } from './contracts.js';
import type { SupabashErrorCode } from './errors.js';

export type WorkspaceOperation =
  | 'checkpoint'
  | 'checkpoint-delete'
  | 'checkpoint-list'
  | 'commit'
  | 'diff'
  | 'filesystem-projection'
  | 'history'
  | 'purge'
  | 'revision-load'
  | 'snapshot-load';

export interface WorkspaceOperationEvent {
  readonly backend: WorkspaceBackendKind;
  readonly changeCount?: number;
  readonly documentCount?: number;
  readonly durationMs: number;
  readonly errorCode?: SupabashErrorCode;
  readonly operation: WorkspaceOperation;
  readonly outcome: 'conflict' | 'failure' | 'success';
  readonly replayed?: boolean;
  readonly serializedPayloadBytes?: number;
  readonly totalUtf8Bytes?: number;
}

export interface WorkspaceObservability {
  /**
   * Receives privacy-safe operation summaries. Observer failures are ignored and cannot change
   * workspace behavior.
   */
  readonly onOperation: (event: WorkspaceOperationEvent) => void;
}
