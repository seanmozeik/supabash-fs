import { SupabashError } from '../api/errors.js';
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
    throw new SupabashError('STORAGE', 'Postgres RPC returned an invalid response.');
  }
  if (record['error'] !== null) {
    throw postgresError(parseFailure(record['error']));
  }
  return decode(record['data']);
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

export const postgresError = (error: PostgrestFailure): SupabashError => {
  const stable = `${error.message} ${error.details ?? ''} ${error.hint ?? ''}`;
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
