import { describe, expect, test, vi } from 'vitest';

import { isDelegatedOperation } from '../../src/api/capability.ts';
import { createBackendWorkspace } from '../../src/backend/workspace.ts';
import { guardDelegatedPostgresWorkspace } from '../../src/capability/guard.ts';
import { createPostgresBackend } from '../../src/postgres/backend.ts';
import { decodeDocument } from '../../src/postgres/decode.ts';
import { postgresError, type PostgresRpcClient } from '../../src/postgres/rpc.ts';

const workspace = '123e4567-e89b-42d3-a456-426614174000';
const receipt = {
  redactionId: 'event',
  revisions: ['old'],
  bodies: ['hash'],
  bytes: 42,
  dryRun: true,
};

describe('postgres redaction API', () => {
  test('passes selectors, metadata policy, boundary and delegated grant', async () => {
    const rpc = vi.fn<PostgresRpcClient['rpc']>(() =>
      Promise.resolve({ data: receipt, error: null }),
    );
    const backend = createPostgresBackend({ client: { rpc }, workspace, delegatedGrant: 'grant' });
    await expect(
      backend.redact({
        paths: ['/memory.md'],
        bodyHashes: ['hash'],
        before: 'boundary',
        metadataKeys: ['summary'],
        clearCause: true,
        reason: 'forget',
        dryRun: true,
      }),
    ).resolves.toStrictEqual(receipt);
    expect(rpc).toHaveBeenCalledWith('supabash_redact', {
      p_workspace_id: workspace,
      p_delegated_grant: 'grant',
      p_paths: ['/memory.md'],
      p_body_hashes: ['hash'],
      p_before_revision: 'boundary',
      p_metadata_keys: ['summary'],
      p_clear_cause: true,
      p_reason: 'forget',
      p_dry_run: true,
    });
  });

  test('forwards retention and cursor options and decodes the nullable floor', async () => {
    const rpc = vi
      .fn<PostgresRpcClient['rpc']>()
      .mockResolvedValueOnce({ data: { bytes: 0, dryRun: true, objects: [] }, error: null })
      .mockResolvedValueOnce({ data: { records: [] }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: 'boundary', error: null });
    const backend = createPostgresBackend({ client: { rpc }, workspace });
    await backend.purge({ keepAfterRevision: 'floor', dryRun: true });
    await backend.history({ cursor: 'missing', cursorMissing: 'oldest' });
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'supabash_purge',
      expect.objectContaining({ p_keep_after_revision: 'floor' }),
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'supabash_history',
      expect.objectContaining({ p_cursor_missing: 'oldest' }),
    );
    await expect(backend.restoreFloor()).resolves.toBeNull();
    await expect(backend.restoreFloor()).resolves.toBe('boundary');
  });

  test('fails closed on unavailable documents before decoding content', () => {
    expect(() => decodeDocument({ kind: 'unavailable', path: '/memory.md' })).toThrow(
      expect.objectContaining({ code: 'REDACTED' }),
    );
  });

  test.each(['REDACTED', 'REDACTION_CURRENT_BODY', 'RESTORE_CROSSES_REDACTION'] as const)(
    'maps SQL %s errors',
    (code) => {
      expect(postgresError({ code: '22023', message: `SUPABASH_${code}` }).code).toBe(code);
    },
  );

  test('marks an interrupted redaction outcome unknown', async () => {
    const backend = createPostgresBackend({
      workspace,
      client: { rpc: () => Promise.reject(new Error('transport')) },
    });
    await expect(backend.redact({ paths: ['/memory.md'] })).rejects.toMatchObject({
      outcomeUnknown: true,
    });
  });

  test('historical views fail closed while restore retains the SQL fence error', async () => {
    const rpc = vi
      .fn<PostgresRpcClient['rpc']>()
      .mockResolvedValueOnce({ data: { headRevision: null, documents: [] }, error: null })
      .mockResolvedValue({
        data: null,
        error: { code: '22023', message: 'SUPABASH_RESTORE_CROSSES_REDACTION' },
      });
    const opened = await createBackendWorkspace(
      createPostgresBackend({ workspace, client: { rpc } }),
    );
    await expect(opened.readRevision('old')).rejects.toMatchObject({
      code: 'REDACTED',
      cause: { code: 'RESTORE_CROSSES_REDACTION' },
    });
    await expect(opened.restore('old')).rejects.toMatchObject({
      code: 'RESTORE_CROSSES_REDACTION',
    });
    expect(opened.changes()).toStrictEqual([]);
  });

  test('requires the explicit redact capability before making an RPC', async () => {
    const rpc = vi.fn<PostgresRpcClient['rpc']>(() =>
      Promise.resolve({ data: { headRevision: null, documents: [] }, error: null }),
    );
    const inner = await createBackendWorkspace(
      createPostgresBackend({ workspace, client: { rpc } }),
    );
    const guarded = guardDelegatedPostgresWorkspace(inner, new Set(['read']), 'actor', 'corr', {
      actor: 'actor',
      correlationId: 'corr',
      operations: ['read'],
      subject: 'subject',
      workspace,
    });
    await expect(guarded.redact({ paths: ['/memory.md'] })).rejects.toMatchObject({
      code: 'AUTHORIZATION',
    });
    await expect(guarded.restoreFloor()).rejects.toMatchObject({ code: 'AUTHORIZATION' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(isDelegatedOperation('redact')).toBe(true);
  });
});
