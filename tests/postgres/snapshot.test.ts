import { describe, expect, test, vi } from 'vitest';

import { createYamlFrontmatterCodec } from '../../src/api/document-codec.ts';
import { asUnknownRecord } from '../../src/api/json.ts';
import { createBackendWorkspace } from '../../src/backend/workspace.ts';
import { createPostgresBackend } from '../../src/postgres/backend.ts';
import type { PostgresRpcClient } from '../../src/postgres/rpc.ts';

const workspace = '123e4567-e89b-42d3-a456-426614174000';

describe('postgres committed snapshot', () => {
  test('excludes staged changes and returns detached immutable values', async () => {
    const nextRevision = '423e4567-e89b-42d3-a456-426614174000';
    const rpc = vi.fn<PostgresRpcClient['rpc']>((name, args) =>
      Promise.resolve(
        name === 'supabash_load_workspace'
          ? { data: { documents: [], headRevision: null }, error: null }
          : {
              data: {
                receipt: {
                  actor: 'agent',
                  changes: [],
                  committedAt: '2026-08-28T19:00:00.000Z',
                  correlationId: 'correlation-1',
                  cursor: nextRevision,
                  parentRevision: null,
                  revision: nextRevision,
                  schemaVersion: 1,
                  scope: workspace,
                  status: 'complete',
                  transactionId: asUnknownRecord(args)?.['p_transaction_id'],
                },
                replayed: false,
              },
              error: null,
            },
      ),
    );
    const opened = await createBackendWorkspace(
      createPostgresBackend({
        client: { rpc },
        documentCodec: createYamlFrontmatterCodec(),
        workspace,
      }),
    );
    await opened.fs.writeFile(
      '/pacing.md',
      '---\ndescription: Durable pacing context\n---\n# Pacing\n',
    );

    expect(opened.committedSnapshot()).toMatchObject({ documents: [], revision: null });
    await opened.commit({ context: { actor: 'agent', correlationId: 'correlation-1' } });
    const committed = opened.committedSnapshot();
    expect(committed).toMatchObject({
      committedAt: new Date('2026-08-28T19:00:00.000Z'),
      documents: [
        {
          body: '# Pacing\n',
          content: '---\ndescription: "Durable pacing context"\n---\n# Pacing\n',
          metadata: { description: 'Durable pacing context' },
          path: '/pacing.md',
        },
      ],
      revision: nextRevision,
    });
    expect([
      Object.isFrozen(committed),
      Object.isFrozen(committed.documents),
      Object.isFrozen(committed.documents[0]?.metadata),
    ]).toStrictEqual([true, true, true]);
    committed.committedAt?.setUTCFullYear(2000);
    expect(opened.committedSnapshot().committedAt?.getUTCFullYear()).toBe(2026);
  });
});
