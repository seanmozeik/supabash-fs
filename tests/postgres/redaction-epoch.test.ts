import { expect, test } from 'vitest';

import {
  createYamlFrontmatterCodec,
  plainTextDocumentCodec,
} from '../../src/api/document-codec.ts';
import type { BackendDocument } from '../../src/backend/contracts.ts';
import { documentFromContent } from '../../src/backend/text-tree.ts';
import { createBackendWorkspace } from '../../src/backend/workspace.ts';
import { createPostgresBackend } from '../../src/postgres/backend.ts';
import type { PostgresRpcClient } from '../../src/postgres/rpc.ts';

const workspace = '123e4567-e89b-42d3-a456-426614174000';
const revision = '223e4567-e89b-42d3-a456-426614174000';

const server = async () => {
  const state = {
    epoch: 0,
    document: await documentFromContent('/memory.md', 'secret', plainTextDocumentCodec),
    interruptRedact: false,
    interruptReload: false,
    commits: [] as (string | null)[],
    documentReads: 0,
  };
  const rpc: PostgresRpcClient['rpc'] = (name, args) => {
    if (name === 'supabash_redact') {
      if (args?.['p_dry_run'] !== true) {
        state.epoch += 1;
        if (state.interruptRedact) {
          state.interruptRedact = false;
          return Promise.reject(new Error('response lost after application'));
        }
      }
      return Promise.resolve({
        data: {
          redactionId: 'event',
          revisions: [],
          bodies: [],
          bytes: 0,
          dryRun: args?.['p_dry_run'],
        },
        error: null,
      });
    }
    if (name === 'supabash_commit') {
      const epoch = args?.['p_redaction_epoch'];
      if (epoch !== null && typeof epoch !== 'string') {
        throw new TypeError('Commit must send its opened epoch.');
      }
      state.commits.push(epoch);
      if (epoch !== String(state.epoch)) {
        return Promise.resolve({
          data: null,
          error: { code: '22023', message: 'SUPABASH_REDACTION_INVALIDATED' },
        });
      }
      return Promise.resolve({
        data: {
          receipt: {
            actor: 'test',
            changes: [],
            committedAt: '2026-09-27T00:00:00Z',
            correlationId: 'test',
            cursor: revision,
            parentRevision: revision,
            revision,
            schemaVersion: 1,
            scope: workspace,
            status: 'complete',
            transactionId: args?.['p_transaction_id'],
          },
        },
        error: null,
      });
    }
    if (name === 'supabash_load_document') {
      state.documentReads += 1;
      return Promise.resolve({ data: state.document, error: null });
    }
    if (state.interruptReload) {
      return Promise.reject(new Error('snapshot reload failed'));
    }
    const { body: _body, content: _content, ...entry } = state.document;
    return Promise.resolve({
      data: {
        headRevision: revision,
        redactionEpoch: String(state.epoch),
        documents: [name === 'supabash_load_manifest' ? entry : state.document],
      },
      error: null,
    });
  };
  const open = (lazy = false) =>
    createBackendWorkspace(createPostgresBackend({ workspace, client: { rpc }, lazy }));
  return { state, open };
};

test.each([false, true])(
  'redaction invalidates ordinary commits and refreshes the caller (lazy=%s)',
  async (lazy) => {
    const { state, open } = await server();
    const worker = await open(lazy);
    const redactor = await open(lazy);
    await expect(
      Promise.all([worker.fs.readFile('/memory.md'), redactor.fs.readFile('/memory.md')]),
    ).resolves.toStrictEqual(['secret', 'secret']);
    await worker.fs.writeFile('/copy.md', 'secret');
    await redactor.fs.writeFile('/staged.md', 'secret');
    state.document = await documentFromContent('/memory.md', 'safe', plainTextDocumentCodec);
    await redactor.redact({ paths: ['/memory.md'] });
    expect(redactor.changes()).toStrictEqual([]);
    await expect(
      Promise.all([
        redactor.fs.exists('/staged.md'),
        redactor.fs.readFile('/memory.md'),
        redactor.committedSnapshot(),
      ]),
    ).resolves.toMatchObject([false, 'safe', { documents: [{ content: 'safe' }] }]);
    await expect(worker.commit()).rejects.toMatchObject({ code: 'REDACTION_INVALIDATED' });
    await redactor.commit();
    await redactor.commit();
    expect(state.commits).toStrictEqual(['0', '1', '1']);
  },
);

test('an uncertain redaction clears caches and blocks commits until retry refreshes the epoch', async () => {
  const { state, open } = await server();
  const opened = await open();
  await opened.fs.readFile('/memory.md');
  state.interruptRedact = true;
  await expect(opened.redact({ paths: ['/memory.md'] })).rejects.toMatchObject({
    outcomeUnknown: true,
  });
  await expect(opened.fs.exists('/memory.md')).resolves.toBe(false);
  await expect(opened.committedSnapshot()).rejects.toMatchObject({ code: 'REDACTION_INVALIDATED' });
  await expect(opened.commit()).rejects.toMatchObject({ code: 'REDACTION_INVALIDATED' });
  await opened.redact({ paths: ['/memory.md'] });
  await opened.commit();
  expect(state.commits).toStrictEqual(['2']);
});

test('dry runs preserve the epoch and staged writes', async () => {
  const { state, open } = await server();
  const opened = await open();
  await opened.fs.writeFile('/staged.md', 'new');
  await opened.redact({ paths: ['/memory.md'], dryRun: true });
  expect(opened.changes()).toHaveLength(1);
  await opened.commit();
  expect(state.commits).toStrictEqual(['0']);
});

test('user redacted frontmatter remains a normally rendered document, including an empty body', async () => {
  const codec = createYamlFrontmatterCodec();
  for (const body of ['', 'readable']) {
    const document: BackendDocument = await documentFromContent(
      '/memory.md',
      `---\nredacted: true\n---\n${body}`,
      codec,
    );
    expect(document.metadata).toStrictEqual({ redacted: true });
    expect(document.byteSize).toBeGreaterThan(0);
    expect(document.contentHash).not.toBe(document.bodyHash);
  }
});

test('a failed refresh after applied redaction clears the caller and requires reopening', async () => {
  const { state, open } = await server();
  const opened = await open();
  await opened.fs.readFile('/memory.md');
  state.interruptReload = true;
  await expect(opened.redact({ paths: ['/memory.md'] })).rejects.toMatchObject({ code: 'STORAGE' });
  await expect(opened.fs.exists('/memory.md')).resolves.toBe(false);
  await expect(opened.commit()).rejects.toMatchObject({ code: 'REDACTION_INVALIDATED' });
  state.interruptReload = false;
  const reopened = await open();
  await reopened.commit();
  expect(state.commits).toStrictEqual(['1']);
});
