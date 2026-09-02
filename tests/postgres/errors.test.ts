import { describe, expect, test, vi } from 'vitest';

import {
  isRetryableSupabashError,
  isUnknownOutcomeSupabashError,
  type SupabashError,
} from '../../src/api/errors.ts';
import { asUnknownRecord } from '../../src/api/json.ts';
import { createBackendWorkspace } from '../../src/backend/workspace.ts';
import { createPostgresBackend } from '../../src/postgres/backend.ts';
import { callPostgresRpc, postgresError, type PostgresRpcClient } from '../../src/postgres/rpc.ts';

const workspace = '123e4567-e89b-42d3-a456-426614174000';

describe('postgres errors', () => {
  test('maps only the stable 409 conflict contract to COMMIT_CONFLICT', () => {
    expect(postgresError({ code: 'PT409', message: 'SUPABASH_COMMIT_CONFLICT' })).toMatchObject({
      code: 'COMMIT_CONFLICT',
    } satisfies Partial<SupabashError>);
    const unknown = postgresError({ code: 'PT409', message: 'some other conflict' });
    expect(unknown).toMatchObject({
      code: 'STORAGE',
      outcomeUnknown: false,
      retryable: false,
    } satisfies Partial<SupabashError>);
    expect(isRetryableSupabashError(unknown)).toBe(false);
    expect(isUnknownOutcomeSupabashError(unknown)).toBe(false);
  });

  test('normalizes thrown RPC transport failures as retryable package errors', async () => {
    const cause = new TypeError('fetch failed');
    const client: PostgresRpcClient = { rpc: () => Promise.reject(cause) };

    const result = callPostgresRpc(client, 'supabash_load_workspace', (value) => value);
    const error: unknown = await result.catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      cause,
      code: 'STORAGE',
      outcomeUnknown: false,
      retryable: true,
    } satisfies Partial<SupabashError>);
    expect(isRetryableSupabashError(error)).toBe(true);
    expect(isUnknownOutcomeSupabashError(error)).toBe(false);
  });

  test('marks a lost commit response and reuses its transaction on retry', async () => {
    const cause = new TypeError('connection closed');
    const revision = '423e4567-e89b-42d3-a456-426614174000';
    const transactionIds: unknown[] = [];
    let commitAttempts = 0;
    const rpc = vi.fn<PostgresRpcClient['rpc']>((name, args) => {
      if (name === 'supabash_load_workspace') {
        return Promise.resolve({ data: { documents: [], headRevision: null }, error: null });
      }
      commitAttempts += 1;
      const transactionId = asUnknownRecord(args)?.['p_transaction_id'];
      transactionIds.push(transactionId);
      if (commitAttempts === 1) {
        return Promise.reject(cause);
      }
      return Promise.resolve({
        data: {
          receipt: {
            actor: 'workspace',
            changes: [],
            committedAt: '2026-09-02T12:00:00.000Z',
            correlationId: asUnknownRecord(args)?.['p_correlation_id'],
            cursor: transactionId,
            parentRevision: null,
            revision,
            schemaVersion: 1,
            scope: workspace,
            status: 'complete',
            transactionId,
          },
          replayed: true,
        },
        error: null,
      });
    });
    const opened = await createBackendWorkspace(
      createPostgresBackend({ client: { rpc }, workspace }),
    );
    await opened.fs.writeFile('/memory.md', '# Memory\n');

    const commit = opened.commit();
    const error: unknown = await commit.catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      cause,
      code: 'STORAGE',
      outcomeUnknown: true,
      retryable: true,
    } satisfies Partial<SupabashError>);
    expect(isRetryableSupabashError(error)).toBe(true);
    expect(isUnknownOutcomeSupabashError(error)).toBe(true);
    await expect(opened.commit()).resolves.toMatchObject({ revision });
    expect(transactionIds[0]).toBe(transactionIds[1]);
  });
});
