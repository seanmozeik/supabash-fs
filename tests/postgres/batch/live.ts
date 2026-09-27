import { asRecord, assert, expectCode, type LiveContext, type TestUser } from '../live/context.ts';

export const proveBatchWrites = async (context: LiveContext, owner: TestUser): Promise<void> => {
  const workspaceId = await context.createWorkspace(owner.accessToken);
  const workspace = await context.open(owner.accessToken, workspaceId);
  for (let index = 0; index < 32; index += 1) {
    await workspace.fs.writeFile(`/batch-${index}.md`, 'before 🌱');
  }
  const seed = await workspace.commit({ context: { actor: 'batch', correlationId: 'batch-seed' } });
  for (let index = 0; index < 32; index += 1) {
    await workspace.fs.writeFile(`/batch-${index}.md`, 'must roll back');
  }
  await context.serviceRpc('supabash_test_fail_next_commit', { p_workspace_id: workspaceId });
  try {
    await expectCode(
      workspace.commit({ context: { actor: 'batch', correlationId: 'batch-failure' } }),
      'STORAGE',
      'Injected bulk failure did not roll back.',
    );
  } finally {
    await context.serviceRpc('supabash_test_clear_commit_failure', { p_workspace_id: workspaceId });
  }
  const stats = asRecord(
    await context.serviceRpc('supabash_test_manifest_stats', { p_workspace_id: workspaceId }),
    'batch rollback stats',
  );
  assert(stats['bodyCount'] === 1, 'Failed batch retained bodies.');
  assert(stats['versionEntryCount'] === 32, 'Failed batch retained versions.');
  const reopened = await context.open(owner.accessToken, workspaceId);
  assert(reopened.committedRevision() === seed.revision, 'Failed batch changed the head.');
  for (let index = 0; index < 32; index += 1) {
    assert(
      (await reopened.fs.readFile(`/batch-${index}.md`)) === 'before 🌱',
      'Failed batch changed a file.',
    );
    await reopened.fs.writeFile(`/batch-${index}.md`, 'after 🌳');
  }
  await reopened.commit({ context: { actor: 'batch', correlationId: 'batch-success' } });
  const old = await reopened.readRevision(seed.revision);
  assert((await old.readFile('/batch-31.md')) === 'before 🌱', 'Batch update damaged history.');
  const current = await context.open(owner.accessToken, workspaceId);
  for (let index = 0; index < 32; index += 1) {
    assert(
      (await current.fs.readFile(`/batch-${index}.md`)) === 'after 🌳',
      'Batch update lost a file.',
    );
  }
  context.record('set-based batch writes, shared bodies, pinned history, and full rollback');
};
