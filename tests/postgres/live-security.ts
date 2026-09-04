import { proveDelegated } from './live-capability.ts';
import {
  assert,
  expectCode,
  type JsonRecord,
  type LiveContext,
  type TestUser,
} from './live-context.ts';
import type { CoreProof } from './live-core.ts';

export const proveSecurity = async (
  context: LiveContext,
  core: CoreProof,
  secondUser: TestUser,
  checkpointId: string,
): Promise<void> => {
  await proveIsolation(context, core, secondUser, checkpointId);
  await proveDelegated(context, core, secondUser);
};

const proveIsolation = async (
  context: LiveContext,
  core: CoreProof,
  secondUser: TestUser,
  checkpointId: string,
): Promise<void> => {
  const secondWorkspaceId = await context.createWorkspace(secondUser.accessToken);
  const second = await context.open(secondUser.accessToken, secondWorkspaceId);
  await second.fs.writeFile('/mine.md', 'second owner\n');
  await second.commit({
    context: { actor: 'second-owner', correlationId: `${context.runId}-second` },
  });
  await expectCode(
    context.open(secondUser.accessToken, core.workspaceId),
    'AUTHORIZATION',
    'Cross-owner snapshot opened.',
  );
  await expectCode(
    second.readRevision(core.seed.revision),
    'REVISION_NOT_FOUND',
    'Cross-owner historical revision opened.',
  );
  await expectCode(
    second.restore(core.seed.revision),
    'REVISION_NOT_FOUND',
    'Cross-owner restore was planned.',
  );
  for (const [name, args] of deniedCalls(context, core, checkpointId)) {
    await expectRpcDenied(context, secondUser.accessToken, name, args);
  }
  for (const table of [
    'bodies',
    'capability_nonces',
    'capability_verifiers',
    'checkpoints',
    'current_documents',
    'delegated_grants',
    'revision_changes',
    'revision_entries',
    'settings',
    'workspace_revisions',
    'workspaces',
  ]) {
    assert(
      await context.directTableDenied(secondUser.accessToken, table),
      `Authenticated direct table access succeeded for ${table}.`,
    );
  }
  context.record('cross-owner RPC denial and direct-table denial');
};

const deniedCalls = (
  context: LiveContext,
  core: CoreProof,
  checkpointId: string,
): readonly (readonly [string, JsonRecord])[] => [
  ['supabash_load_workspace', { p_workspace_id: core.workspaceId }],
  [
    'supabash_load_revision',
    { p_revision_id: core.seed.revision, p_workspace_id: core.workspaceId },
  ],
  ['supabash_history', { p_cursor: null, p_limit: 100, p_workspace_id: core.workspaceId }],
  [
    'supabash_diff',
    {
      p_from: { revision: core.seed.revision },
      p_paths: null,
      p_preview_bytes: null,
      p_staged_documents: [],
      p_to: { revision: core.seed.revision },
      p_workspace_id: core.workspaceId,
    },
  ],
  [
    'supabash_checkpoint',
    {
      p_idempotency_key: `${context.runId}-forbidden-checkpoint`,
      p_label: 'forbidden',
      p_retention_class: 'test',
      p_workspace_id: core.workspaceId,
    },
  ],
  ['supabash_checkpoints', { p_workspace_id: core.workspaceId }],
  [
    'supabash_delete_checkpoint',
    { p_checkpoint_id: checkpointId, p_workspace_id: core.workspaceId },
  ],
  [
    'supabash_purge',
    { p_dry_run: true, p_max_age_ms: null, p_max_revisions: 1, p_workspace_id: core.workspaceId },
  ],
  [
    'supabash_commit',
    {
      p_actor: 'forbidden',
      p_base_revision: core.seed.revision,
      p_cause: null,
      p_changes: [],
      p_correlation_id: `${context.runId}-forbidden`,
      p_fingerprint: 'forbidden',
      p_idempotency_key: `${context.runId}-forbidden`,
      p_metadata: {},
      p_receipt_changes: [],
      p_source_revision: null,
      p_transaction_id: crypto.randomUUID(),
      p_workspace_id: core.workspaceId,
    },
  ],
  ['supabash_test_manifest_stats', { p_workspace_id: core.workspaceId }],
];

const expectRpcDenied = async (
  context: LiveContext,
  accessToken: string,
  name: string,
  args: JsonRecord,
): Promise<void> => {
  const response = await context.rpc(accessToken, name, args);
  assert(!response.ok, `${name} allowed a cross-owner request.`);
  const body = JSON.stringify(response.body);
  assert(
    response.status === 401 ||
      response.status === 403 ||
      body.includes('SUPABASH_WORKSPACE_DENIED'),
    `${name} returned an unrelated error: HTTP ${response.status} ${body}`,
  );
};
