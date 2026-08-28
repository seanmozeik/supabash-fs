import type { CommitReceipt } from '@seanmozeik/supabash-fs';
import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';
import type { ToolSet } from 'ai';

import { invokeTool, resultField } from '../deno/tool-runtime.ts';
import { assert, errorCode, type LiveContext, type TestUser } from './live-context.ts';

export interface CoreProof {
  readonly atomic: CommitReceipt;
  readonly seed: CommitReceipt;
  readonly user: TestUser;
  readonly workspaceId: string;
}

export const proveCore = async (context: LiveContext, user: TestUser): Promise<CoreProof> => {
  const workspaceId = await context.createWorkspace(user.accessToken);
  const workspace = await context.open(user.accessToken, workspaceId);
  const fixtures = new Map<string, string>([
    ['/docs/delete.md', 'delete me\n'],
    ['/docs/move.md', 'move me\n'],
    ['/docs/update.md', 'alpha edge-runtime-marker\n'],
    ['/empty.md', ''],
    ['/nested/space name.md', 'tabs\tand trailing spaces  \n'],
    ['/unicode/患者-Δ-🙂.md', 'café\ne\u0301\n患者🙂\n'],
  ]);
  for (const [path, body] of fixtures) {
    await workspace.fs.mkdir(parent(path), { recursive: true });
    await workspace.fs.writeFile(path, body);
  }
  const seed = await workspace.commit({
    context: {
      actor: 'integration-owner',
      cause: 'seed',
      correlationId: `${context.runId}-seed`,
      idempotencyKey: `${context.runId}-seed`,
      metadata: { suite: 'postgres-integration' },
    },
  });
  assert(seed.parentRevision === null, 'Initial revision has a parent.');
  await proveSnapshot(context, user.accessToken, workspaceId, seed, fixtures);
  const atomic = await proveTools(context, user.accessToken, workspaceId, seed);
  await proveCas(context, user.accessToken, workspaceId);
  await proveRollback(context, user.accessToken);
  return { atomic, seed, user, workspaceId };
};

const proveSnapshot = async (
  context: LiveContext,
  accessToken: string,
  workspaceId: string,
  receipt: CommitReceipt,
  fixtures: ReadonlyMap<string, string>,
): Promise<void> => {
  const reopened = await context.open(accessToken, workspaceId);
  const history = await reopened.history();
  assert(
    history.records[0]?.revision === receipt.revision,
    'Snapshot and history do not share one head.',
  );
  for (const [path, body] of fixtures) {
    assert(
      equalBytes(await reopened.fs.readFile(path), body),
      `UTF-8 round trip failed for ${path}.`,
    );
  }
  const historical = await reopened.readRevision(receipt.revision);
  assert(
    equalBytes(
      await historical.readFile('/unicode/患者-Δ-🙂.md'),
      fixtures.get('/unicode/患者-Δ-🙂.md') ?? '',
    ),
    'Historical UTF-8 bytes changed.',
  );
  context.record('pinned snapshot and exact UTF-8 round trips');
};

const proveTools = async (
  context: LiveContext,
  accessToken: string,
  workspaceId: string,
  seed: CommitReceipt,
): Promise<CommitReceipt> => {
  const workspace = await context.open(accessToken, workspaceId);
  const { tools } = await createTools({ workspace });
  await bash(tools, "grep -R -n 'edge-runtime-marker' /docs");
  await bash(tools, "find /docs -type f -name '*.md' | sort");
  const unicode = await bash(tools, "cat '/unicode/患者-Δ-🙂.md'");
  assert(String(resultField(unicode, 'stdout')).includes('患者🙂'), 'Bash changed Unicode text.');
  await bash(tools, String.raw`printf '# Draft\n' > /scratch.md`);
  await bash(tools, String.raw`printf 'line 2\n' >> /scratch.md`);
  await bash(tools, "sed -i 's/Draft/Edited/' /scratch.md");
  await bash(tools, 'mkdir -p /archive');
  await bash(tools, 'mv /docs/move.md /archive/moved.md');
  await bash(tools, 'rm /docs/delete.md');
  await bash(tools, String.raw`printf 'runtime-owned\n' > /tmp/ignored.md`);
  const patch = await invokeTool(tools['apply_patch'], {
    callId: 'postgres-create',
    operation: { diff: '+created by Apply Patch\n+', path: '/patched.md', type: 'create_file' },
  });
  assert(resultField(patch, 'status') === 'completed', 'Apply Patch did not stage a file.');
  const changes = workspace.changes();
  assert(!changes.some(({ path }) => path.startsWith('/tmp/')), 'Runtime-owned paths were staged.');
  assert(
    changes.some(({ kind }) => kind === 'move'),
    'A baseline move was not preserved.',
  );
  assert(
    changes.some(({ kind }) => kind === 'delete'),
    'A baseline delete was not preserved.',
  );
  const atomic = await workspace.commit({
    context: {
      actor: 'integration-owner',
      cause: 'tool-commit',
      correlationId: `${context.runId}-tools`,
      idempotencyKey: `${context.runId}-tools`,
    },
  });
  assert(atomic.parentRevision === seed.revision, 'Atomic commit has the wrong parent.');
  assert(atomic.changes.length >= 4, 'Atomic commit omitted changes.');
  const reopened = await context.open(accessToken, workspaceId);
  assert(
    (await reopened.fs.readFile('/scratch.md')) === '# Edited\nline 2\n',
    'Bash text did not persist.',
  );
  assert(
    (await reopened.fs.readFile('/archive/moved.md')) === 'move me\n',
    'Move did not persist.',
  );
  assert(!(await reopened.fs.exists('/docs/delete.md')), 'Delete did not persist.');
  assert(
    (await reopened.fs.readFile('/patched.md')) === 'created by Apply Patch\n',
    'Apply Patch did not persist.',
  );
  context.record('real Bash, Apply Patch, and one atomic multi-change commit');
  return atomic;
};

