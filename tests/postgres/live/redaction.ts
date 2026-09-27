import { assert, expectCode, type LiveContext } from './context.ts';
import { proveRepeatedRedaction, proveUnreferencedBody } from './redaction-cases.ts';

export const proveRedaction = async (context: LiveContext, accessToken: string): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const workspace = await context.open(accessToken, workspaceId);
  await workspace.fs.writeFile('/memory.md', 'forgotten secret');
  await workspace.fs.writeFile('/shared.md', 'forgotten secret');
  const first = await workspace.commit({
    context: {
      actor: 'forget-test',
      correlationId: context.runId,
      metadata: { summary: 'forgotten secret', kept: 'safe' },
      cause: 'forgotten secret',
    },
  });
  const pin = await workspace.checkpoint();
  await workspace.fs.writeFile('/memory.md', 'safe replacement');
  const second = await workspace.commit();
  const workerA = await context.open(accessToken, workspaceId);
  const cached = await workerA.fs.readFile('/shared.md');
  await workerA.fs.writeFile('/cached-copy.md', cached);
  const pendingRestore = await context.open(accessToken, workspaceId);
  await pendingRestore.restore(first.revision);
  await expectCode(
    workspace.redact({ paths: ['/memory.md'], before: second.revision }),
    'REDACTION_CURRENT_BODY',
    'Redaction ignored an uncovered current duplicate.',
  );
  assert((await workspace.restoreFloor()) === null, 'Rejected redact created a fence.');
  const options = {
    paths: ['/memory.md', '/shared.md'],
    before: second.revision,
    metadataKeys: ['summary'],
    clearCause: true,
  };
  const dry = await workspace.redact({ ...options, dryRun: true });
  assert(
    dry.revisions.includes(first.revision) && dry.bodies.length === 0,
    'Dry run misreported shared body retention.',
  );
  const dryRunRevision = await workspace.readRevision(first.revision);
  assert(dryRunRevision.entries.length === 2, 'Dry run changed history.');
  assert((await workspace.restoreFloor()) === null, 'Dry run created a fence.');
  const applied = await workspace.redact(options);
  await expectCode(
    workerA.commit(),
    'REDACTION_INVALIDATED',
    'An ordinary commit from a worker opened before redaction was accepted.',
  );
  assert(
    JSON.stringify(dry.bodies) === JSON.stringify(applied.bodies) && dry.bytes === applied.bytes,
    'Dry run disagreed with shared interval application.',
  );
  await expectCode(
    pendingRestore.commit(),
    'RESTORE_CROSSES_REDACTION',
    'A restore staged before redaction committed across the fence.',
  );
  assert((await workspace.restoreFloor()) === second.revision, 'Fence has the wrong boundary.');
  await expectCode(
    workspace.readRevision(first.revision),
    'REDACTED',
    'Revision load crossed the fence.',
  );
  await expectCode(
    workspace.restore(first.revision),
    'RESTORE_CROSSES_REDACTION',
    'Restore crossed the fence.',
  );
  await proveRedactedReads({ context, accessToken, workspaceId, workspace, first, second });
  await workspace.fs.writeFile('/shared.md', 'safe shared replacement');
  const third = await workspace.commit();
  const originalHash = first.changes.find((change) => change.path === '/shared.md')?.contentHash;
  assert(originalHash !== undefined, 'Fixture omitted body hash.');
  const removalDry = await workspace.redact({ bodyHashes: [originalHash], dryRun: true });
  const removed = await workspace.redact({ bodyHashes: [originalHash] });
  assert(
    JSON.stringify(removalDry.bodies) === JSON.stringify(removed.bodies) &&
      removalDry.bytes === removed.bytes,
    'Dry run disagreed with body deletion.',
  );
  assert(
    removed.bodies.includes(originalHash) &&
      removed.bytes === new TextEncoder().encode('forgotten secret').length,
    'Unreferenced original body was not deleted.',
  );
  await workspace.deleteCheckpoint(pin.checkpointId);
  await workspace.purge({ maxRevisions: 0, keepAfterRevision: second.revision });
  const protectedHistory = await workspace.history({
    cursor: first.cursor,
    cursorMissing: 'oldest',
  });
  assert(
    protectedHistory.records.map((record) => record.revision).join(',') ===
      [second.revision, third.revision].join(','),
    'Retention floor or missing-cursor recovery failed.',
  );
  await expectCode(
    workspace.history({ cursor: first.cursor }),
    'REVISION_NOT_FOUND',
    'Strict cursor mode silently recovered.',
  );
  await workspace.fs.writeFile('/later.md', 'later');
  await workspace.commit();
  await workspace.purge({ maxRevisions: 0 });
  assert((await workspace.restoreFloor()) === third.revision, 'Purge removed a redaction fence.');
  await proveMetadataOnly(context, accessToken);
  await proveRepeatedRedaction(context, accessToken);
  await proveUnreferencedBody(context, accessToken);
  context.record(
    'redaction dry run, dedupe, metadata, direct reads, restore fence and retention floor',
  );
};

