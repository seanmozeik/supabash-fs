import { expect, test } from 'vitest';

import { plainTextDocumentCodec } from '../../../src/api/document-codec.ts';
import { documentFromContent } from '../../../src/backend/text-tree.ts';
import { createBackendWorkspace } from '../../../src/backend/workspace.ts';
import { createPostgresBackend } from '../../../src/postgres/backend.ts';

const setup = async (corrupt: boolean, retainHashes = false) => {
  const revision = '223e4567-e89b-42d3-a456-426614174000';
  const document = await documentFromContent('/file.md', 'original', plainTextDocumentCodec);
  const changed = await documentFromContent('/file.md', 'changed', plainTextDocumentCodec);
  const calls: unknown[] = [];
  const workspace = await createBackendWorkspace(
    createPostgresBackend({
      workspace: '123e4567-e89b-42d3-a456-426614174000',
      lazy: true,
      client: {
        rpc: (name, args) => {
          calls.push([name, args?.['p_revision_id']]);
          const { body: _body, content: _content, ...entry } = document;
          let loaded = corrupt ? changed : document;
          if (retainHashes) {
            loaded = { ...document, body: 'tampered', content: 'tampered' };
          }
          return Promise.resolve({
            data: {
              headRevision: revision,
              documents: [name === 'supabash_load_manifest' ? entry : loaded],
            },
            error: null,
          });
        },
      },
    }),
  );
  return { workspace, calls, revision };
};

test('bulk snapshot uses one pinned RPC and excludes staged files', async () => {
  const { workspace, calls, revision } = await setup(false);
  await workspace.fs.writeFile('/staged.md', 'must not enter snapshot');
  const snapshot = await workspace.committedSnapshot();
  expect(snapshot.documents).toHaveLength(1);
  expect(snapshot.documents[0]?.body).toBe('original');
  expect(calls).toStrictEqual([
    ['supabash_load_manifest', undefined],
    ['supabash_load_pinned_snapshot', revision],
  ]);
});

test('bulk snapshot rejects a changed pinned manifest', async () => {
  const { workspace } = await setup(true);
  await expect(workspace.committedSnapshot()).rejects.toMatchObject({ code: 'HISTORY_CORRUPTION' });
});

test('bulk snapshot rejects changed bytes with unchanged hash fields and sizes', async () => {
  const { workspace } = await setup(false, true);
  await expect(workspace.committedSnapshot()).rejects.toMatchObject({ code: 'HISTORY_CORRUPTION' });
});
