import type { WorkspaceBackendKind } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type {
  WorkspaceObservability,
  WorkspaceOperation,
  WorkspaceOperationEvent,
} from '../api/observability.js';

type EventDetails = Omit<
  WorkspaceOperationEvent,
  'backend' | 'durationMs' | 'errorCode' | 'operation' | 'outcome'
>;

export interface OperationTimer {
  readonly failure: (error: unknown, details?: EventDetails) => void;
  readonly success: (details?: EventDetails) => void;
}

export const startOperation = (
  observability: WorkspaceObservability | undefined,
  backend: WorkspaceBackendKind,
  operation: WorkspaceOperation,
): OperationTimer => {
  if (observability === undefined) {
    return NOOP_TIMER;
  }
  const startedAt = now();
  const emit = (
    outcome: WorkspaceOperationEvent['outcome'],
    details: EventDetails,
    error?: unknown,
  ): void => {
    const errorCode = error instanceof SupabashError ? error.code : undefined;
    try {
      observability.onOperation({
        backend,
        ...details,
        durationMs: Math.max(0, now() - startedAt),
        ...(errorCode !== undefined && { errorCode }),
        operation,
        outcome: errorCode === 'COMMIT_CONFLICT' ? 'conflict' : outcome,
      });
    } catch {
      // Observability is never part of workspace correctness.
    }
  };
  return {
    failure: (error, details = {}) => {
      emit('failure', details, error);
    },
    success: (details = {}) => {
      emit('success', details);
    },
  };
};

const NOOP_TIMER: OperationTimer = Object.freeze({
  failure: () => {
    // The absent-observer fast path intentionally performs no work.
  },
  success: () => {
    // The absent-observer fast path intentionally performs no work.
  },
});

const now = (): number => performance.now();
