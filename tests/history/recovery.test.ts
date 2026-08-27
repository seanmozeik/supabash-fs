import { describe, expect, test } from 'vitest';

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
});