type LiveWorkspace = Awaited<ReturnType<LiveContext['open']>>;
type CommitReceipt = Awaited<ReturnType<LiveWorkspace['commit']>>;

/** After a redaction: diffs, history metadata, the current tree and direct reads. */
const proveRedactedReads = async ({
  context,
  accessToken,
  workspaceId,
  workspace,
  first,
  second,
}: {
  context: LiveContext;
  accessToken: string;
  workspaceId: string;
  workspace: LiveWorkspace;
  first: CommitReceipt;
  second: CommitReceipt;
}): Promise<void> => {
  const diff = await workspace.diff({
    from: { revision: first.revision },
    to: { revision: second.revision },
  });
  assert(
    diff.entries.length === 2 &&
      diff.entries.every((entry) => entry.kind === 'unavailable' && entry.preview === undefined),
    'Diff exposed redacted content.',
  );
  const history = await workspace.history();
  const historical = history.records.find((record) => record.revision === first.revision);
  assert(
    historical?.metadata?.['summary'] === undefined &&
      historical?.metadata?.['kept'] === 'safe' &&
      historical.cause === undefined,
    'Metadata or cause survived redaction.',
  );
  const reopened = await context.open(accessToken, workspaceId);
  assert(
    (await reopened.fs.readFile('/shared.md')) === 'forgotten secret',
    'Redaction changed the current tree.',
  );
  const unavailable = await context.rpc(accessToken, 'supabash_load_document', {
    p_workspace_id: workspaceId,
    p_revision_id: first.revision,
    p_path: '/memory.md',
  });
  assert(
    !unavailable.ok && JSON.stringify(unavailable.body).includes('SUPABASH_REDACTED'),
    'Direct document read returned a tombstone as content.',
  );
};

const proveMetadataOnly = async (context: LiveContext, accessToken: string): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const workspace = await context.open(accessToken, workspaceId);
  await workspace.fs.writeFile('/safe.md', 'safe');
  const old = await workspace.commit({
    context: {
      actor: 'metadata-test',
      correlationId: context.runId,
      cause: 'private',
      metadata: { secret: 'private', keep: 'safe' },
    },
  });
  await workspace.fs.writeFile('/next.md', 'next');
  await workspace.commit();
  await workspace.redact({ metadataKeys: ['secret'], clearCause: true });
  const history = await workspace.history();
  const record = history.records.find((entry) => entry.revision === old.revision);
  assert(
    record?.metadata?.['secret'] === undefined &&
      record?.metadata?.['keep'] === 'safe' &&
      record.cause === undefined,
    'Metadata-only redaction failed.',
  );
  assert(
    (await workspace.restoreFloor()) === null,
    'Metadata-only redaction created a path fence.',
  );
  const revision = await workspace.readRevision(old.revision);
  assert(
    (await revision.readFile('/safe.md')) === 'safe',
    'Metadata redaction changed file content.',
  );
};
