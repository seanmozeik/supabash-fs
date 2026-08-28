import {
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
  createDelegatedCapability,
  type PostgresDelegatedCapabilityClaims,
  Supabash,
} from '@seanmozeik/supabash-fs';

import {
  asRecord,
  assert,
  expectCode,
  subjectFrom,
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

const proveDelegated = async (
  context: LiveContext,
  core: CoreProof,
  secondUser: TestUser,
): Promise<void> => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in keys)) {
    throw new Error('Ed25519 did not return a key pair.');
  }
  const verifier = {
    audience: 'supabash-postgres-integration',
    issuer: 'https://issuer.example.test',
    origin: context.supabaseUrl,
    publicKeys: { integration: keys.publicKey },
  };
  await registerVerifier(context, keys.publicKey, verifier);
  const claims = delegatedClaims(context, core, verifier);
  const capability = await createDelegatedCapability({
    claims,
    keyId: 'integration',
    privateKey: keys.privateKey,
  });
  const delegated = await Supabash.openPostgresDelegated({
    capability,
    serviceRoleKey: context.serviceRoleKey,
    supabaseUrl: context.supabaseUrl,
    verifier,
  });
  const delegatedText = await delegated.fs.readFile('/docs/update.md');
  assert(delegatedText.includes('edge-runtime-marker'), 'Delegated read failed.');
  await delegated.fs.writeFile('/delegated.md', 'delegated write\n');
  await delegated.commit();
  await expectCode(
    delegated.checkpoint({ label: 'forbidden' }),
    'AUTHORIZATION',
    'Delegated capability exceeded its admitted operations.',
  );

  const restoreCapability = await createDelegatedCapability({
    claims: { ...claims, nonce: `${context.runId}-delegated-restore`, ops: ['read', 'restore'] },
    keyId: 'integration',
    privateKey: keys.privateKey,
  });
  const restoreOnly = await Supabash.openPostgresDelegated({
    capability: restoreCapability,
    serviceRoleKey: context.serviceRoleKey,
    supabaseUrl: context.supabaseUrl,
    verifier,
  });
  const restorePlan = await restoreOnly.restore(core.seed.revision);
  assert(restorePlan.sourceRevision === core.seed.revision, 'Delegated restore was denied.');
  await expectCode(restoreOnly.history(), 'AUTHORIZATION', 'Restore-only capability read history.');

  const grantCapability = await createDelegatedCapability({
    claims: { ...claims, nonce: `${context.runId}-delegated-grant` },
    keyId: 'integration',
    privateKey: keys.privateKey,
  });
  const exchange = asRecord(
    await context.serviceRpc('supabash_exchange_capability', { p_capability: grantCapability }),
    'capability exchange',
  );
  const { delegatedGrant } = exchange;
  assert(typeof delegatedGrant === 'string', 'Capability exchange returned no grant.');
  const otherWorkspace = await context.createWorkspace(secondUser.accessToken);
  const escaped = await context.serviceRpcResponse('supabash_load_workspace', {
    p_delegated_grant: delegatedGrant,
    p_workspace_id: otherWorkspace,
  });
  assert(!escaped.ok, 'A delegated database grant selected another workspace.');

  context.record('delegated capability workspace and operation isolation');
};

const delegatedClaims = (
  context: LiveContext,
  core: CoreProof,
  verifier: { readonly audience: string; readonly issuer: string; readonly origin: string },
): PostgresDelegatedCapabilityClaims => ({
  aud: verifier.audience,
  backend: 'postgres',
  corr: `${context.runId}-delegated`,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000) - 1,
  iss: verifier.issuer,
  nonce: `${context.runId}-delegated`,
  ops: ['read', 'write', 'commit', 'history'],
  origin: context.supabaseUrl,
  sub: subjectFrom(core.user.accessToken),
  sv: POSTGRES_CAPABILITY_SCHEMA_VERSION,
  workspace: core.workspaceId,
});

const registerVerifier = async (
  context: LiveContext,
  publicKey: CryptoKey,
  verifier: { readonly audience: string; readonly issuer: string; readonly origin: string },
): Promise<void> => {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  await context.serviceRpc('supabash_test_register_verifier', {
    p_audience: verifier.audience,
    p_issuer: verifier.issuer,
    p_key_id: 'integration',
    p_origin: verifier.origin,
    p_public_key_hex: [...raw].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  });
};
