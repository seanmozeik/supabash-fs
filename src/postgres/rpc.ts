import { isSupabashError, SupabashError } from '../api/errors.js';
import { asUnknownRecord, type JsonValue } from '../api/json.js';

export interface PostgresRpcClient {
  readonly rpc: (
    name: string,
    args?: Readonly<Record<string, JsonValue>>,
  ) => PromiseLike<{ readonly data: unknown; readonly error: unknown }>;
}

interface PostgrestFailure {
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;
  readonly message: string;
}

export interface PostgresRpcCallOptions {
  readonly outcomeUnknownOnTransportFailure?: boolean;
}

const GATEWAY_FAILURE_STATUSES: ReadonlySet<unknown> = new Set([502, 503, 504]);

export const callPostgresRpc = async <T>(
  client: PostgresRpcClient,
  name: string,
  decode: (value: unknown) => T,
  args: Readonly<Record<string, JsonValue>> = {},
  options: PostgresRpcCallOptions = {},
): Promise<T> => {
  let response: unknown;
  try {
    response = await client.rpc(name, args);
  } catch (cause) {
    throw new SupabashError('STORAGE', 'Postgres RPC transport failed.', {
      cause,
      outcomeUnknown: options.outcomeUnknownOnTransportFailure ?? false,
      retryable: true,
    });
  }
  const record = asUnknownRecord(response);
  if (record === undefined || !('data' in record) || !('error' in record)) {
    throw new SupabashError('STORAGE', 'Postgres RPC returned an invalid response.', {
      outcomeUnknown: options.outcomeUnknownOnTransportFailure ?? false,
    });
  }
  if (record['error'] !== null) {
    const failure = parseFailure(record['error']);
    // Supabase resolves fetch failures with status 0 instead of rejecting.
    // An unstructured gateway failure can also hide an accepted mutation.
    const { status } = record;
    if (
      status === 0 ||
      (GATEWAY_FAILURE_STATUSES.has(status) && (failure.code === undefined || failure.code === ''))
    ) {
      throw new SupabashError('STORAGE', 'Postgres RPC transport failed.', {
        cause: failure,
        outcomeUnknown: options.outcomeUnknownOnTransportFailure ?? false,
        retryable: true,
      });
    }
    throw postgresError(failure);
  }
  try {
    return decode(record['data']);
  } catch (cause) {
    if (options.outcomeUnknownOnTransportFailure === true) {
      if (isSupabashError(cause)) {
        throw new SupabashError(cause.code, cause.message, {
          cause,
          outcomeUnknown: true,
          ...(cause.path !== undefined && { path: cause.path }),
        });
      }
      throw new SupabashError('STORAGE', 'Postgres mutation response could not be verified.', {
        cause,
        outcomeUnknown: true,
      });
    }
    throw cause;
  }
};

const parseFailure = (value: unknown): PostgrestFailure => {
  const record = asUnknownRecord(value);
  const message = record?.['message'];
  if (typeof message !== 'string') {
    return { message: 'Unknown PostgREST error.' };
  }
  const code = record?.['code'];
  const details = record?.['details'];
  const hint = record?.['hint'];
  return {
    message,
    ...(typeof code === 'string' && { code }),
    ...(typeof details === 'string' && { details }),
    ...(typeof hint === 'string' && { hint }),
  };
};

const RETRYABLE_TRANSACTION_CODES: ReadonlySet<string | undefined> = new Set([
  '55P03',
  '40P01',
  '40001',
]);
const CONNECTION_REJECTION_CODES: ReadonlySet<string | undefined> = new Set([
  'PGRST000',
  'PGRST001',
  'PGRST002',
  'PGRST003',
]);

export const postgresError = (error: PostgrestFailure): SupabashError => {
  if (CONNECTION_REJECTION_CODES.has(error.code)) {
    return new SupabashError('STORAGE', 'Postgres connection is unavailable.', {
      cause: error,
      retryable: true,
    });
  }
  if (RETRYABLE_TRANSACTION_CODES.has(error.code)) {
    return new SupabashError('COMMIT_COORDINATION', 'Postgres transaction must be retried.', {
      cause: error,
      retryable: true,
    });
  }
  const stable = [error.message, error.details, error.hint].join(' ');
  return redactionError(error, stable) ?? workspaceError(error, stable);
};

const redactionError = (error: PostgrestFailure, stable: string): SupabashError | undefined => {
  for (const code of [
    'REDACTED',
    'REDACTION_CURRENT_BODY',
    'REDACTION_INVALIDATED',
    'RESTORE_CROSSES_REDACTION',
  ] as const) {
    if (stable.includes(`SUPABASH_${code}`)) {
      return new SupabashError(code, `Postgres rejected the operation: ${code}.`, { cause: error });
    }
  }
  return undefined;
};

const workspaceError = (error: PostgrestFailure, stable: string): SupabashError => {
  if (stable.includes('SUPABASH_EXPIRED_CAPABILITY')) {
    return new SupabashError('EXPIRED_CAPABILITY', 'Delegated capability has expired.', {
      cause: error,
    });
  }
  if (
    stable.includes('SUPABASH_INVALID_CAPABILITY') ||
    stable.includes('SUPABASH_CAPABILITY_NONCE_REUSED')
  ) {
    return new SupabashError('INVALID_CAPABILITY', 'Delegated capability was rejected.', {
      cause: error,
    });
  }
  if (error.code === 'PT409' && stable.includes('SUPABASH_COMMIT_CONFLICT')) {
    return new SupabashError('COMMIT_CONFLICT', 'Workspace head changed after it was opened.', {
      cause: error,
    });
  }
  if (stable.includes('SUPABASH_IDEMPOTENCY_CONFLICT')) {
    return new SupabashError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to different content or context.',
      { cause: error },
    );
  }
  if (stable.includes('SUPABASH_CAPABILITY_SECRET_UNAVAILABLE')) {
    return new SupabashError(
      'AUTHORIZATION',
      'Postgres cannot read the capability verification secret.',
      { cause: error },
    );
  }
  if (stable.includes('SUPABASH_AUTHENTICATION_REQUIRED')) {
    return new SupabashError('AUTHENTICATION', 'Postgres requires an authenticated subject.', {
      cause: error,
    });
  }
  if (error.code === '42501' || stable.includes('SUPABASH_WORKSPACE_DENIED')) {
    return new SupabashError('AUTHORIZATION', 'Postgres denied access to the workspace.', {
      cause: error,
    });
  }
  if (
    stable.includes('SUPABASH_REVISION_NOT_FOUND') ||
    stable.includes('SUPABASH_CHECKPOINT_NOT_FOUND')
  ) {
    return new SupabashError(
      'REVISION_NOT_FOUND',
      'The requested workspace revision was not found.',
      { cause: error },
    );
  }
  if (stable.includes('SUPABASH_UNSUPPORTED_CONTENT')) {
    return new SupabashError(
      'UNSUPPORTED_CONTENT',
      'Postgres rejected unsupported workspace content.',
      { cause: error },
    );
  }
  if (error.code === '54000' || stable.includes('SUPABASH_QUOTA')) {
    return new SupabashError('QUOTA_EXCEEDED', 'Postgres rejected a workspace resource limit.', {
      cause: error,
    });
  }
  if (error.code === '22023' || stable.includes('SUPABASH_INVALID')) {
    return new SupabashError('INVALID_PATH', 'Postgres rejected the workspace request.', {
      cause: error,
    });
  }
  return new SupabashError('STORAGE', 'Postgres workspace operation failed.', { cause: error });
};
