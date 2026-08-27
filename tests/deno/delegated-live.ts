import {
  applyPatch,
  CAPABILITY_SCHEMA_VERSION,
  createDelegatedCapability,
  Supabash,
  type DelegatedCapabilityClaims,
} from '@seanmozeik/supabash-fs';

import { assert, errorCode, subjectFrom } from './runtime.ts';

export const proveDelegatedAccess = async (input: {
  readonly bucket: string;
  readonly firstToken: string;
  readonly publishableKey: string;
  readonly secondToken: string;
  readonly serviceRoleKey: string;
  readonly supabaseUrl: string;
}): Promise<void> => {
  const keys = await ed25519Pair();
  const firstUser = subjectFrom(input.firstToken);
  const secondUser = subjectFrom(input.secondToken);
  const valid = await createDelegatedCapability({
    claims: sampleClaims(input, firstUser, 'job-live'),
    keyId: 'k1',
    privateKey: keys.privateKey,
  });
  const workspace = await Supabash.openDelegated({
    bucket: input.bucket,
    capability: valid,
    publishableKey: input.publishableKey,
    serviceRoleKey: input.serviceRoleKey,
    supabaseUrl: input.supabaseUrl,
    verifier: verifierFor(input, keys.publicKey),
  });
  const scoped = await workspace.fs.readFile('/notes.md');
  assert(scoped.includes('patched'), 'Delegated access could not read the scoped file.');
  await workspace.fs.writeFile('/delegated.md', 'from-job\n');
  await workspace.commit();

  const expired = await createDelegatedCapability({
    claims: sampleClaims(input, firstUser, 'expired', { exp: Math.floor(Date.now() / 1000) - 120 }),
    keyId: 'k1',
    privateKey: keys.privateKey,
  });
  await expectCode(
    Supabash.openDelegated({
      bucket: input.bucket,
      capability: expired,
      publishableKey: input.publishableKey,
      serviceRoleKey: input.serviceRoleKey,
      supabaseUrl: input.supabaseUrl,
      verifier: verifierFor(input, keys.publicKey),
    }),
    'EXPIRED_CAPABILITY',
    'Expired delegated capability was accepted.',
  );

  const forged = `${valid.slice(0, -2)}AA`;
  await expectCode(
    Supabash.openDelegated({
      bucket: input.bucket,
      capability: forged,
      publishableKey: input.publishableKey,
      serviceRoleKey: input.serviceRoleKey,
      supabaseUrl: input.supabaseUrl,
      verifier: verifierFor(input, keys.publicKey),
    }),
    'INVALID_CAPABILITY',
    'A forged delegated capability was accepted.',
  );

  const wrongScope = await createDelegatedCapability({
    claims: sampleClaims(input, secondUser, 'wrong-scope'),
    keyId: 'k1',
    privateKey: keys.privateKey,
  });
  const other = await Supabash.openDelegated({
    bucket: input.bucket,
    capability: wrongScope,
    publishableKey: input.publishableKey,
    serviceRoleKey: input.serviceRoleKey,
    supabaseUrl: input.supabaseUrl,
    verifier: verifierFor(input, keys.publicKey),
  });
  assert(
    !(await other.fs.exists('/notes.md')),
    'A capability for another prefix saw the first workspace.',
  );

  const patched = await applyPatch(workspace, {
    diff: '-from-job\n+still-scoped\n',
    path: '/delegated.md',
    type: 'update_file',
  });
  assert(patched.status === 'completed', 'Delegated Apply Patch failed.');
  await workspace.commit();
};

const sampleClaims = (
  input: { readonly bucket: string; readonly supabaseUrl: string },
  prefix: string,
  sub: string,
  overrides: Partial<DelegatedCapabilityClaims> = {},
): DelegatedCapabilityClaims => ({
  aud: 'supabash-live',
  bucket: input.bucket,
  corr: `live-${sub}`,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000) - 1,
  iss: 'https://example.invalid/issuer',
  nonce: `${sub}-${Date.now()}`,
  ops: ['read', 'write', 'commit', 'history', 'checkpoint', 'restore'],
  origin: input.supabaseUrl,
  prefix,
  sub,
  sv: CAPABILITY_SCHEMA_VERSION,
  ...overrides,
});

const verifierFor = (
  input: { readonly supabaseUrl: string },
  publicKey: CryptoKey,
): {
  readonly audience: string;
  readonly issuer: string;
  readonly origin: string;
  readonly publicKeys: Readonly<Record<string, CryptoKey>>;
} => ({
  audience: 'supabash-live',
  issuer: 'https://example.invalid/issuer',
  origin: input.supabaseUrl,
  publicKeys: { k1: publicKey },
});

const ed25519Pair = async (): Promise<CryptoKeyPair> => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) {
    throw new Error('Ed25519 generateKey did not return a key pair.');
  }
  return pair;
};

const expectCode = async (work: Promise<unknown>, code: string, message: string): Promise<void> => {
  try {
    await work;
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw error;
    }
    assert(errorCode(error) === code, message);
  }
};
