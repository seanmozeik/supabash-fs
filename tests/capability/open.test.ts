import { describe, expect, test } from 'vitest';

import type { SupabashError } from '../../src/api/errors.ts';
import { createDelegatedCapability, Supabash } from '../../src/index.ts';
import { ed25519Pair, sampleClaims, verifierFor } from '../support/delegated.ts';
import { FakeSupabase } from '../support/fake-supabase.ts';

describe('delegated workspace access', () => {
  test('opens only the exact verified prefix', async () => {
    const api = new FakeSupabase({ token: 'user-a' });
    const keys = await ed25519Pair();
    const claims = sampleClaims();
    const workspace = await Supabash.openDelegated({
      bucket: 'workspaces',
      capability: await createDelegatedCapability({
        claims,
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: claims.origin,
      verifier: verifierFor(keys.publicKey),
    });
    await workspace.fs.writeFile('/notes.md', 'delegated\n');
    const receipt = await workspace.commit();
    expect({
      actor: receipt.actor,
      listed: await workspace.fs.readdir('/'),
      stored: api.text('user-a/notes.md'),
    }).toStrictEqual({ actor: 'delegated:job-1', listed: ['notes.md'], stored: 'delegated\n' });
  });

  test('rejects a capability copied to another bucket or origin', async () => {
    const api = new FakeSupabase({});
    const keys = await ed25519Pair();
    const claims = sampleClaims();
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    await expect(
      Supabash.openDelegated({
        bucket: 'other-bucket',
        capability,
        fetch: api.fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
        verifier: verifierFor(keys.publicKey),
      }),
    ).rejects.toMatchObject(invalidError());
    await expect(
      Supabash.openDelegated({
        bucket: claims.bucket,
        capability,
        fetch: api.fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: 'https://other.supabase.co',
        verifier: verifierFor(keys.publicKey),
      }),
    ).rejects.toMatchObject(invalidError());
  });

  test('blocks writes when the capability omits the write operation', async () => {
    const api = new FakeSupabase({});
    const keys = await ed25519Pair();
    const claims = sampleClaims({ ops: ['read', 'history'] });
    const workspace = await Supabash.openDelegated({
      bucket: 'workspaces',
      capability: await createDelegatedCapability({
        claims,
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: claims.origin,
      verifier: verifierFor(keys.publicKey),
    });
    await expect(workspace.fs.writeFile('/notes.md', 'nope\n')).rejects.toMatchObject(
      authorizationError(),
    );
    await expect(workspace.commit()).rejects.toMatchObject(authorizationError());
  });

  test('keeps a nested prefix from reading parent objects', async () => {
    const api = new FakeSupabase({});
    const keys = await ed25519Pair();
    const parent = await Supabash.openDelegated({
      bucket: 'workspaces',
      capability: await createDelegatedCapability({
        claims: sampleClaims({ nonce: 'parent', prefix: 'user-a', sub: 'parent-job' }),
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: sampleClaims().origin,
      verifier: verifierFor(keys.publicKey),
    });
    await parent.fs.writeFile('/secret.md', 'parent-secret\n');
    await parent.commit();
    const child = await Supabash.openDelegated({
      bucket: 'workspaces',
      capability: await createDelegatedCapability({
        claims: sampleClaims({ nonce: 'child', prefix: 'user-a/jobs', sub: 'child-job' }),
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: sampleClaims().origin,
      verifier: verifierFor(keys.publicKey),
    });
    await child.fs.writeFile('/note.md', 'nested\n');
    await child.commit();
    expect({
      child: await child.fs.readdir('/'),
      parentSecret: api.text('user-a/secret.md'),
      storedChild: api.text('user-a/jobs/note.md'),
    }).toStrictEqual({
      child: ['note.md'],
      parentSecret: 'parent-secret\n',
      storedChild: 'nested\n',
    });
  });

  test('binds commit attribution to the capability and hides fs without read or write', async () => {
    const api = new FakeSupabase({});
    const keys = await ed25519Pair();
    const writer = await Supabash.openDelegated({
      bucket: 'workspaces',
      capability: await createDelegatedCapability({
        claims: sampleClaims(),
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: sampleClaims().origin,
      verifier: verifierFor(keys.publicKey),
    });
    await writer.fs.writeFile('/notes.md', 'ok\n');
    const receipt = await writer.commit({
      context: { actor: 'spoofed', correlationId: 'spoofed', cause: 'job' },
    });
    expect(receipt.actor).toBe('delegated:job-1');
    expect(receipt.correlationId).toBe('corr-1');
    const historyOnly = await Supabash.openDelegated({
      bucket: 'workspaces',
      capability: await createDelegatedCapability({
        claims: sampleClaims({ nonce: 'history', ops: ['history'], sub: 'history-job' }),
        keyId: 'k1',
        privateKey: keys.privateKey,
      }),
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: sampleClaims().origin,
      verifier: verifierFor(keys.publicKey),
    });
    await expect(historyOnly.fs.readFile('/notes.md')).rejects.toMatchObject(authorizationError());
    expect(() => historyOnly.changes()).toThrow(expect.objectContaining(authorizationError()));
  });
});

const invalidError = (): Partial<SupabashError> => ({ code: 'INVALID_CAPABILITY' });
const authorizationError = (): Partial<SupabashError> => ({ code: 'AUTHORIZATION' });
