import { asRecord, assert, type LiveContext, type TestUser } from '../live-context.ts';

export const proveLazyReads = async (
  context: LiveContext,
  owner: TestUser,
  other: TestUser,
): Promise<void> => {
  const workspaceId = await context.createWorkspace(owner.accessToken);
  const writer = await context.open(owner.accessToken, workspaceId);
  await writer.fs.writeFile('/pinned.md', 'before');
  const first = await writer.commit({ context: { actor: 'test', correlationId: 'lazy-first' } });
  const reader = await context.open(owner.accessToken, workspaceId);
  const manifest = await context.rpc(owner.accessToken, 'supabash_load_manifest', {
    p_workspace_id: workspaceId,
  });
  assert(manifest.ok, 'Manifest read failed.');
  const { documents } = asRecord(manifest.body, 'manifest');
  assert(Array.isArray(documents) && documents.length === 1, 'Manifest file count is wrong.');
  const [entry] = documents;
  assert(entry !== undefined, 'Manifest entry is missing.');
  assert(!('body' in asRecord(entry, 'entry')), 'Manifest contains a document body.');
  await writer.fs.writeFile('/pinned.md', 'after');
  await writer.commit({ context: { actor: 'test', correlationId: 'lazy-second' } });
  assert(
    (await reader.fs.readFile('/pinned.md')) === 'before',
    'Pinned read changed after another commit.',
  );
  const snapshot = await reader.committedSnapshot();
  assert(snapshot.documents[0]?.body === 'before', 'Bulk snapshot changed its pinned revision.');
  for (const token of [other.accessToken, context.serviceRoleKey]) {
    const denied = await context.rpc(token, 'supabash_load_document', {
      p_workspace_id: workspaceId,
      p_revision_id: first.revision,
      p_path: '/pinned.md',
    });
    assert(!denied.ok, 'Document read crossed its owner or delegation boundary.');
    const bulk = await context.rpc(token, 'supabash_load_pinned_snapshot', {
      p_workspace_id: workspaceId,
      p_revision_id: first.revision,
    });
    assert(!bulk.ok, 'Bulk snapshot crossed its owner or delegation boundary.');
  }
  context.record('lazy manifest, pinned body read, and owner isolation');
};
