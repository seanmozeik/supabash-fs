import {
  createPostgresDelegatedCapability,
  importCapabilitySecret,
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
  type PostgresDelegatedCapabilityClaims,
  Supabash,
} from '@seanmozeik/supabash-fs';

import {
  asRecord,
  assert,
  expectCode,
  subjectFrom,
  type Json,
  type LiveContext,
  type TestUser,
} from './live-context.ts';
import type { CoreProof } from './live-core.ts';

const KEY_ID = 'integration';
const text = new TextEncoder();

interface Audience {
  readonly audience: string;
  readonly issuer: string;
  readonly origin: string;
}

export const proveDelegated = async (
  context: LiveContext,
  core: CoreProof,
  secondUser: TestUser,
): Promise<void> => {
  const verifier: Audience = {
    audience: 'supabash-postgres-integration',
    issuer: 'https://issuer.example.test',
    origin: context.supabaseUrl,
  };
  const secretKey = await importCapabilitySecret(await registerVerifier(context, verifier));
  const claims = delegatedClaims(context, core, verifier);

  await proveScopedAccess(context, core, secretKey, claims);
  await proveGrantIsolation(context, secondUser, secretKey, claims);
  await proveRejections(context, secretKey, claims);
  await provePrivilegeBoundary(context);
  await proveRevocation(context, secretKey, claims);

  context.record('delegated capability workspace and operation isolation');
  context.record('delegated capability rejection, replay, and privilege boundary');
};

