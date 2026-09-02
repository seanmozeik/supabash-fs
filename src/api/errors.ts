export type SupabashErrorCode =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'COMMIT_CONFLICT'
  | 'COMMIT_COORDINATION'
  | 'COMMIT_IN_PROGRESS'
  | 'EXPIRED_CAPABILITY'
  | 'HISTORY_CORRUPTION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CAPABILITY'
  | 'INVALID_PATCH'
  | 'INVALID_PATH'
  | 'PARTIAL_COMMIT'
  | 'POLICY_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'REVISION_NOT_FOUND'
  | 'STORAGE'
  | 'UNSUPPORTED_CONTENT';

export interface SupabashErrorOptions {
  readonly cause?: unknown;
  readonly outcomeUnknown?: boolean;
  readonly path?: string;
  readonly retryable?: boolean;
}

export class SupabashError extends Error {
  readonly code: SupabashErrorCode;
  readonly outcomeUnknown: boolean;
  readonly path?: string;
  readonly retryable: boolean;

  constructor(code: SupabashErrorCode, message: string, options: SupabashErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SupabashError';
    this.code = code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.retryable = options.retryable ?? false;
    if (options.path !== undefined) {
      this.path = options.path;
    }
  }
}

export const isRetryableSupabashError = (error: unknown): error is SupabashError =>
  error instanceof SupabashError && error.retryable;

export const isUnknownOutcomeSupabashError = (error: unknown): error is SupabashError =>
  error instanceof SupabashError && error.outcomeUnknown;