const proveCas = async (
  context: LiveContext,
  accessToken: string,
  workspaceId: string,
): Promise<void> => {
  const writerA = await context.open(accessToken, workspaceId);
  const writerB = await context.open(accessToken, workspaceId);
  await writerA.fs.writeFile('/concurrency-a.md', 'writer a\n');
  await writerB.fs.writeFile('/concurrency-b.md', 'writer b\n');
  const settled = await Promise.allSettled([
    writerA.commit({ context: { actor: 'writer-a', correlationId: `${context.runId}-a` } }),
    writerB.commit({ context: { actor: 'writer-b', correlationId: `${context.runId}-b` } }),
  ]);
  const successes = settled.filter(({ status }) => status === 'fulfilled');
  const failures = settled.filter(({ status }) => status === 'rejected');
  assert(successes.length === 1 && failures.length === 1, 'CAS did not produce one winner.');
  const [failure] = failures;
  assert(failure?.status === 'rejected', 'CAS loser result is missing.');
  assert(errorCode(failure.reason) === 'COMMIT_CONFLICT', 'CAS loser has the wrong error.');
  const reopened = await context.open(accessToken, workspaceId);
  const hasA = await reopened.fs.exists('/concurrency-a.md');
  const hasB = await reopened.fs.exists('/concurrency-b.md');
  assert(hasA !== hasB, 'CAS loser became visible.');
  context.record('atomic compare-and-swap concurrency');
};

const proveRollback = async (context: LiveContext, accessToken: string): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const workspace = await context.open(accessToken, workspaceId);
  await workspace.fs.writeFile('/keep.md', 'before\n');
  const seed = await workspace.commit({
    context: { actor: 'rollback-seed', correlationId: `${context.runId}-rollback-seed` },
  });
  await context.serviceRpc('supabash_test_fail_next_commit', { p_workspace_id: workspaceId });
  await workspace.fs.writeFile('/new.md', 'must roll back\n');
  await workspace.fs.rm('/keep.md');
  try {
    await workspace.commit({
      context: { actor: 'rollback', correlationId: `${context.runId}-rollback` },
    });
    throw new Error('Injected commit failure did not fail.');
  } catch (error) {
    if (error instanceof Error && error.message === 'Injected commit failure did not fail.') {
      throw error;
    }
  } finally {
    await context.serviceRpc('supabash_test_clear_commit_failure', { p_workspace_id: workspaceId });
  }
  const reopened = await context.open(accessToken, workspaceId);
  assert((await reopened.fs.readFile('/keep.md')) === 'before\n', 'Rollback changed a document.');
  assert(!(await reopened.fs.exists('/new.md')), 'Rollback exposed a new document.');
  const history = await reopened.history();
  assert(
    history.records.length === 1 && history.records[0]?.revision === seed.revision,
    'Rollback left revision rows.',
  );
  context.record('injected database failure rolls back the complete commit');
};

const bash = async (tools: ToolSet, command: string) => {
  const result = await invokeTool(tools['bash'], { command });
  assert(
    resultField(result, 'exitCode') === 0,
    `Bash failed: ${command}\n${resultField(result, 'stderr') ?? ''}`,
  );
  return result;
};

const parent = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
const equalBytes = (left: string, right: string): boolean => {
  const encoder = new TextEncoder();
  const first = encoder.encode(left);
  const second = encoder.encode(right);
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
};
