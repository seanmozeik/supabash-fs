import { describe, expect, test } from 'vitest';

import type { SupabashError } from '../../src/api/errors.ts';
import {
  CAPABILITY_SCHEMA_VERSION,
  createDelegatedCapability,
  verifyDelegatedCapability,
} from '../../src/index.ts';
import { ed25519Pair, sampleClaims, verifierFor } from '../support/delegated.ts';

describe('delegated capabilities', () => {
  test('signs and verifies an Ed25519 capability for one prefix', async () => {
    const keys = await ed25519Pair();
    const claims = sampleClaims();
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    const verified = await verifyDelegatedCapability({
      capability,
      verifier: {
        audience: claims.aud,
        issuer: claims.iss,
        origin: claims.origin,
        publicKeys: { k1: keys.publicKey },
      },
    });
    expect({ prefix: verified.prefix, sub: verified.sub, sv: verified.sv }).toStrictEqual({
      prefix: 'user-a',
      sub: 'job-1',
      sv: CAPABILITY_SCHEMA_VERSION,
    });
  });

  test('rejects an expired capability and a tampered subject', async () => {
    const keys = await ed25519Pair();
    const expired = await createDelegatedCapability({
      claims: sampleClaims({ exp: Math.floor(Date.now() / 1000) - 120 }),
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    await expect(
      verifyDelegatedCapability({ capability: expired, verifier: verifierFor(keys.publicKey) }),
    ).rejects.toMatchObject(expiredError());
    const valid = await createDelegatedCapability({
      claims: sampleClaims(),
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    const parts = valid.split('.');
    const raw = new TextDecoder().decode(b64urlToBytes(parts[1] ?? ''));
    const tampered = `${parts[0]}.${bytesToB64url(new TextEncoder().encode(raw.replaceAll('"job-1"', '"other-job"')))}.${parts[2]}`;
    await expect(
      verifyDelegatedCapability({ capability: tampered, verifier: verifierFor(keys.publicKey) }),
    ).rejects.toMatchObject(invalidError());
  });

  test('rejects a replayed nonce when a store is configured', async () => {
    const keys = await ed25519Pair();
    const seen = new Set<string>();
    const verifier = verifierFor(keys.publicKey, {
      nonceStore: {
        consume: (nonce: string) => {
          if (seen.has(nonce)) {
            return Promise.resolve(false);
          }
          seen.add(nonce);
          return Promise.resolve(true);
        },
      },
    });
    const capability = await createDelegatedCapability({
      claims: sampleClaims(),
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    await verifyDelegatedCapability({ capability, verifier });
    await expect(verifyDelegatedCapability({ capability, verifier })).rejects.toMatchObject(
      invalidError(),
    );
  });

  test('rejects future issued-at, unknown keys, and the wrong issuer', async () => {
    const keys = await ed25519Pair();
    const future = await createDelegatedCapability({
      claims: sampleClaims({ iat: Math.floor(Date.now() / 1000) + 120 }),
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    await expect(
      verifyDelegatedCapability({ capability: future, verifier: verifierFor(keys.publicKey) }),
    ).rejects.toMatchObject(invalidError());
    const valid = await createDelegatedCapability({
      claims: sampleClaims(),
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    await expect(
      verifyDelegatedCapability({
        capability: valid,
        verifier: verifierFor(keys.publicKey, { publicKeys: { other: keys.publicKey } }),
      }),
    ).rejects.toMatchObject(invalidError());
    await expect(
      verifyDelegatedCapability({
        capability: valid,
        verifier: verifierFor(keys.publicKey, { issuer: 'https://evil.example/issuer' }),
      }),
    ).rejects.toMatchObject(invalidError());
  });

  test('rejects parent and traversal prefixes and does not leak the token', async () => {
    const keys = await ed25519Pair();
    expect(() =>
      createDelegatedCapability({
        claims: sampleClaims({ prefix: 'user-a/../user-b' }),
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
    ).toThrow('safe storage path');
    const capability = await createDelegatedCapability({
      claims: sampleClaims(),
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    const broken = `${capability.slice(0, -1)}${capability.endsWith('A') ? 'B' : 'A'}`;
    let failure: unknown;
    try {
      await verifyDelegatedCapability({
        capability: broken,
        verifier: verifierFor(keys.publicKey),
      });
    } catch (error) {
      failure = error;
    }
    expect({
      code: failure instanceof Error && 'code' in failure && failure.code,
      leaked: failure instanceof Error && failure.message.includes(capability),
    }).toStrictEqual({ code: 'INVALID_CAPABILITY', leaked: false });
  });
});

const expiredError = (): Partial<SupabashError> => ({ code: 'EXPIRED_CAPABILITY' });
const invalidError = (): Partial<SupabashError> => ({ code: 'INVALID_CAPABILITY' });

const b64urlToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
};

const bytesToB64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
