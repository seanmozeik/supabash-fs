export type SupabashErrorCode =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'COMMIT_CONFLICT'
  | 'COMMIT_IN_PROGRESS'
  | 'INVALID_PATCH'
  | 'INVALID_PATH'
  | 'POLICY_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'STORAGE'
  | 'UNSUPPORTED_CONTENT';

export interface SupabashErrorOptions {
  readonly cause?: unknown;
  readonly path?: string;
}

export class SupabashError extends Error {
  readonly code: SupabashErrorCode;
  readonly path?: string;

  constructor(code: SupabashErrorCode, message: string, options: SupabashErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SupabashError';
    this.code = code;
    if (options.path !== undefined) {
      this.path = options.path;
    }
  }
}
