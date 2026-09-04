import { describe, expect, test } from 'vitest';

import {
  createDelegatedCapability,
  createPostgresDelegatedCapability,
  importCapabilitySecret,
  verifyPostgresDelegatedCapability,
} from '../../src/index.ts';
import {
  capabilitySecretKey,
  ed25519Pair,
  postgresSampleClaims,
  postgresVerifierFor,
} from '../support/delegated.ts';

describe('postgres delegated capabilities', () => {
  test('binds schema v3 claims to one backend and workspace', async () => {
    const secretKey = await capabilitySecretKey();
    const claims = postgresSampleClaims();
    const capability = await createPostgresDelegatedCapability({ claims, keyId: 'k1', secretKey });

    expect(JSON.parse(atob(capability.split('.')[0] ?? ''))).toStrictEqual({
      alg: 'HS256',
      kid: 'k1',
      typ: 'JWS',
    });
    await expect(
      verifyPostgresDelegatedCapability({ capability, verifier: postgresVerifierFor(secretKey) }),
    ).resolves.toStrictEqual(claims);
  });

  test('rejects a capability signed with another installation secret', async () => {
    const capability = await createPostgresDelegatedCapability({
      claims: postgresSampleClaims(),
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });

    await expect(
      verifyPostgresDelegatedCapability({
        capability,
        verifier: postgresVerifierFor(await capabilitySecretKey()),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
  });

  test('rejects a tampered claim set under the same key id', async () => {
    const secretKey = await capabilitySecretKey();
    const capability = await createPostgresDelegatedCapability({
      claims: postgresSampleClaims({ ops: ['read'] }),
      keyId: 'k1',
      secretKey,
    });
    const [header, , signature] = capability.split('.');
    const forgedPayload = btoa(
      JSON.stringify(postgresSampleClaims({ ops: ['read', 'write', 'commit'] })),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    await expect(
      verifyPostgresDelegatedCapability({
        capability: `${header ?? ''}.${forgedPayload}.${signature ?? ''}`,
        verifier: postgresVerifierFor(secretKey),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
  });

  test('rejects a malformed workspace binding before signing', async () => {
    const secretKey = await capabilitySecretKey();
    expect(() =>
      createPostgresDelegatedCapability({
        claims: postgresSampleClaims({ workspace: '../another-workspace' }),
        keyId: 'k1',
        secretKey,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });

  test('refuses to mint a postgres capability with an Ed25519 key', async () => {
    const keys = await ed25519Pair();
    expect(() =>
      createDelegatedCapability({
        // @ts-expect-error -- a postgres claim set is deliberately not a storage claim set
        claims: postgresSampleClaims(),
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });

  test('refuses to mint a postgres capability with a non-HMAC key', async () => {
    const keys = await ed25519Pair();
    expect(() =>
      createPostgresDelegatedCapability({
        claims: postgresSampleClaims(),
        keyId: 'k1',
        secretKey: keys.privateKey,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });

  test('rejects a capability secret that is too short', async () => {
    await expect(importCapabilitySecret('c2hvcnQ')).rejects.toMatchObject({
      code: 'INVALID_CAPABILITY',
    });
    await expect(importCapabilitySecret('not base64url!')).rejects.toMatchObject({
      code: 'INVALID_CAPABILITY',
    });
  });
});
