import { describe, expect, test } from 'vitest';

import {
  createPostgresDelegatedCapability,
  Supabash,
  type PostgresDelegatedCapabilityClaims,
} from '../../src/index.ts';
import { capabilitySecretKey, postgresSampleClaims } from '../support/delegated.ts';

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

  test('takes its delegation from the grant the database minted', async () => {
    const claims = postgresClaims();
    const capability = await createPostgresDelegatedCapability({
      claims,
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });
    const api = new FakePostgresApi(claims);

    const opened = await Supabash.openPostgresDelegated({
      capability,
      expectedOperations: ['read'],
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: claims.origin,
    });

    await expect(opened.fs.writeFile('/denied.md', 'no')).rejects.toMatchObject({
      code: 'AUTHORIZATION',
    });
    expect({
      backend: opened.capabilities.backend,
      calls: api.calls.map(({ path }) => path),
      exchange: api.calls[0]?.body,
      load: api.calls[1]?.body,
      delegation: opened.delegation,
      snapshot: opened.committedSnapshot(),
    }).toStrictEqual({
      backend: 'postgres',
      calls: ['/rest/v1/rpc/supabash_exchange_capability', '/rest/v1/rpc/supabash_load_workspace'],
      exchange: { p_capability: capability },
      load: { p_delegated_grant: 'opaque-grant', p_workspace_id: workspace },
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
    const claims = postgresClaims();
    const capability = await createPostgresDelegatedCapability({
      claims,
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });
    const api = new FakePostgresApi(claims);
    const common = {
      capability,
      fetch: api.fetch,
      serviceRoleKey: 'sb_secret_test',
      supabaseUrl: claims.origin,
    };

    await expect(
      Supabash.openPostgresDelegated({ ...common, expectedOperations: ['read', 'history'] }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    await expect(
      Supabash.openPostgresDelegated({ ...common, expectedOperations: ['read', 'read'] }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    expect(api.calls).toStrictEqual([]);
  });

  test('rejects a grant that does not match the capability it presented', async () => {
    const claims = postgresClaims();
    const capability = await createPostgresDelegatedCapability({
      claims,
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });
    const api = new FakePostgresApi({ ...claims, ops: ['read', 'write', 'commit'] });

    await expect(
      Supabash.openPostgresDelegated({
        capability,
        fetch: api.fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    expect(api.calls.map(({ path }) => path)).toStrictEqual([
      '/rest/v1/rpc/supabash_exchange_capability',
    ]);
  });

  test('rejects a capability minted for another project origin', async () => {
    const claims = postgresClaims();
    const capability = await createPostgresDelegatedCapability({
      claims,
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });
    const api = new FakePostgresApi(claims);

    await expect(
      Supabash.openPostgresDelegated({
        capability,
        fetch: api.fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: 'https://other.supabase.co',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    expect(api.calls).toStrictEqual([]);
  });

  test('requires read permission to project a delegated Postgres workspace', async () => {
    const claims = postgresClaims({ ops: ['history'] });
    const capability = await createPostgresDelegatedCapability({
      claims,
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });
    const api = new FakePostgresApi(claims);

    await expect(
      Supabash.openPostgresDelegated({
        capability,
        fetch: api.fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    expect(api.calls).toStrictEqual([]);
  });

  test('surfaces a snapshot failure after the grant is minted', async () => {
    const claims = postgresClaims();
    const capability = await createPostgresDelegatedCapability({
      claims,
      keyId: 'k1',
      secretKey: await capabilitySecretKey(),
    });

    await expect(
      Supabash.openPostgresDelegated({
        capability,
        fetch: new FakePostgresApi(claims, true).fetch,
        serviceRoleKey: 'sb_secret_test',
        supabaseUrl: claims.origin,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE' });
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
          actorSubject: this.claims.sub,
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

const postgresClaims = (
  overrides: Partial<PostgresDelegatedCapabilityClaims> = {},
): PostgresDelegatedCapabilityClaims =>
  postgresSampleClaims({
    corr: 'corr-postgres',
    nonce: 'postgres-open-nonce',
    ops: ['read'],
    sub: 'delegated-subject',
    workspace,
    ...overrides,
  });

const bearerRequest = (token: string): Request =>
  new Request('https://host.example', { headers: { Authorization: `Bearer ${token}` } });

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { headers: { 'content-type': 'application/json' }, status });
