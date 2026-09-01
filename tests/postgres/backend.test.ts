import { describe, expect, test, vi } from 'vitest';

import { createYamlFrontmatterCodec } from '../../src/api/document-codec.ts';
import type { SupabashError } from '../../src/api/errors.ts';
import { asUnknownRecord, type JsonValue } from '../../src/api/json.ts';
import { createBackendWorkspace } from '../../src/backend/workspace.ts';
import { createPostgresBackend } from '../../src/postgres/backend.ts';
import { postgresError, type PostgresRpcClient } from '../../src/postgres/rpc.ts';

const workspace = '123e4567-e89b-42d3-a456-426614174000';

describe('postgres backend', () => {
  test('loads one decoded pinned UTF-8 snapshot', async () => {
    const rpc = vi.fn<PostgresRpcClient['rpc']>(() =>
      Promise.resolve({ data: snapshot(), error: null }),
    );
    const backend = createPostgresBackend({ client: { rpc }, workspace });

    await expect(backend.loadSnapshot()).resolves.toMatchObject({
      documents: [
        { body: 'héllo\n', byteSize: 7, contentHash: 'a'.repeat(64), path: '/notes/a.md' },
      ],
      revision: '223e4567-e89b-42d3-a456-426614174000',
    });
    expect(rpc).toHaveBeenCalledWith('supabash_load_workspace', { p_workspace_id: workspace });
  });

  test('maps only the stable 409 conflict contract to COMMIT_CONFLICT', () => {
    expect(postgresError({ code: 'PT409', message: 'SUPABASH_COMMIT_CONFLICT' })).toMatchObject({
      code: 'COMMIT_CONFLICT',
    } satisfies Partial<SupabashError>);
    expect(postgresError({ code: 'PT409', message: 'some other conflict' })).toMatchObject({
      code: 'STORAGE',
    } satisfies Partial<SupabashError>);
  });

  test('rejects invalid snapshot byte metadata at the decoder boundary', async () => {
    const rpc = vi.fn<PostgresRpcClient['rpc']>(() =>
      Promise.resolve({
        data: { ...snapshot(), documents: [{ ...snapshot().documents[0], byteSize: 6 }] },
        error: null,
      }),
    );
    const backend = createPostgresBackend({ client: { rpc }, workspace });

    await expect(backend.loadSnapshot()).rejects.toMatchObject({
      code: 'HISTORY_CORRUPTION',
      path: '/notes/a.md',
    });
  });

  test('loads an empty UTF-8 document', async () => {
    const rpc = vi.fn<PostgresRpcClient['rpc']>(() =>
      Promise.resolve({
        data: {
          ...snapshot(),
          documents: [
            storedDocument(
              '/empty.md',
              '',
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            ),
          ],
        },
        error: null,
      }),
    );
    const backend = createPostgresBackend({ client: { rpc }, workspace });

    await expect(backend.loadSnapshot()).resolves.toMatchObject({
      documents: [{ body: '', byteSize: 0, path: '/empty.md' }],
    });
  });

  test('projects stored metadata into canonical YAML frontmatter', async () => {
    const body = '# Pacing\n\nProtect recovery time.\n';
    const content =
      '---\ndescription: "How demanding work affects recovery"\n---\n# Pacing\n\nProtect recovery time.\n';
    const rpc = vi.fn<PostgresRpcClient['rpc']>(() =>
      Promise.resolve({
        data: {
          ...emptySnapshot(),
          documents: [
            {
              body,
              bodyByteSize: new TextEncoder().encode(body).byteLength,
              bodyHash: 'a'.repeat(64),
              byteSize: new TextEncoder().encode(content).byteLength,
              contentHash: 'b'.repeat(64),
              metadata: { description: 'How demanding work affects recovery' },
              path: '/pacing.md',
            },
          ],
        },
        error: null,
      }),
    );
    const backend = createPostgresBackend({ client: { rpc }, workspace });
    const opened = await createBackendWorkspace(backend);

    await expect(opened.fs.readFile('/pacing.md')).resolves.toBe(content);
  });

  test('rejects unsupported persistent text-tree features before commit RPC', async () => {
    const rpc = vi.fn<PostgresRpcClient['rpc']>((name) =>
      Promise.resolve(
        name === 'supabash_load_workspace'
          ? { data: emptySnapshot(), error: null }
          : { data: null, error: null },
      ),
    );
    const backend = createPostgresBackend({ client: { rpc }, workspace });
    const opened = await createBackendWorkspace(backend);

    await opened.fs.mkdir('/empty');
    await expect(opened.commit()).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      path: '/empty',
    });
    await opened.discard();
    await opened.fs.symlink('/target', '/link');
    await expect(opened.commit()).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      path: '/link',
    });
    await opened.discard();
    await opened.fs.writeFile('/invalid.txt', new Uint8Array([0xff]));
    await expect(opened.commit()).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      path: '/invalid.txt',
    });
    expect(rpc).toHaveBeenCalledOnce();
  });

  test('sends a moved and edited file as one move with a replacement body', async () => {
    let commitArguments: Readonly<Record<string, JsonValue>> | undefined;
    const rpc = vi.fn<PostgresRpcClient['rpc']>((name, args) => {
      if (name !== 'supabash_load_workspace') {
        commitArguments = args;
      }
      return Promise.resolve(
        name === 'supabash_load_workspace'
          ? { data: snapshot(), error: null }
          : { data: null, error: { message: 'stop after capture' } },
      );
    });
    const backend = createPostgresBackend({ client: { rpc }, workspace });
    const opened = await createBackendWorkspace(backend);
    await opened.fs.mv('/notes/a.md', '/notes/b.md');
    await opened.fs.writeFile('/notes/b.md', 'changed\n');

    await expect(opened.commit()).rejects.toMatchObject({ code: 'STORAGE' });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(commitArguments).toMatchObject({
      p_changes: [
        { body: 'changed\n', byteSize: 8, from: '/notes/a.md', kind: 'move', path: '/notes/b.md' },
      ],
      p_receipt_changes: [
        {
          beforeHash: 'a'.repeat(64),
          kind: 'move',
          moveFrom: '/notes/a.md',
          moveTo: '/notes/b.md',
          path: '/notes/b.md',
        },
      ],
    });
    const mutations = commitArguments?.['p_changes'];
    const firstMutation = Array.isArray(mutations) ? asUnknownRecord(mutations[0]) : undefined;
    expect(firstMutation?.['bodyHash']).toMatch(/^[0-9a-f]{64}$/u);
  });

  test('sends frontmatter as document metadata instead of stored body text', async () => {
    let commitArguments: Readonly<Record<string, JsonValue>> | undefined;
    const rpc = vi.fn<PostgresRpcClient['rpc']>((name, args) => {
      if (name !== 'supabash_load_workspace') {
        commitArguments = args;
      }
      return Promise.resolve(
        name === 'supabash_load_workspace'
          ? { data: emptySnapshot(), error: null }
          : { data: null, error: { message: 'stop after capture' } },
      );
    });
    const opened = await createBackendWorkspace(
      createPostgresBackend({
        client: { rpc },
        documentCodec: createYamlFrontmatterCodec(),
        workspace,
      }),
    );
    await opened.fs.writeFile(
      '/pacing.md',
      '---\ndescription: Durable pacing context\n---\n# Pacing\n\nProtect recovery.\n',
    );

    await expect(opened.commit()).rejects.toMatchObject({ code: 'STORAGE' });
    expect(commitArguments).toMatchObject({
      p_changes: [
        {
          body: '# Pacing\n\nProtect recovery.\n',
          kind: 'upsert',
          metadata: { description: 'Durable pacing context' },
          path: '/pacing.md',
        },
      ],
    });
  });

  test('normalizes history and purge limits before an RPC', async () => {
    let purgeArguments: Readonly<Record<string, JsonValue>> | undefined;
    const rpc = vi.fn<PostgresRpcClient['rpc']>((name, args) => {
      if (name === 'supabash_load_workspace') {
        return Promise.resolve({ data: emptySnapshot(), error: null });
      }
      if (name === 'supabash_purge') {
        purgeArguments = args;
        return Promise.resolve({ data: { bytes: 0, dryRun: false, objects: [] }, error: null });
      }
      return Promise.resolve({ data: { records: [] }, error: null });
    });
    const opened = await createBackendWorkspace(
      createPostgresBackend({ client: { rpc }, workspace }),
      { limits: { maxHistoryPageSize: 1 } },
    );

    await expect(opened.history({ limit: 2 })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(opened.purge({ maxAgeMs: -1 })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await opened.purge({});
    expect(purgeArguments).toMatchObject({ p_max_revisions: 50 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test('sends an existing-destination move as one atomic move mutation', async () => {
    let commitArguments: Readonly<Record<string, JsonValue>> | undefined;
    const rpc = vi.fn<PostgresRpcClient['rpc']>((name, args) => {
      if (name !== 'supabash_load_workspace') {
        commitArguments = args;
      }
      return Promise.resolve(
        name === 'supabash_load_workspace'
          ? { data: overwriteSnapshot(), error: null }
          : { data: null, error: { message: 'stop after capture' } },
      );
    });
    const opened = await createBackendWorkspace(
      createPostgresBackend({ client: { rpc }, workspace }),
    );
    await opened.fs.mv('/source.md', '/destination.md');

    await expect(opened.commit()).rejects.toMatchObject({ code: 'STORAGE' });
    expect(commitArguments).toMatchObject({
      p_changes: [{ from: '/source.md', kind: 'move', path: '/destination.md' }],
      p_receipt_changes: [
        {
          beforeHash: 'b'.repeat(64),
          kind: 'move',
          moveFrom: '/source.md',
          moveTo: '/destination.md',
          path: '/destination.md',
        },
      ],
    });
  });
});

const emptySnapshot = () => ({ documents: [], headRevision: null });

const storedDocument = (path: string, body: string, hash: string) => {
  const byteSize = new TextEncoder().encode(body).byteLength;
  return {
    body,
    bodyByteSize: byteSize,
    bodyHash: hash,
    byteSize,
    contentHash: hash,
    metadata: {},
    path,
  };
};

const snapshot = () => ({
  committedAt: '2026-08-28T18:00:00.000Z',
  documents: [storedDocument('/notes/a.md', 'héllo\n', 'a'.repeat(64))],
  headRevision: '223e4567-e89b-42d3-a456-426614174000',
  transactionId: '323e4567-e89b-42d3-a456-426614174000',
});

const overwriteSnapshot = () => ({
  ...snapshot(),
  documents: [
    storedDocument('/destination.md', 'destination\n', 'c'.repeat(64)),
    storedDocument('/source.md', 'source\n', 'b'.repeat(64)),
  ],
});
