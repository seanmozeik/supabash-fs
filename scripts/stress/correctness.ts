import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { Supabash, SupabashError, type PostgresWorkspace } from '../../dist/index.js';

assert.equal(process.env['MODAL_STRESS_REMOTE'], '1');
assert.equal(process.env['API_URL'], 'http://127.0.0.1:54321');
const url = 'http://127.0.0.1:54321';
const key = process.env['ANON_KEY'];
const secret = process.env['JWT_SECRET'];
if (key === undefined || key === '' || secret === undefined || secret === '') {
  throw new Error('Disposable stack credentials are missing.');
}
const id = (prefix: string, n: number): string =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const encoded = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (n: number): string => {
  const unsigned = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: id('1', n), role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 7200 })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
};
const request = (n: number): Request =>
  new Request('https://stress.example.test', { headers: { authorization: `Bearer ${jwt(n)}` } });
let transferredBytes = 0;
const measuredFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
  const bytes = await response.arrayBuffer();
  transferredBytes += bytes.byteLength;
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
const open = (n: number): Promise<PostgresWorkspace> =>
  Supabash.openPostgres({
    workspace: id('2', n),
    supabaseUrl: url,
    publishableKey: key,
    request: request(n),
    fetch: Object.assign(measuredFetch, { preconnect: fetch.preconnect }),
  });
const commit = (workspace: PostgresWorkspace) =>
  workspace.commit({
    context: { actor: 'stress-correctness', correlationId: crypto.randomUUID() },
  });
interface LargeWorkspaceResult {
  files: number;
  nominalBodyBytes: number;
  seedMs: number;
  openMs: number;
  openBytes: number;
  firstReadMs: number;
  firstReadBytes: number;
  singleFileCommitMs: number[];
  fullSnapshotMs: number;
  eagerWorkspaceMs: number;
  eagerWorkspaceBytes: number;
  singleBatchSeedFailure: string | null;
  seedBatchFiles: number;
}
const largeWorkspaces: LargeWorkspaceResult[] = [];
const result = { version: '0.7.0-candidate', contention: {}, lockTimeout: {}, largeWorkspaces };

const writers = await Promise.all(Array.from({ length: 64 }, () => open(1)));
await Promise.all(writers.map((workspace, n) => workspace.fs.writeFile('/race.md', `writer-${n}`)));
const started = performance.now();
const commits = await Promise.allSettled(writers.map((workspace) => commit(workspace)));
const winners = commits.flatMap((outcome, n) => (outcome.status === 'fulfilled' ? [n] : []));
const rejected = commits.flatMap((outcome) =>
  outcome.status === 'rejected'
    ? [outcome.reason instanceof SupabashError ? outcome.reason.code : 'UNKNOWN_FAILURE']
    : [],
);
assert.equal(winners.length, 1, 'Exactly one stale-base writer must win.');
assert.ok(rejected.every((code) => code === 'COMMIT_CONFLICT' || code === 'COMMIT_COORDINATION'));
const reopened = await open(1);
assert.equal(await reopened.fs.readFile('/race.md'), `writer-${winners[0]}`);
result.contention = {
  writers: 64,
  acknowledged: winners.length,
  rejected,
  elapsedMs: performance.now() - started,
  winnerVerified: true,
};
process.stdout.write('Concurrent same-workspace commit check passed.\n');

