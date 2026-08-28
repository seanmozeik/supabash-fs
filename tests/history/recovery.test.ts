import { describe, expect, test } from 'vitest';

import { asUnknownRecord } from '../../src/api/json.ts';
import { comparePaths } from '../../src/core/entry-order.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('workspace history recovery', () => {
  test('checkpoints the committed revision and diffs it against staged edits', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/notes.md', 'one\n');
    const committed = await workspace.commit();
    const marker = await workspace.checkpoint({ label: 'safe' });
    await workspace.fs.writeFile('/notes.md', 'two\n');
    const staged = await workspace.diff({
      from: { checkpoint: marker.checkpointId },
      to: { staged: true },
    });
    expect({
      checkpointRevision: marker.revision,
      diffKind: staged.entries[0]?.kind,
      source: committed.revision,
    }).toStrictEqual({
      checkpointRevision: committed.revision,
      diffKind: 'modified',
      source: committed.revision,
    });
  });

  test('paginates history and keeps a stable indexing cursor', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage(), { scope: 'scope-a' });
    await workspace.fs.writeFile('/a.md', 'a\n');
    const first = await workspace.commit({ context: { actor: 'test', correlationId: 'c1' } });
    await workspace.fs.writeFile('/b.md', 'b\n');
    const second = await workspace.commit({ context: { actor: 'test', correlationId: 'c2' } });
    const page = await workspace.history({ limit: 1 });
    const rest = await workspace.history(
      page.nextCursor === undefined ? { limit: 1 } : { cursor: page.nextCursor, limit: 1 },
    );
    expect({
      cursorMatchesPage: page.nextCursor === page.records[0]?.transactionId,
      ids: [page.records[0]?.transactionId, rest.records[0]?.transactionId].toSorted(
        (left, right) => comparePaths(left ?? '', right ?? ''),
      ),
      receiptCursor: first.cursor === first.transactionId,
      scope: first.scope,
    }).toStrictEqual({
      cursorMatchesPage: true,
      ids: [first.transactionId, second.transactionId].toSorted(comparePaths),
      receiptCursor: true,
      scope: 'scope-a',
    });
    await expect(workspace.history({ cursor: 'missing-cursor' })).rejects.toMatchObject({
      code: 'REVISION_NOT_FOUND',
    });
    expect(rest.nextCursor).toBeUndefined();
  });

  test('fills revision diff previews for text files', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/notes.md', 'one\n');
    const first = await workspace.commit();
    await workspace.fs.writeFile('/notes.md', 'two\n');
    const second = await workspace.commit();
    const changed = await workspace.diff({
      from: { revision: first.revision },
      to: { revision: second.revision },
    });
    const empty = await workspace.diff({
      from: { revision: first.revision },
      previewBytes: 0,
      to: { revision: second.revision },
    });
    const truncated = await workspace.diff({
      from: { revision: first.revision },
      previewBytes: 8,
      to: { revision: second.revision },
    });
    expect({
      empty: empty.entries[0]?.preview,
      kind: changed.entries[0]?.kind,
      preview: changed.entries[0]?.preview,
      truncated: truncated.entries[0]?.preview?.includes('[truncated]'),
    }).toStrictEqual({
      empty: undefined,
      kind: 'modified',
      preview: '--- before\none\n+++ after\ntwo\n',
      truncated: true,
    });
  });

  test('truncates diff preview content at a valid UTF-8 byte boundary', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/notes.md', '🙂🙂🙂');
    const first = await workspace.commit();
    await workspace.fs.writeFile('/notes.md', 'changed');
    const second = await workspace.commit();
    const diff = await workspace.diff({
      from: { revision: first.revision },
      previewBytes: 13,
      to: { revision: second.revision },
    });
    const preview = diff.entries[0]?.preview;
    expect(preview).toContain('[truncated]');
    const prefix = preview?.split('\n[truncated]\n')[0] ?? '';
    expect(new TextEncoder().encode(prefix).byteLength).toBeLessThanOrEqual(13);
    expect(prefix.endsWith('\uFFFD')).toBe(false);
  });

  test('orders same-millisecond commits by parent revision', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/first.md', 'first\n');
    const first = await workspace.commit();
    await workspace.fs.writeFile('/second.md', 'second\n');
    const second = await workspace.commit();
    for (const key of await storage.history.list('.supabash/transactions/')) {
      if (key.endsWith('/complete.json')) {
        const body = await storage.history.get(key);
        const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
        const record = asUnknownRecord(parsed);
        if (record === undefined) {
          throw new Error(`Invalid complete record at ${key}.`);
        }
        record['committedAt'] = '2026-01-01T00:00:00.000Z';
        await storage.history.put(key, new TextEncoder().encode(JSON.stringify(record)));
      }
    }
    const history = await workspace.history();
    expect(history.records.map((record) => record.revision)).toStrictEqual([
      first.revision,
      second.revision,
    ]);
  });

  test('purge dry-run reports unreferenced objects without deleting them', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/notes.md', 'one\n');
    await workspace.commit();
    await workspace.fs.writeFile('/notes.md', 'two\n');
    await workspace.commit();
    const planned = await workspace.purge({ dryRun: true, maxRevisions: 1 });
    const keys = await storage.history.list('.supabash/revisions/');
    expect({
      dryRun: planned.dryRun,
      stillHasRevisions: keys.length >= 2,
      wouldRemove: planned.objects.length > 0,
    }).toStrictEqual({ dryRun: true, stillHasRevisions: true, wouldRemove: true });
  });

  test('lists and releases checkpoints so retention can remove their revision', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    await workspace.fs.writeFile('/notes.md', 'one\n');
    const first = await workspace.commit();
    const marker = await workspace.checkpoint({
      idempotencyKey: '../safe marker',
      label: 'safe',
      retentionClass: 'daily',
    });
    await workspace.fs.writeFile('/notes.md', 'two\n');
    await workspace.commit();
    await workspace.purge({ maxRevisions: 1 });
    await expect(workspace.readRevision(first.revision)).resolves.toMatchObject({
      revision: first.revision,
    });
    await expect(workspace.checkpoints()).resolves.toMatchObject([
      { checkpointId: marker.checkpointId, label: 'safe', retentionClass: 'daily' },
    ]);

    await workspace.deleteCheckpoint(marker.checkpointId);
    await workspace.purge({ maxRevisions: 1 });
    await expect(workspace.readRevision(first.revision)).rejects.toMatchObject({
      code: 'REVISION_NOT_FOUND',
    });
  });

  test('removes stale idempotency mappings with purged transactions', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    const context = { actor: 'test', correlationId: 'first', idempotencyKey: '../reusable' };
    await workspace.fs.writeFile('/notes.md', 'one\n');
    await workspace.commit({ context });
    await workspace.fs.writeFile('/notes.md', 'two\n');
    await workspace.commit();
    await workspace.purge({ maxRevisions: 1 });
    await workspace.fs.writeFile('/notes.md', 'three\n');
    await expect(
      workspace.commit({ context: { ...context, correlationId: 'reused' } }),
    ).resolves.toMatchObject({ status: 'complete' });
  });
});
