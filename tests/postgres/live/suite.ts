import { proveBatchWrites } from '../batch/live.ts';
import { proveLazyReads } from '../lazy/live.ts';
import { asRecord, assert, parseJson, type JsonRecord, type LiveContext } from './context.ts';
import { proveCore } from './core.ts';
import { proveHistoryAndRetention } from './history.ts';
import { proveMountedPublishing } from './mounts.ts';
import { proveSecurity } from './security.ts';

export const runPostgresIntegration = async (
  context: LiveContext,
  denoVersion: string,
): Promise<JsonRecord> => {
  const firstUser = await context.createUser('owner-a');
  const secondUser = await context.createUser('owner-b');
  await proveLazyReads(context, firstUser, secondUser);
  await proveBatchWrites(context, firstUser);
  const core = await proveCore(context, firstUser);
  const history = await proveHistoryAndRetention(context, core);
  await proveSecurity(context, core, secondUser, history.checkpointId);
  await proveMountedPublishing(context, firstUser, secondUser);

  const workspace = await context.open(firstUser.accessToken, core.workspaceId);
  await workspace.deleteCheckpoint(history.checkpointId);
  const checkpoints = await workspace.checkpoints();
  assert(checkpoints.length === 0, 'Checkpoint deletion did not persist.');
  context.record('checkpoint listing and deletion');

  const response = await fetch(`${context.functionsUrl}/supabash-postgres-smoke`, {
    body: JSON.stringify({ workspace: core.workspaceId }),
    headers: {
      apikey: context.publishableKey,
      authorization: `Bearer ${firstUser.accessToken}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert(response.ok, `Edge Runtime smoke failed (${response.status}): ${text}`);
  const edge = asRecord(parseJson(JSON.parse(text)), 'Edge Runtime response');
  assert(edge['backend'] === 'postgres', 'Edge Runtime opened the wrong backend.');
  assert(Number(edge['matches']) > 0, 'Edge Runtime Bash did not find the marker.');
  assert(edge['readonlyMountEnforced'] === true, 'Edge Runtime did not enforce read-only mounts.');
  context.record(
    'Supabase Edge Runtime revision snapshot, mounted Bash, and read-only enforcement',
  );

  return {
    assertionCount: context.assertions.length,
    assertions: context.assertions,
    deno: denoVersion,
    edgeDeno: typeof edge['denoVersion'] === 'string' ? edge['denoVersion'] : 'unknown',
    result: 'ok',
  };
};
