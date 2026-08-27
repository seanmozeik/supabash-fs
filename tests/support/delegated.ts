import {
  CAPABILITY_SCHEMA_VERSION,
  type DelegatedCapabilityClaims,
  type DelegatedVerifier,
} from '../../src/index.ts';

export const sampleClaims = (
  overrides: Partial<DelegatedCapabilityClaims> = {},
): DelegatedCapabilityClaims => ({
  aud: 'supabash-jobs',
  bucket: 'workspaces',
  corr: 'corr-1',
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000) - 1,
  iss: 'https://example.invalid/issuer',
  nonce: 'nonce-1',
  ops: ['read', 'write', 'commit', 'history'],
  origin: 'https://project.supabase.co',
  prefix: 'user-a',
  sub: 'job-1',
  sv: CAPABILITY_SCHEMA_VERSION,
  ...overrides,
});

export const verifierFor = (
  publicKey: CryptoKey,
  overrides: Partial<DelegatedVerifier> = {},
): DelegatedVerifier => ({
  audience: 'supabash-jobs',
  issuer: 'https://example.invalid/issuer',
  origin: 'https://project.supabase.co',
  publicKeys: { k1: publicKey },
  ...overrides,
});

export const ed25519Pair = async (): Promise<CryptoKeyPair> => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) {
    throw new Error('Ed25519 generateKey did not return a key pair.');
  }
  return pair;
};
