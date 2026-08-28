import { describe, expect, test } from 'vitest';

import {
  createDelegatedCapability,
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
  type PostgresDelegatedCapabilityClaims,
  verifyDelegatedCapability,
  verifyPostgresDelegatedCapability,
} from '../../src/index.ts';
import { ed25519Pair, verifierFor } from '../support/delegated.ts';

describe('postgres delegated capabilities', () => {
  test('binds schema v2 claims to one backend and workspace', async () => {
    const keys = await ed25519Pair();
    const claims = postgresClaims();
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });

    await expect(
      verifyPostgresDelegatedCapability({ capability, verifier: verifierFor(keys.publicKey) }),
    ).resolves.toStrictEqual(claims);
    await expect(
      verifyDelegatedCapability({ capability, verifier: verifierFor(keys.publicKey) }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
  });

  test('rejects a malformed workspace binding before signing', async () => {
    const keys = await ed25519Pair();
    expect(() =>
      createDelegatedCapability({
        claims: { ...postgresClaims(), workspace: '../another-workspace' },
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });
});

const postgresClaims = (): PostgresDelegatedCapabilityClaims => ({
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
});
