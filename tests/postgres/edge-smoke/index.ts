import { createMountedFileSystem, readWorkspaceSnapshot, Supabash } from '@seanmozeik/supabash-fs';
import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';

import { asRecord, formatError, parseJson } from '../live-context.ts';
import { edgeRuntime, isRecord } from '../runtime.ts';

const runtime = edgeRuntime();

runtime.serve(async (request) => {
  try {
    const authorization = request.headers.get('authorization');
    const publishableKey = runtime.env.get('SUPABASH_TEST_PUBLISHABLE_KEY');
    const supabaseUrl = runtime.env.get('SUPABASH_TEST_SUPABASE_URL');
    if (authorization === null || publishableKey === undefined || supabaseUrl === undefined) {
      return Response.json({ error: 'missing authenticated runtime context' }, { status: 401 });
    }
    const input = asRecord(parseJson(await request.json()), 'Edge request');
    const workspaceId = input['workspace'];
    if (typeof workspaceId !== 'string') {
      return Response.json({ error: 'workspace is required' }, { status: 400 });
    }
    const openedWorkspace = await Supabash.openPostgres({
      publishableKey,
      request: new Request(request.url, { headers: { authorization } }),
      supabaseUrl,
      workspace: workspaceId,
    });
    const history = await openedWorkspace.history();
    const revision = history.records.at(-1)?.revision;
    if (revision === undefined) {
      throw new Error('Smoke workspace has no retained revision.');
    }
    const snapshot = await readWorkspaceSnapshot({
      workspace: openedWorkspace,
      sourceId: 'edge-reference',
      revision,
    });
    const mounted = createMountedFileSystem([
      {
        access: 'read-write',
        mountPoint: '/memories',
        sourceId: workspaceId,
        workspace: openedWorkspace,
      },
      { access: 'read-only', mountPoint: '/docs', snapshot, view: { root: '/docs' } },
    ]);
    const { tools } = await createTools({ filesystem: mounted.fs });
    const { bash } = tools;
    if (bash?.execute === undefined) {
      throw new Error('Bash tool is unavailable.');
    }
    const result: unknown = await bash.execute(
      { command: "grep -R -l 'edge-runtime-marker' /docs | wc -l" },
      { context: {}, messages: [], toolCallId: crypto.randomUUID() },
    );
    if (!isToolResult(result) || result.exitCode !== 0) {
      throw new Error('Bash smoke command failed.');
    }
    const denied: unknown = await bash.execute(
      { command: 'echo forbidden > /docs/update.md' },
      { context: {}, messages: [], toolCallId: crypto.randomUUID() },
    );
    if (!isToolResult(denied) || denied.exitCode === 0 || openedWorkspace.changes().length !== 0) {
      throw new Error('Edge Runtime did not enforce the read-only mount.');
    }
    return Response.json({
      backend: openedWorkspace.capabilities.backend,
      denoVersion: runtime.version.deno,
      matches: Math.trunc(Number(result.stdout.trim())),
      runtime: 'supabase-edge-runtime',
      readonlyMountEnforced: true,
    });
  } catch (error) {
    return Response.json({ error: formatError(error) }, { status: 500 });
  }
});

interface ToolResult {
  readonly exitCode: number;
  readonly stdout: string;
}

const isToolResult = (value: unknown): value is ToolResult =>
  isRecord(value) && typeof value['exitCode'] === 'number' && typeof value['stdout'] === 'string';
