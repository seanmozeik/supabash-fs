import {
  CAPABILITY_SCHEMA_VERSION,
  generateCapabilitySecret,
  importCapabilitySecret,
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
  type DelegatedCapabilityClaims,
  type DelegatedVerifier,
  type PostgresDelegatedCapabilityClaims,
  type PostgresDelegatedVerifier,
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

export const postgresSampleClaims = (
  overrides: Partial<PostgresDelegatedCapabilityClaims> = {},
): PostgresDelegatedCapabilityClaims => ({
  aud: 'supabash-jobs',
  backend: 'postgres',
  corr: 'corr-1',
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000) - 1,
  iss: 'https://example.invalid/issuer',
  nonce: 'postgres-nonce-1',
  ops: ['read', 'write', 'commit', 'history'],
  origin: 'https://project.supabase.co',
  sub: 'job-1',
  sv: POSTGRES_CAPABILITY_SCHEMA_VERSION,
  workspace: '123e4567-e89b-42d3-a456-426614174000',
  ...overrides,
});

export const postgresVerifierFor = (
  secretKey: CryptoKey,
  overrides: Partial<PostgresDelegatedVerifier> = {},
): PostgresDelegatedVerifier => ({
  audience: 'supabash-jobs',
  issuer: 'https://example.invalid/issuer',
  origin: 'https://project.supabase.co',
  secretKeys: { k1: secretKey },
  ...overrides,
});

export const capabilitySecretKey = (): Promise<CryptoKey> =>
  importCapabilitySecret(generateCapabilitySecret());
