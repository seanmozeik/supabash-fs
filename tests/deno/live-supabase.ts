import { applyPatch, SupabashError } from '@seanmozeik/supabash-fs';
import { createClient } from '@supabase/supabase-js';
import { Bash } from 'just-bash/browser';

import { proveDelegatedAccess } from './delegated-live.ts';
import {
  assert,
  denoRuntime,
  errorCode,
  openWorkspace,
  requiredEnvironment,
  subjectFrom,
} from './runtime.ts';

const deno = denoRuntime();
const supabaseUrl = requiredEnvironment(deno.env, 'SUPABASH_TEST_SUPABASE_URL');
const publishableKey = requiredEnvironment(deno.env, 'SUPABASH_TEST_PUBLISHABLE_KEY');
const bucket = requiredEnvironment(deno.env, 'SUPABASH_TEST_BUCKET');
const firstToken = requiredEnvironment(deno.env, 'SUPABASH_TEST_TOKEN_A');
const secondToken = requiredEnvironment(deno.env, 'SUPABASH_TEST_TOKEN_B');
const serviceRoleKey = requiredEnvironment(deno.env, 'SUPABASH_TEST_SERVICE_ROLE_KEY');

const open = (accessToken: string) =>
  openWorkspace({ accessToken, bucket, publishableKey, supabaseUrl });
const lines = (...values: string[]): string => values.join('\n');
const reset = async (accessToken: string): Promise<void> => {
  const workspace = await open(accessToken);
  const names = await workspace.fs.readdir('/');
  for (const name of names) {
    await workspace.fs.rm(`/${name}`, { recursive: true });
  }
  if (workspace.changes().length > 0) {
    await workspace.commit();
  }
};

await reset(firstToken);
await reset(secondToken);

const first = await open(firstToken);
await first.fs.mkdir('/notes', { recursive: true });
await first.fs.writeFile('/notes/alpha.md', 'durable memory\n');
await first.fs.symlink('/notes/alpha.md', '/current');
const search = await new Bash({ cwd: '/', fs: first.fs }).exec('grep -R "durable" /notes');
assert(search.exitCode === 0 && search.stdout.includes('durable memory'), 'Bash search failed.');
const created = await applyPatch(first, {
  diff: lines('+initial', '+'),
  path: '/notes.md',
  type: 'create_file',
});
assert(created.status === 'completed', 'Apply Patch create failed.');
const patched = await applyPatch(first, {
  diff: lines('-initial', '+patched live'),
  path: '/notes.md',
  type: 'update_file',
});
assert(patched.status === 'completed', 'Apply Patch update failed.');
const stagedNotes = await first.fs.readFile('/notes.md');
assert(stagedNotes === 'patched live\n', `Staged patch text was ${JSON.stringify(stagedNotes)}`);
assert(
  first.changes().some((change) => change.path === '/notes.md'),
  'Mixed tool edits were not staged.',
);
const firstCommit = await first.commit({
  context: { actor: 'live-test', correlationId: 'live-mixed' },
});
assert(firstCommit.changes.length > 0, 'The mixed-tool commit produced no changes.');
const visibleRoot = await first.fs.readdir('/');
assert(!visibleRoot.includes('.supabash'), 'Internal history objects were visible.');

const reopened = await open(firstToken);
const reopenedNotes = await reopened.fs.readFile('/notes.md');
const reopenedLink = await reopened.fs.readlink('/current');
assert(
  reopenedNotes === 'patched live\n',
  `The stored file did not reopen: ${JSON.stringify(reopenedNotes)}`,
);
assert(reopenedLink === '/notes/alpha.md', 'The symbolic link did not reopen.');
const history = await reopened.history();
assert(
  history.records.some((record) => record.transactionId === firstCommit.transactionId),
  'History did not survive a new process.',
);
const historical = await reopened.readRevision(firstCommit.revision);
assert(
  (await historical.readFile('/notes.md')) === 'patched live\n',
  'readRevision did not return the committed file.',
);

const marker = await reopened.checkpoint({ label: 'safe' });
await reopened.fs.writeFile('/notes.md', 'bad edit\n');
const dirty = await reopened.commit({
  context: { actor: 'live-test', correlationId: 'live-dirty' },
});
const plan = await reopened.restore(marker.revision);
assert(plan.sourceRevision === marker.revision, 'Restore planned the wrong revision.');
const restored = await reopened.commit({
  context: {
    actor: 'live-test',
    correlationId: 'live-restore',
    metadata: { sourceRevision: marker.revision },
  },
});
assert(restored.parentRevision === dirty.revision, 'Restore did not create a forward transaction.');
assert((await reopened.fs.readFile('/notes.md')) === 'patched live\n', 'Restore did not apply.');

const second = await open(secondToken);
assert(!(await second.fs.exists('/notes.md')), 'The second user saw the first user workspace.');
assert(!(await second.fs.exists('/notes')), 'The second user listed the first user directory.');
const secondSearch = await new Bash({ cwd: '/', fs: second.fs }).exec('grep -R "patched" /');
assert(!secondSearch.stdout.includes('patched live'), 'Bash searched another user workspace.');
const secondPatch = await applyPatch(second, {
  diff: '-patched live\n+hijack\n',
  path: '/notes.md',
  type: 'update_file',
});
assert(secondPatch.status === 'failed', 'Apply Patch mutated another user workspace.');
const secondHistory = await second.history();
assert(
  !secondHistory.records.some((record) => record.transactionId === firstCommit.transactionId),
  'The second user read another user history.',
);
try {
  await second.readRevision(firstCommit.revision);
  throw new Error('The second user read another user revision.');
} catch (error) {
  assert(
    error instanceof SupabashError && error.code === 'REVISION_NOT_FOUND',
    'Cross-user revision reads must fail with REVISION_NOT_FOUND.',
  );
}
try {
  await second.restore(firstCommit.revision);
  throw new Error('The second user restored another user revision.');
} catch (error) {
  assert(errorCode(error) === 'REVISION_NOT_FOUND', 'Cross-user restore must fail.');
}
await second.fs.writeFile('/mine.md', 'second user\n');
await second.commit();

const firstUserId = subjectFrom(firstToken);
const secondClient = createClient(supabaseUrl, publishableKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${secondToken}` } },
});
const escapedDownload = await secondClient.storage
  .from(bucket)
  .download(`${firstUserId}/notes/alpha.md`);
assert(escapedDownload.error !== null, 'Storage RLS allowed a cross-user download.');

await proveDelegatedAccess({
  bucket,
  firstToken,
  publishableKey,
  secondToken,
  serviceRoleKey,
  supabaseUrl,
});

const cleanupFirst = await open(firstToken);
for (const path of ['/notes', '/current', '/notes.md', '/delegated.md']) {
  if (await cleanupFirst.fs.exists(path)) {
    await cleanupFirst.fs.rm(path, { recursive: true });
  }
}
await cleanupFirst.commit();
const cleanupSecond = await open(secondToken);
if (await cleanupSecond.fs.exists('/mine.md')) {
  await cleanupSecond.fs.rm('/mine.md');
  await cleanupSecond.commit();
}

await deno.stdout.write(
  new TextEncoder().encode(
    `${JSON.stringify({
      deno: deno.version.deno,
      firstCommitChanges: firstCommit.changes.length,
      restoreParent: restored.parentRevision,
      result: 'ok',
    })}\n`,
  ),
);