const proveScopedAccess = async (
  context: LiveContext,
  core: CoreProof,
  secretKey: CryptoKey,
  claims: PostgresDelegatedCapabilityClaims,
): Promise<void> => {
  const delegated = await Supabash.openPostgresDelegated({
    capability: await mint(secretKey, claims),
    serviceRoleKey: context.serviceRoleKey,
    supabaseUrl: context.supabaseUrl,
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

  const restoreOnly = await Supabash.openPostgresDelegated({
    capability: await mint(secretKey, {
      ...claims,
      nonce: `${context.runId}-delegated-restore`,
      ops: ['read', 'restore'],
    }),
    serviceRoleKey: context.serviceRoleKey,
    supabaseUrl: context.supabaseUrl,
  });
  const restorePlan = await restoreOnly.restore(core.seed.revision);
  assert(restorePlan.sourceRevision === core.seed.revision, 'Delegated restore was denied.');
  await expectCode(restoreOnly.history(), 'AUTHORIZATION', 'Restore-only capability read history.');
};

const proveGrantIsolation = async (
  context: LiveContext,
  secondUser: TestUser,
  secretKey: CryptoKey,
  claims: PostgresDelegatedCapabilityClaims,
): Promise<void> => {
  const capability = await mint(secretKey, {
    ...claims,
    nonce: `${context.runId}-delegated-grant`,
  });
  const exchange = asRecord(
    await context.serviceRpc('supabash_exchange_capability', { p_capability: capability }),
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

  const replayed = await context.serviceRpcResponse('supabash_exchange_capability', {
    p_capability: capability,
  });
  assert(
    !replayed.ok && failedWith(replayed.body, 'SUPABASH_CAPABILITY_NONCE_REUSED'),
    'A capability nonce was accepted twice.',
  );
};

const proveRejections = async (
  context: LiveContext,
  secretKey: CryptoKey,
  claims: PostgresDelegatedCapabilityClaims,
): Promise<void> => {
  const forged = await mint(await importCapabilitySecret(randomSecret()), {
    ...claims,
    nonce: `${context.runId}-delegated-forged`,
  });
  await expectRefusal(
    context,
    forged,
    'SUPABASH_INVALID_CAPABILITY',
    'a capability signed with an unregistered secret',
  );

  await expectRefusal(
    context,
    await raw(secretKey, header('HS256'), {
      ...claims,
      nonce: `${context.runId}-delegated-sv2`,
      sv: 2,
    }),
    'SUPABASH_INVALID_CAPABILITY',
    'a capability whose sv claim is not the supported schema version',
  );

  await expectRefusal(
    context,
    await raw(secretKey, header('EdDSA'), { ...claims, nonce: `${context.runId}-delegated-eddsa` }),
    'SUPABASH_INVALID_CAPABILITY',
    'an EdDSA capability header',
  );

  const now = Math.floor(Date.now() / 1000);
  await expectRefusal(
    context,
    await mint(secretKey, {
      ...claims,
      exp: now - 3600,
      iat: now - 3700,
      nonce: `${context.runId}-delegated-expired`,
    }),
    'SUPABASH_EXPIRED_CAPABILITY',
    'an expired capability',
  );
};

const provePrivilegeBoundary = async (context: LiveContext): Promise<void> => {
  const report = asRecord(
    await context.serviceRpc('supabash_test_privilege_report', {}),
    'privilege report',
  );
  for (const key of ['functionPrivileges', 'tablePrivileges', 'schemaUsage']) {
    const findings = report[key];
    assert(Array.isArray(findings), `The privilege report has no ${key}.`);
    assert(
      findings.length === 0,
      `A PostgREST role holds privileges it must not: ${key} = ${JSON.stringify(findings)}.`,
    );
  }

  const registration = await context.serviceRpcResponse('supabash_register_capability_verifier', {
    p_audience: 'attacker',
    p_issuer: 'attacker',
    p_key_id: 'attacker',
    p_origin: context.supabaseUrl,
  });
  assert(!registration.ok, 'The service role registered a capability verifier.');
  const revocation = await context.serviceRpcResponse('supabash_revoke_capability_verifier', {
    p_key_id: KEY_ID,
  });
  assert(!revocation.ok, 'The service role revoked a capability verifier.');
};

const proveRevocation = async (
  context: LiveContext,
  secretKey: CryptoKey,
  claims: PostgresDelegatedCapabilityClaims,
): Promise<void> => {
  await context.serviceRpc('supabash_test_revoke_verifier', { p_key_id: KEY_ID });
  await expectRefusal(
    context,
    await mint(secretKey, { ...claims, nonce: `${context.runId}-delegated-revoked` }),
    'SUPABASH_INVALID_CAPABILITY',
    'a capability for a revoked key',
  );
};

const expectRefusal = async (
  context: LiveContext,
  capability: string,
  marker: string,
  label: string,
): Promise<void> => {
  const response = await context.serviceRpcResponse('supabash_exchange_capability', {
    p_capability: capability,
  });
  assert(
    !response.ok && failedWith(response.body, marker),
    `The database accepted ${label}: HTTP ${response.status} ${JSON.stringify(response.body)}.`,
  );
};

const failedWith = (body: Json, marker: string): boolean => JSON.stringify(body).includes(marker);

const delegatedClaims = (
  context: LiveContext,
  core: CoreProof,
  verifier: Audience,
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

const registerVerifier = async (context: LiveContext, verifier: Audience): Promise<string> => {
  const secret = await context.serviceRpc('supabash_test_register_verifier', {
    p_audience: verifier.audience,
    p_issuer: verifier.issuer,
    p_key_id: KEY_ID,
    p_origin: verifier.origin,
  });
  assert(typeof secret === 'string', 'Verifier registration returned no secret.');
  return secret;
};

const mint = (secretKey: CryptoKey, claims: PostgresDelegatedCapabilityClaims): Promise<string> =>
  createPostgresDelegatedCapability({ claims, keyId: KEY_ID, secretKey });

const header = (algorithm: string): Record<string, string> => ({
  alg: algorithm,
  kid: KEY_ID,
  typ: 'JWS',
});

/** Builds a compact JWS the public signer would refuse to mint. */
const raw = async (
  secretKey: CryptoKey,
  jwsHeader: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<string> => {
  const signingInput = `${base64url(text.encode(JSON.stringify(jwsHeader)))}.${base64url(
    text.encode(JSON.stringify(payload)),
  )}`;
  const signature = await crypto.subtle.sign(
    { name: 'HMAC' },
    secretKey,
    text.encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
};

const randomSecret = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
