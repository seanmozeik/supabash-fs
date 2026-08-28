import { asRecord, assert, expectCode, type LiveContext } from './live-context.ts';
import type { CoreProof } from './live-core.ts';

export interface HistoryProof {
  readonly checkpointId: string;
}

export const proveHistoryAndRetention = async (
  context: LiveContext,
  core: CoreProof,
): Promise<HistoryProof> => {
  const checkpointId = await proveHistory(context, core);
  await proveIdempotency(context, core.user.accessToken);
  await provePurge(context, core.user.accessToken);
  await proveManifestGrowth(context, core.user.accessToken);
  return { checkpointId };
};

const proveHistory = async (context: LiveContext, core: CoreProof): Promise<string> => {
  const workspace = await context.open(core.user.accessToken, core.workspaceId);
  const history = await workspace.history({ limit: 100 });
  assert(
    history.records.some(({ revision }) => revision === core.seed.revision),
    'History omitted the seed.',
  );
  assert(
    history.records.some(({ revision }) => revision === core.atomic.revision),
    'History omitted a commit.',
  );
  const diff = await workspace.diff({
    from: { revision: core.seed.revision },
    to: { revision: core.atomic.revision },
  });
  const kinds = new Set(diff.entries.map(({ kind }) => kind));
  assert(
    kinds.has('added') && kinds.has('deleted') && kinds.has('moved'),
    'Diff omitted change kinds.',
  );
  const historical = await workspace.readRevision(core.seed.revision);
  const historicalText = await historical.readFile('/docs/move.md');
  assert(historicalText === 'move me\n', 'Historical read changed.');
  const checkpoint = await workspace.checkpoint({
    idempotencyKey: `${context.runId}-checkpoint`,
    label: 'integration-pin',
    retentionClass: 'test',
  });
  const checkpoints = await workspace.checkpoints();
  assert(
    checkpoints.some(({ checkpointId }) => checkpointId === checkpoint.checkpointId),
    'Checkpoint listing omitted the pin.',
  );
  await workspace.fs.writeFile('/dirty.md', 'later\n');
  const dirty = await workspace.commit({
    context: { actor: 'restore-source', correlationId: `${context.runId}-dirty` },
  });
  const plan = await workspace.restore(core.seed.revision);
  assert(plan.sourceRevision === core.seed.revision, 'Restore planned the wrong revision.');
  const restored = await workspace.commit({
    context: { actor: 'restore', correlationId: `${context.runId}-restore` },
  });
  assert(restored.parentRevision === dirty.revision, 'Restore did not create a forward commit.');
  assert(restored.revision !== core.seed.revision, 'Restore rewound history.');
  const reopened = await context.open(core.user.accessToken, core.workspaceId);
  assert(await reopened.fs.exists('/docs/move.md'), 'Restore did not recover the target tree.');
  assert(!(await reopened.fs.exists('/dirty.md')), 'Restore retained a later document.');
  context.record('history, diff, checkpoints, historical reads, and forward restore');
  return checkpoint.checkpointId;
};

const proveIdempotency = async (context: LiveContext, accessToken: string): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const first = await context.open(accessToken, workspaceId);
  const replay = await context.open(accessToken, workspaceId);
  await first.fs.writeFile('/once.md', 'same\n');
  await replay.fs.writeFile('/once.md', 'same\n');
  const commitContext = {
    actor: 'idempotency',
    cause: 'replay',
    correlationId: `${context.runId}-idempotency`,
    idempotencyKey: `${context.runId}-idempotency`,
  } as const;
  const receipt = await first.commit({ context: commitContext });
  const repeated = await replay.commit({ context: commitContext });
  assert(receipt.revision === repeated.revision, 'Idempotent replay created a revision.');
  assert(
    receipt.transactionId === repeated.transactionId,
    'Idempotent replay changed its receipt.',
  );
  const mismatch = await context.open(accessToken, workspaceId);
  await mismatch.fs.writeFile('/once.md', 'different\n');
  await expectCode(
    mismatch.commit({ context: commitContext }),
    'IDEMPOTENCY_CONFLICT',
    'Mismatched idempotency reuse was accepted.',
  );
  context.record('idempotent replay and conflicting key reuse');
};

const provePurge = async (context: LiveContext, accessToken: string): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const workspace = await context.open(accessToken, workspaceId);
  const revisions: string[] = [];
  let checkpointId = '';
  for (let index = 0; index < 4; index += 1) {
    await workspace.fs.writeFile('/retention.md', `revision ${index}\n`);
    const receipt = await workspace.commit({
      context: { actor: 'purge', correlationId: `${context.runId}-purge-${index}` },
    });
    revisions.push(receipt.revision);
    if (index === 0) {
      const checkpoint = await workspace.checkpoint({ label: 'pinned' });
      ({ checkpointId } = checkpoint);
    }
  }
  const dryRun = await workspace.purge({ dryRun: true, maxRevisions: 1 });
  assert(dryRun.dryRun && dryRun.objects.length >= 1, 'Purge dry run found no revisions.');
  const applied = await workspace.purge({ maxRevisions: 1 });
  assert(!applied.dryRun, 'Applied purge reported a dry run.');
  const history = await workspace.history({ limit: 100 });
  const retained = new Set(history.records.map(({ revision }) => revision));
  assert(retained.has(revisions[0] ?? ''), 'Purge removed a checkpointed revision.');
  assert(retained.has(revisions[3] ?? ''), 'Purge removed the head.');
  assert(
    !retained.has(revisions[1] ?? '') && !retained.has(revisions[2] ?? ''),
    'Purge retained old revisions.',
  );
  await workspace.deleteCheckpoint(checkpointId);
  context.record('retention purge preserves the head and checkpoint pins');
};

const proveManifestGrowth = async (context: LiveContext, accessToken: string): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const workspace = await context.open(accessToken, workspaceId);
  for (let index = 0; index < 8; index += 1) {
    await workspace.fs.writeFile(`/documents/${index}.md`, `initial ${index}\n`);
  }
  await workspace.commit({
    context: { actor: 'growth', correlationId: `${context.runId}-growth-0` },
  });
  for (let revision = 1; revision <= 5; revision += 1) {
    await workspace.fs.writeFile('/documents/0.md', `revision ${revision}\n`);
    await workspace.commit({
      context: { actor: 'growth', correlationId: `${context.runId}-growth-${revision}` },
    });
  }
  const stats = asRecord(
    await context.serviceRpc('supabash_test_manifest_stats', { p_workspace_id: workspaceId }),
    'manifest stats',
  );
  assert(stats['currentDocumentCount'] === 8, 'Growth fixture lost current documents.');
  assert(stats['revisionCount'] === 6, 'Growth fixture has the wrong revision count.');
  assert(stats['manifestEntryCount'] === 48, 'Revisions do not contain complete manifests.');
  assert(stats['bodyCount'] === 13, 'Content-addressed body growth is incorrect.');
  context.record('complete-manifest and content-addressed storage growth');
};
