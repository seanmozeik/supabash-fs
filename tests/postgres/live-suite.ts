import { asRecord, assert, parseJson, type JsonRecord, type LiveContext } from './live-context.ts';
import { proveCore } from './live-core.ts';
import { proveHistoryAndRetention } from './live-history.ts';
import { proveSecurity } from './live-security.ts';

export const runPostgresIntegration = async (
  context: LiveContext,
  denoVersion: string,
): Promise<JsonRecord> => {
  const firstUser = await context.createUser('owner-a');
  const secondUser = await context.createUser('owner-b');
  const core = await proveCore(context, firstUser);
  const history = await proveHistoryAndRetention(context, core);
  await proveSecurity(context, core, secondUser, history.checkpointId);

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
  context.record('Supabase Edge Runtime package import and Bash projection');

  return {
    assertionCount: context.assertions.length,
    assertions: context.assertions,
    deno: denoVersion,
    edgeDeno: typeof edge['denoVersion'] === 'string' ? edge['denoVersion'] : 'unknown',
    result: 'ok',
  };
};
