import { describe, expect, test } from 'vitest';

import {
  createDelegatedCapability,
  createPostgresDelegatedCapability,
  importCapabilitySecret,
} from '../../src/index.ts';
import {
  base64url,
  capabilitySecretBytes,
  capabilitySecretKey,
  ed25519Pair,
  postgresSampleClaims,
} from '../support/delegated.ts';

const text = new TextEncoder();

/*
 * The database is the only verifier of a Postgres capability, so these tests
 * check the minted artifact against WebCrypto directly instead of against the
 * package's own verifier.
 */
describe('postgres delegated capabilities', () => {
  test('mints a schema v3 HS256 JWS whose MAC an independent verifier accepts', async () => {
    const secretKey = await capabilitySecretKey();
    const claims = postgresSampleClaims();
    const capability = await createPostgresDelegatedCapability({ claims, keyId: 'k1', secretKey });
    const [header, payload, signature] = capability.split('.');

    expect(decodeJson(header)).toStrictEqual({ alg: 'HS256', kid: 'k1', typ: 'JWS' });
    expect(decodeJson(payload)).toStrictEqual({ ...claims, sv: 3 });
    await expect(
      crypto.subtle.verify(
        { name: 'HMAC' },
        secretKey,
        decodeBytes(signature),
        text.encode(`${header ?? ''}.${payload ?? ''}`),
      ),
    ).resolves.toBe(true);
  });

  test('accepts a secret imported from its base64url vault form', async () => {
    const bytes = capabilitySecretBytes();
    const capability = await createPostgresDelegatedCapability({
      claims: postgresSampleClaims(),
      keyId: 'k1',
      secretKey: await importCapabilitySecret(base64url(bytes)),
    });
    const [header, payload, signature] = capability.split('.');

    await expect(
      crypto.subtle.verify(
        { name: 'HMAC' },
        await capabilitySecretKey(bytes),
        decodeBytes(signature),
        text.encode(`${header ?? ''}.${payload ?? ''}`),
      ),
    ).resolves.toBe(true);
  });

  test('does not accept a MAC computed under another installation secret', async () => {
    const capability = await createPostgresDelegatedCapability({
      claims: postgresSampleClaims(),
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });
    const [header, payload, signature] = capability.split('.');

    await expect(
      crypto.subtle.verify(
        { name: 'HMAC' },
        await capabilitySecretKey(),
        decodeBytes(signature),
        text.encode(`${header ?? ''}.${payload ?? ''}`),
      ),
    ).resolves.toBe(false);
  });

  test('binds the operation set into the MAC', async () => {
    const secretKey = await capabilitySecretKey();
    const capability = await createPostgresDelegatedCapability({
      claims: postgresSampleClaims({ ops: ['read'] }),
      keyId: 'k1',
      secretKey,
    });
    const [header, , signature] = capability.split('.');
    const widened = base64url(
      text.encode(JSON.stringify(postgresSampleClaims({ ops: ['read', 'write', 'commit'] }))),
    );

    await expect(
      crypto.subtle.verify(
        { name: 'HMAC' },
        secretKey,
        decodeBytes(signature),
        text.encode(`${header ?? ''}.${widened}`),
      ),
    ).resolves.toBe(false);
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
    expect(() =>
      createPostgresDelegatedCapability({
        claims: postgresSampleClaims(),
        keyId: 'k1',
        secretKey: keys.privateKey,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });

  test('rejects a capability secret that is short or not base64url', async () => {
    await expect(importCapabilitySecret(base64url(new Uint8Array(31)))).rejects.toMatchObject({
      code: 'INVALID_CAPABILITY',
    });
    await expect(importCapabilitySecret('not base64url!')).rejects.toMatchObject({
      code: 'INVALID_CAPABILITY',
    });
    await expect(importCapabilitySecret('A'.repeat(45))).rejects.toMatchObject({
      code: 'INVALID_CAPABILITY',
    });
  });
});

const decodeBytes = (value = ''): Uint8Array<ArrayBuffer> => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
};

const decodeJson = (value = ''): unknown =>
  JSON.parse(new TextDecoder().decode(decodeBytes(value)));
