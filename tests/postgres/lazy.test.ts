import { expect, test } from 'vitest';

import { plainTextDocumentCodec } from '../../src/api/document-codec.ts';
import { documentFromContent } from '../../src/backend/text-tree.ts';
import { createBackendWorkspace } from '../../src/backend/workspace.ts';
import { createPostgresBackend } from '../../src/postgres/backend.ts';
import type { PostgresRpcClient } from '../../src/postgres/rpc.ts';

const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
const revision = '223e4567-e89b-42d3-a456-426614174000';

test('saved-revision diffs do not read current bodies or parse staged content', async () => {
  const original = await documentFromContent('/file.md', 'original', plainTextDocumentCodec);
  const calls: string[] = [];
  const rpc: PostgresRpcClient['rpc'] = (name, args) => {
    calls.push(name);
    if (name === 'supabash_load_manifest') {
      const { body: _body, content: _content, ...entry } = original;
      return Promise.resolve({ data: { headRevision: revision, documents: [entry] }, error: null });
    }
    expect(name).toBe('supabash_diff');
    expect(args?.['p_staged_documents']).toStrictEqual([]);
    return Promise.resolve({
      data: { entries: [], fromRevision: revision, toRevision: revision },
      error: null,
    });
  };
  const workspace = await createBackendWorkspace(
    createPostgresBackend({ client: { rpc }, workspace: workspaceId, lazy: true }),
  );
  await workspace.fs.writeFile('/invalid.md', '\0');
  await expect(workspace.diff({ from: { revision }, to: { revision } })).resolves.toMatchObject({
    entries: [],
  });
  expect(calls).toStrictEqual(['supabash_load_manifest', 'supabash_diff']);
});

test('opening and listing load no bodies; reads use the pinned revision and deduplicate', async () => {
  const first = await documentFromContent('/first.md', 'first', plainTextDocumentCodec);
  const second = await documentFromContent('/second.md', 'second', plainTextDocumentCodec);
  const calls: string[] = [];
  const rpc: PostgresRpcClient['rpc'] = (name, args) => {
    calls.push(name);
    if (name === 'supabash_load_manifest') {
      return Promise.resolve({
        data: {
          headRevision: revision,
          documents: [first, second].map(({ body: _body, content: _content, ...entry }) => entry),
        },
        error: null,
      });
    }
    expect(args?.['p_revision_id']).toBe(revision);
    expect(args?.['p_workspace_id']).toBe(workspaceId);
    return Promise.resolve({
      data: args?.['p_path'] === '/first.md' ? first : second,
      error: null,
    });
  };
  const workspace = await createBackendWorkspace(
    createPostgresBackend({ client: { rpc }, workspace: workspaceId, lazy: true }),
  );
  expect(workspace.committedRevision()).toBe(revision);
  await expect(workspace.fs.readdir('/')).resolves.toContain('first.md');
  expect(calls).toStrictEqual(['supabash_load_manifest']);
  await expect(
    Promise.all([workspace.fs.readFile('/first.md'), workspace.fs.readFile('/first.md')]),
  ).resolves.toStrictEqual(['first', 'first']);
  expect(calls).toStrictEqual(['supabash_load_manifest', 'supabash_load_document']);
});

test('commit does not fetch unchanged bodies and preserves them in the new snapshot', async () => {
  const untouched = await documentFromContent(
    '/untouched.md',
    'large unchanged body',
    plainTextDocumentCodec,
  );
  const nextRevision = '323e4567-e89b-42d3-a456-426614174000';
  const reads: unknown[] = [];
  const rpc: PostgresRpcClient['rpc'] = (name, args) => {
    if (name === 'supabash_load_manifest') {
      const { body: _body, content: _content, ...entry } = untouched;
      return Promise.resolve({ data: { headRevision: revision, documents: [entry] }, error: null });
    }
    if (name === 'supabash_commit') {
      return Promise.resolve({
        data: {
          replayed: false,
          receipt: {
            actor: 'agent',
            changes: [],
            committedAt: '2026-09-14T00:00:00Z',
            correlationId: 'test',
            cursor: nextRevision,
            parentRevision: revision,
            revision: nextRevision,
            schemaVersion: 1,
            scope: workspaceId,
            status: 'complete',
            transactionId: args?.['p_transaction_id'],
          },
        },
        error: null,
      });
    }
    reads.push(args);
    return Promise.resolve({ data: untouched, error: null });
  };
  const workspace = await createBackendWorkspace(
    createPostgresBackend({ client: { rpc }, workspace: workspaceId, lazy: true }),
  );
  await workspace.fs.writeFile('/new.md', 'new body');
  await workspace.commit({ context: { actor: 'agent', correlationId: 'test' } });
  expect(reads).toStrictEqual([]);
  await expect(workspace.fs.readFile('/untouched.md')).resolves.toBe('large unchanged body');
  expect(reads).toStrictEqual([
    { p_workspace_id: workspaceId, p_revision_id: nextRevision, p_path: '/untouched.md' },
  ]);
  await expect(workspace.fs.readFile('/new.md')).resolves.toBe('new body');
});

test.each([false, true])(
  'rejects changed bytes even when hash fields are retained (%s)',
  async (retainHashes) => {
    const original = await documentFromContent('/file.md', 'original', plainTextDocumentCodec);
    const changed = await documentFromContent('/file.md', 'changed', plainTextDocumentCodec);
    const { body: _body, content: _content, ...entry } = original;
    const returned = retainHashes
      ? { ...original, body: 'tampered', content: 'tampered' }
      : changed;
    const rpc: PostgresRpcClient['rpc'] = (name) =>
      Promise.resolve({
        data:
          name === 'supabash_load_manifest'
            ? { headRevision: revision, documents: [entry] }
            : returned,
        error: null,
      });
    const workspace = await createBackendWorkspace(
      createPostgresBackend({ client: { rpc }, workspace: workspaceId, lazy: true }),
    );
    await expect(workspace.fs.readFile('/file.md')).rejects.toMatchObject({
      code: 'HISTORY_CORRUPTION',
    });
  },
);
