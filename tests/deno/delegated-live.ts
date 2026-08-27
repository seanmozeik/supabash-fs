import {
  CAPABILITY_SCHEMA_VERSION,
  createDelegatedCapability,
  Supabash,
  type DelegatedCapabilityClaims,
} from '@seanmozeik/supabash-fs';
import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';

import { assert, errorCode, subjectFrom } from './runtime.ts';
import { invokeTool, resultField } from './tool-runtime.ts';

export const proveDelegatedAccess = async (input: {
  readonly bucket: string;
  readonly firstToken: string;
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
    serviceRoleKey: input.serviceRoleKey,
    supabaseUrl: input.supabaseUrl,
    verifier: verifierFor(input, keys.publicKey),
  });
  const scoped = await workspace.fs.readFile('/notes.md');
  assert(scoped.includes('patched'), 'Delegated access could not read the scoped file.');
  await workspace.fs.writeFile('/delegated.md', 'from-job\n');
  const delegatedCommit = await workspace.commit();

  const expired = await createDelegatedCapability({
    claims: sampleClaims(input, firstUser, 'expired', { exp: Math.floor(Date.now() / 1000) - 120 }),
    keyId: 'k1',
    privateKey: keys.privateKey,
  });
  await expectCode(
    Supabash.openDelegated({
      bucket: input.bucket,
      capability: expired,
      serviceRoleKey: input.serviceRoleKey,
      supabaseUrl: input.supabaseUrl,
      verifier: verifierFor(input, keys.publicKey),
    }),
    'EXPIRED_CAPABILITY',
    'Expired delegated capability was accepted.',
  );

  const forged = tamperSignature(valid);
  assert(forged !== valid, 'Signature tampering did not change the capability.');
  await expectCode(
    Supabash.openDelegated({
      bucket: input.bucket,
      capability: forged,
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
    serviceRoleKey: input.serviceRoleKey,
    supabaseUrl: input.supabaseUrl,
    verifier: verifierFor(input, keys.publicKey),
  });
  assert(
    !(await other.fs.exists('/notes.md')),
    'A capability for another prefix saw the first workspace.',
  );
  const otherHistory = await other.history();
  assert(
    !otherHistory.records.some((record) => record.transactionId === delegatedCommit.transactionId),
    'A capability for another prefix saw the first workspace history.',
  );
  await expectCode(
    other.readRevision(delegatedCommit.revision),
    'REVISION_NOT_FOUND',
    'A capability for another prefix read the first workspace revision.',
  );
  await expectCode(
    other.restore(delegatedCommit.revision),
    'REVISION_NOT_FOUND',
    'A capability for another prefix restored the first workspace revision.',
  );

  const { tools } = await createTools({ workspace });
  const patched = await invokeTool(tools['apply_patch'], {
    callId: 'delegated-update',
    operation: { diff: '-from-job\n+still-scoped\n', path: '/delegated.md', type: 'update_file' },
  });
  assert(resultField(patched, 'status') === 'completed', 'Delegated Apply Patch failed.');
  await workspace.commit();
};

const tamperSignature = (capability: string): string => {
  const parts = capability.split('.');
  const [header, payload, signature] = parts;
  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    signature.length === 0
  ) {
    throw new Error('Capability has no signature.');
  }
  const replacement = signature.startsWith('A') ? 'B' : 'A';
  return `${header}.${payload}.${replacement}${signature.slice(1)}`;
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
