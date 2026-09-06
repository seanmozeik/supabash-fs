import {
  createMountedFileSystem,
  createPostgresDelegatedCapability,
  createYamlFrontmatterCodec,
  importCapabilitySecret,
  type FileSystemSnapshot,
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
  readWorkspaceSnapshot,
  Supabash,
} from '@seanmozeik/supabash-fs';
import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';

import { invokeTool, resultField } from '../deno/tool-runtime.ts';
import { assert, expectCode, type LiveContext, type TestUser } from './live-context.ts';

export const proveMountedPublishing = async (
  context: LiveContext,
  firstUser: TestUser,
  secondUser: TestUser,
): Promise<void> => {
  const publisherUser = await context.createUser('publisher');
  const sharedId = await context.createWorkspace(publisherUser.accessToken);
  const publisher = await context.open(
    publisherUser.accessToken,
    sharedId,
    createYamlFrontmatterCodec(),
  );
  await publisher.fs.writeFile('/help.md', '---\ntitle: Calendar\n---\n# Help v1\n患者🙂\n');
  await publisher.fs.writeFile('/retired.md', 'Retired later.\n');
  const release = await publisher.commit();
  assert(release.status === 'complete', 'Shared publication did not complete.');

  await expectCode(
    context.open(firstUser.accessToken, sharedId),
    'AUTHORIZATION',
    'Private user opened the publisher workspace.',
  );
  const reader = await sharedReader(context, publisherUser, sharedId);
  const snapshot = await readWorkspaceSnapshot({
    workspace: reader,
    sourceId: 'app-docs',
    revision: release.revision,
  });
  const original = await snapshot.fs.readFile('/help.md');
  assert(
    original.includes('Calendar') && original.includes('患者🙂'),
    'Shared codec lost content.',
  );
  await expectCode(reader.fs.writeFile('/help.md', 'forbidden'), 'AUTHORIZATION', 'Reader wrote.');
  await expectCode(reader.commit(), 'AUTHORIZATION', 'Reader committed.');
  await expectCode(reader.restore(release.revision), 'AUTHORIZATION', 'Reader restored.');
  context.record(
    'shared publisher ownership, read/history-only grant, and retained UTF-8 metadata',
  );

  const { mounted, firstId, baseline } = await provePrivateMounts(
    context,
    firstUser,
    secondUser,
    snapshot,
  );

  await publisher.fs.writeFile('/help.md', '# Help v2\n');
  await publisher.fs.writeFile('/added.md', 'New shared page.\n');
  await publisher.fs.rm('/retired.md');
  const updated = await publisher.commit();
  assert(updated.status === 'complete', 'Publisher update did not complete.');
  const freshReader = await context.open(publisherUser.accessToken, sharedId);
  const fresh = await readWorkspaceSnapshot({
    workspace: freshReader,
    sourceId: 'app-docs',
    revision: updated.revision,
  });
  assert((await fresh.fs.readFile('/help.md')) === '# Help v2\n', 'Shared update did not persist.');
  assert(await fresh.fs.exists('/added.md'), 'Shared upsert did not persist.');
  assert(!(await fresh.fs.exists('/retired.md')), 'Shared deletion did not persist.');
  assert(
    (await mounted.fs.readFile('/docs/help.md')) === original,
    'Publisher changed an active turn.',
  );
  assert(await mounted.fs.exists('/docs/retired.md'), 'Publisher deleted an active snapshot file.');
  assert(fresh.digest !== snapshot.digest, 'Different published bytes have the same digest.');

  const reopened = await context.open(firstUser.accessToken, firstId);
  await reopened.restore(baseline.revision);
  const privateRestore = await reopened.commit();
  assert(privateRestore.status === 'complete', 'Private restore commit failed.');
  const restored = await context.open(firstUser.accessToken, firstId);
  assert(!(await restored.fs.exists('/copied.md')), 'Private restore did not remove later copy.');
  assert((await fresh.fs.readFile('/help.md')) === '# Help v2\n', 'Private restore changed docs.');
  const unchangedPublisher = await context.open(publisherUser.accessToken, sharedId);
  const publisherHistory = await unchangedPublisher.history();
  assert(
    publisherHistory.records.at(-1)?.revision === updated.revision,
    'Private restore changed the publisher database head.',
  );
  await publisher.restore(release.revision);
  const rollback = await publisher.commit();
  assert(rollback.status === 'complete', 'Shared rollback commit failed.');
  const rolledBack = await readWorkspaceSnapshot({
    workspace: await context.open(publisherUser.accessToken, sharedId),
    sourceId: 'app-docs',
    revision: rollback.revision,
  });
  assert(rolledBack.digest === snapshot.digest, 'Shared rollback did not restore original bytes.');
  assert(
    (await fresh.fs.readFile('/help.md')) === '# Help v2\n',
    'Rollback mutated a loaded release.',
  );
  context.record(
    'shared upsert/update/delete, pinned turns, and independent private/shared restore',
  );
};