const blocked = await open(9004);
await blocked.fs.writeFile('/blocked.md', 'must not commit while the lock is held');
const databaseCommand = [
  'docker',
  'exec',
  'supabase_db_stack',
  'psql',
  '-U',
  'postgres',
  '-d',
  'postgres',
  '-Atqc',
];
const holder = Bun.spawn(
  [
    ...databaseCommand,
    "set application_name='supabash-stress-lock'; begin; select pg_advisory_xact_lock(hashtextextended('supabash:20000000-0000-4000-8000-000000009004',0)); select pg_sleep(5); commit;",
  ],
  { stdout: 'pipe', stderr: 'pipe' },
);
try {
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const check = Bun.spawn(
      [
        ...databaseCommand,
        "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='supabash-stress-lock' and l.locktype='advisory' and l.granted",
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const text = await new Response(check.stdout).text();
    assert.equal(await check.exited, 0);
    if (text.trim() === '1') {
      ready = true;
      break;
    }
    await Bun.sleep(50);
  }
  assert.equal(ready, true, 'The deliberate test lock was not acquired.');
  const at = performance.now();
  await assert.rejects(
    commit(blocked),
    (error: unknown) =>
      error instanceof SupabashError && error.code === 'COMMIT_COORDINATION' && error.retryable,
  );
  const elapsedMs = performance.now() - at;
  assert.ok(
    elapsedMs >= 900 && elapsedMs < 3000,
    'Lock wait did not respect the one-second bound.',
  );
  result.lockTimeout = { elapsedMs, code: 'COMMIT_COORDINATION', retryable: true };
} finally {
  assert.equal(await holder.exited, 0);
}
process.stdout.write('Bounded lock-wait check passed.\n');

for (const [index, count] of [100, 1000, 5000].entries()) {
  const n = 9001 + index;
  const workspace = await open(n);
  const seedStarted = performance.now();
  for (let i = 0; i < count; i += 1) {
    await workspace.fs.writeFile(`/file-${i}.md`, `${i}\n${randomBytes(3072).toString('base64')}`);
  }
  let singleBatchSeedFailure: string | null = null;
  let seedBatchFiles = count;
  try {
    await commit(workspace);
  } catch (error) {
    if (!(error instanceof SupabashError)) {
      throw error;
    }
    const { cause } = error;
    if (
      typeof cause !== 'object' ||
      cause === null ||
      !('code' in cause) ||
      cause.code !== '57014'
    ) {
      throw error;
    }
    singleBatchSeedFailure = '57014: database statement timeout; initial atomic seed failed';
    const recovery = await open(n);
    assert.equal(
      recovery.committedRevision(),
      workspace.committedRevision(),
      'Timed-out seed changed the durable head.',
    );
    await workspace.discard();
    seedBatchFiles = 250;
    for (let i = 0; i < count; i += 1) {
      await recovery.fs.writeFile(`/file-${i}.md`, `${i}\n${randomBytes(3072).toString('base64')}`);
      if ((i + 1) % seedBatchFiles === 0 || i + 1 === count) {
        await commit(recovery);
      }
    }
  }
  const seedMs = performance.now() - seedStarted;
  transferredBytes = 0;
  const openedAt = performance.now();
  const reader = await open(n);
  const openMs = performance.now() - openedAt;
  const openBytes = transferredBytes;
  const readAt = performance.now();
  await reader.fs.readFile('/file-0.md');
  const firstReadMs = performance.now() - readAt;
  const firstReadBytes = transferredBytes - openBytes;
  const timings = [];
  for (let i = 0; i < 10; i += 1) {
    await reader.fs.writeFile('/file-0.md', `updated-${i}`);
    const at = performance.now();
    await commit(reader);
    timings.push(performance.now() - at);
  }
  const verified = await open(n);
  assert.equal(await verified.fs.readFile('/file-0.md'), 'updated-9');
  const snapshotAt = performance.now();
  const full = await verified.committedSnapshot();
  assert.equal(full.documents.length, count);
  const fullSnapshotMs = performance.now() - snapshotAt;
  const eagerAt = performance.now();
  const eager: Response = await fetch(`${url}/rest/v1/rpc/supabash_load_workspace`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${jwt(n)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_workspace_id: id('2', n) }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(eager.status, 200);
  const eagerBody = await eager.arrayBuffer();
  const eagerWorkspaceBytes = eagerBody.byteLength;
  const eagerWorkspaceMs = performance.now() - eagerAt;
  result.largeWorkspaces.push({
    files: count,
    nominalBodyBytes: count * 4096,
    seedMs,
    openMs,
    openBytes,
    firstReadMs,
    firstReadBytes,
    singleFileCommitMs: timings,
    fullSnapshotMs,
    eagerWorkspaceMs,
    eagerWorkspaceBytes,
    singleBatchSeedFailure,
    seedBatchFiles,
  });
  writeFileSync('/results/correctness.json', JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result.largeWorkspaces.at(-1))}\n`);
}
