import { describe, expect, test } from 'vitest';

import type { SupabashError } from '../../src/api/errors.ts';
import { asUnknownRecord } from '../../src/api/json.ts';
import { guardWorkspace } from '../../src/capability/guard.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { createDelegatedCapability, Supabash } from '../../src/index.ts';
import { ed25519Pair, sampleClaims, verifierFor } from '../support/delegated.ts';
import { FakeSupabase } from '../support/fake-supabase.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

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

  test('does not consume the nonce before scope checks and storage open succeed', async () => {
    const api = new FakeSupabase({});
    const keys = await ed25519Pair();
    const claims = sampleClaims({ nonce: 'retry-open' });
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    const consumed = new Set<string>();
    const verifier = verifierFor(keys.publicKey, {
      nonceStore: {
        consume: (nonce: string) => {
          if (consumed.has(nonce)) {
            return Promise.resolve(false);
          }
          consumed.add(nonce);
          return Promise.resolve(true);
        },
      },
    });
    const bucketFailure = await captureFailure(
      Supabash.openDelegated({
        bucket: 'other-bucket',
        capability,
        fetch: api.fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
        verifier,
      }),
    );
    const consumedAfterBucketFailure = consumed.size;
    const storageFailure = await captureFailure(
      Supabash.openDelegated({
        bucket: claims.bucket,
        capability,
        fetch: Object.assign(() => Promise.reject(new Error('temporary storage failure')), {
          preconnect: String,
        }),
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
        verifier,
      }),
    );
    const consumedAfterStorageFailure = consumed.size;
    const workspace = await Supabash.openDelegated({
      bucket: claims.bucket,
      capability,
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: claims.origin,
      verifier,
    });
    expect({
      bucketFailure,
      consumed: [...consumed],
      consumedAfterBucketFailure,
      consumedAfterStorageFailure,
      opened: typeof workspace.commit,
      storageFailure,
    }).toStrictEqual({
      bucketFailure: { code: 'INVALID_CAPABILITY', rejected: true },
      consumed: ['retry-open'],
      consumedAfterBucketFailure: 0,
      consumedAfterStorageFailure: 0,
      opened: 'function',
      storageFailure: { code: 'PARTIAL_COMMIT', rejected: true },
    });
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
    await expect(workspace.discard()).resolves.toBeUndefined();
  });

  test('requires write permission to discard staged changes', async () => {
    const inner = await createStorageWorkspace(new MemoryStorage());
    await inner.fs.writeFile('/staged.md', 'staged\n');
    const guarded = guardWorkspace(inner, new Set(['read']), 'delegated:reader', 'corr-reader');

    await expect(guarded.discard()).rejects.toMatchObject(authorizationError());
    expect(inner.changes()).toHaveLength(1);
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

interface CapturedFailure {
  readonly code: string | undefined;
  readonly rejected: boolean;
}

const captureFailure = async (operation: Promise<unknown>): Promise<CapturedFailure> => {
  try {
    await operation;
    return { code: undefined, rejected: false };
  } catch (error) {
    const record = asUnknownRecord(error);
    return {
      code: typeof record?.['code'] === 'string' ? record['code'] : undefined,
      rejected: true,
    };
  }
};