const provePrivateMounts = async (
  context: LiveContext,
  firstUser: TestUser,
  secondUser: TestUser,
  snapshot: FileSystemSnapshot,
) => {
  const original = await snapshot.fs.readFile('/help.md');
  const firstId = await context.createWorkspace(firstUser.accessToken);
  const secondId = await context.createWorkspace(secondUser.accessToken);
  const first = await context.open(firstUser.accessToken, firstId);
  const second = await context.open(secondUser.accessToken, secondId);
  await first.fs.writeFile('/baseline.md', 'private baseline\n');
  const baseline = await first.commit();
  const mounted = createMountedFileSystem([
    { access: 'read-write', mountPoint: '/memories', sourceId: firstId, workspace: first },
    { access: 'read-only', mountPoint: '/docs', snapshot },
  ]);
  const other = createMountedFileSystem([
    { access: 'read-write', mountPoint: '/memories', sourceId: secondId, workspace: second },
    { access: 'read-only', mountPoint: '/docs', snapshot },
  ]);
  const { tools } = await createTools({ filesystem: mounted.fs });
  const copied = await invokeTool(tools['bash'], {
    command: 'cat /docs/help.md > /memories/copied.md',
  });
  assert(resultField(copied, 'exitCode') === 0, 'Bash could not copy reference into memory.');
  const patched = await invokeTool(tools['apply_patch'], {
    callId: 'mounted-private-create',
    operation: { type: 'create_file', path: '/memories/note.md', diff: '+private note\n+' },
  });
  assert(resultField(patched, 'status') === 'completed', 'Mounted private patch failed.');
  const denied = await invokeTool(tools['bash'], { command: 'echo forbidden > /docs/help.md' });
  assert(resultField(denied, 'exitCode') !== 0, 'Bash changed a read-only mount.');
  const deniedPatch = await invokeTool(tools['apply_patch'], {
    callId: 'mounted-shared-delete',
    operation: { type: 'delete_file', path: '/docs/help.md' },
  });
  assert(resultField(deniedPatch, 'status') === 'failed', 'Apply Patch changed shared docs.');
  assert((await mounted.fs.readFile('/docs/help.md')) === original, 'Denied writes changed docs.');
  const receipt = await first.commit();
  assert(receipt.status === 'complete', 'Mounted private commit failed.');
  const reopened = await context.open(firstUser.accessToken, firstId);
  assert((await reopened.fs.readFile('/copied.md')) === original, 'Copy did not persist.');
  assert((await reopened.fs.readFile('/note.md')) === 'private note\n', 'Patch did not persist.');
  assert(
    receipt.changes.every(({ path }) => path === '/copied.md' || path === '/note.md'),
    'Private receipt contains a shared source or visible mount prefix.',
  );
  assert(!(await other.fs.exists('/memories/note.md')), 'Private content leaked to another user.');
  assert((await other.fs.readFile('/docs/help.md')) === original, 'Shared snapshot reuse failed.');
  context.record('mounted Bash and Apply Patch, private persistence, and two-user isolation');

  return { mounted, firstId, baseline };
};

const sharedReader = async (context: LiveContext, owner: TestUser, workspaceId: string) => {
  const keyId = 'shared-reader-integration';
  const audience = 'supabash-shared-reader';
  const issuer = 'https://publisher.example.test';
  const secret = await context.serviceRpc('supabash_test_register_verifier', {
    p_audience: audience,
    p_issuer: issuer,
    p_key_id: keyId,
    p_origin: context.supabaseUrl,
  });
  assert(typeof secret === 'string', 'Shared verifier registration returned no secret.');
  const capability = await createPostgresDelegatedCapability({
    keyId,
    secretKey: await importCapabilitySecret(secret),
    claims: {
      aud: audience,
      backend: 'postgres',
      corr: `${context.runId}-shared-reader`,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000) - 1,
      iss: issuer,
      nonce: `${context.runId}-shared-reader`,
      ops: ['read', 'history'],
      origin: context.supabaseUrl,
      sub: owner.id,
      sv: POSTGRES_CAPABILITY_SCHEMA_VERSION,
      workspace: workspaceId,
    },
  });
  return Supabash.openPostgresDelegated({
    capability,
    expectedOperations: ['read', 'history'],
    serviceRoleKey: context.serviceRoleKey,
    supabaseUrl: context.supabaseUrl,
  });
};
