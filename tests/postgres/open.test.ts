import { describe, expect, test, vi } from 'vitest';

import {
  createDelegatedCapability,
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
  Supabash,
  type PostgresDelegatedCapabilityClaims,
} from '../../src/index.ts';
import { ed25519Pair, verifierFor } from '../support/delegated.ts';

const workspace = '123e4567-e89b-42d3-a456-426614174000';

describe('public Postgres workspace API', () => {
  test('creates a workspace for the verified authenticated subject', async () => {
    const api = new FakePostgresApi();
    await expect(
      Supabash.createPostgresWorkspace({
        fetch: api.fetch,
        publishableKey: 'sb_publishable_test',
        request: bearerRequest('user-token'),
        supabaseUrl: 'https://project.supabase.co',
      }),
    ).resolves.toBe(workspace);
    expect(api.calls.map(({ path }) => path)).toStrictEqual([
      '/auth/v1/user',
      '/rest/v1/rpc/supabash_create_workspace',
    ]);
    expect(api.calls[1]?.body).toStrictEqual({});
  });

  test('exchanges a signed binding and consumes the local nonce after open', async () => {
    const keys = await ed25519Pair();
    const nonceStore = {
      consume: vi.fn<(nonce: string, expiresAt: Date) => Promise<boolean>>(() =>
        Promise.resolve(true),
      ),
    };
    const verifier = verifierFor(keys.publicKey, { nonceStore });
    const claims = postgresClaims();
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    const api = new FakePostgresApi(claims);

    const opened = await Supabash.openPostgresDelegated({
      capability,
      expectedOperations: ['read'],
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: claims.origin,
      verifier,
    });

    await expect(opened.fs.writeFile('/denied.md', 'no')).rejects.toMatchObject({
      code: 'AUTHORIZATION',
    });
    expect({
      backend: opened.capabilities.backend,
      calls: api.calls.map(({ path }) => path),
      exchange: api.calls[0]?.body,
      load: api.calls[1]?.body,
      nonceCalls: nonceStore.consume.mock.calls.length,
      delegation: opened.delegation,
      snapshot: opened.committedSnapshot(),
    }).toStrictEqual({
      backend: 'postgres',
      calls: ['/rest/v1/rpc/supabash_exchange_capability', '/rest/v1/rpc/supabash_load_workspace'],
      exchange: { p_capability: capability },
      load: { p_delegated_grant: 'opaque-grant', p_workspace_id: workspace },
      nonceCalls: 1,
      delegation: {
        actor: 'delegated:delegated-subject',
        correlationId: 'corr-postgres',
        operations: ['read'],
        subject: 'delegated-subject',
        workspace,
      },
      snapshot: { committedAt: null, documents: [], revision: null, transactionId: null },
    });
    expect(Object.isFrozen(opened.delegation)).toBe(true);
    expect(Object.isFrozen(opened.delegation.operations)).toBe(true);
  });

  test('rejects unexpected or duplicate operation sets before exchange', async () => {
    const keys = await ed25519Pair();
    const claims = postgresClaims();
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    const api = new FakePostgresApi(claims);
    const common = {
      capability,
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: claims.origin,
      verifier: verifierFor(keys.publicKey),
    };

    await expect(
      Supabash.openPostgresDelegated({ ...common, expectedOperations: ['read', 'history'] }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    await expect(
      Supabash.openPostgresDelegated({ ...common, expectedOperations: ['read', 'read'] }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    expect(api.calls).toStrictEqual([]);
  });

  test('does not consume the local nonce when the bound snapshot cannot open', async () => {
    const keys = await ed25519Pair();
    const nonceStore = {
      consume: vi.fn<(nonce: string, expiresAt: Date) => Promise<boolean>>(() =>
        Promise.resolve(true),
      ),
    };
    const claims = postgresClaims();
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });

    await expect(
      Supabash.openPostgresDelegated({
        capability,
        fetch: new FakePostgresApi(claims, true).fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
        verifier: verifierFor(keys.publicKey, { nonceStore }),
      }),
    ).rejects.toMatchObject({ code: 'STORAGE' });
    expect(nonceStore.consume).not.toHaveBeenCalled();
  });

  test('requires read permission to project a delegated Postgres workspace', async () => {
    const keys = await ed25519Pair();
    const claims = { ...postgresClaims(), ops: ['history'] as const };
    const capability = await createDelegatedCapability({
      claims,
      keyId: 'k1',
      privateKey: keys.privateKey,
    });
    const api = new FakePostgresApi(claims);

    await expect(
      Supabash.openPostgresDelegated({
        capability,
        fetch: api.fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
        verifier: verifierFor(keys.publicKey),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    expect(api.calls).toStrictEqual([]);
  });
});

interface ApiCall {
  readonly body: unknown;
  readonly path: string;
}

class FakePostgresApi {
  readonly calls: ApiCall[] = [];
  private readonly claims: PostgresDelegatedCapabilityClaims | undefined;
  private readonly failLoad: boolean;

  constructor(claims?: PostgresDelegatedCapabilityClaims, failLoad = false) {
    this.claims = claims;
    this.failLoad = failLoad;
  }

  readonly fetch: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body: unknown = request.method === 'GET' ? undefined : await request.json();
      this.calls.push({ body, path });
      if (path === '/auth/v1/user') {
        return json({ id: '223e4567-e89b-42d3-a456-426614174000' });
      }
      if (path.endsWith('/supabash_create_workspace')) {
        return json({ workspaceId: workspace });
      }
      if (path.endsWith('/supabash_exchange_capability') && this.claims !== undefined) {
        return json({
          correlationId: this.claims.corr,
          delegatedGrant: 'opaque-grant',
          expiresAt: new Date(this.claims.exp * 1000).toISOString(),
          operations: this.claims.ops,
          workspace: this.claims.workspace,
        });
      }
      if (path.endsWith('/supabash_load_workspace')) {
        if (this.failLoad) {
          return json({ message: 'Injected snapshot failure.' }, 500);
        }
        return json({ documents: [], headRevision: null });
      }
      return json({ message: 'Unexpected test request.' }, 501);
    },
    { preconnect: (): void => undefined },
  );
}

const postgresClaims = (): PostgresDelegatedCapabilityClaims => ({
  aud: 'supabash-jobs',
  backend: 'postgres',
  corr: 'corr-postgres',
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000) - 1,
  iss: 'https://example.invalid/issuer',
  nonce: 'postgres-open-nonce',
  ops: ['read'],
  origin: 'https://project.supabase.co',
  sub: 'delegated-subject',
  sv: POSTGRES_CAPABILITY_SCHEMA_VERSION,
  workspace,
});

const bearerRequest = (token: string): Request =>
  new Request('https://host.example', { headers: { Authorization: `Bearer ${token}` } });

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { headers: { 'content-type': 'application/json' }, status });
