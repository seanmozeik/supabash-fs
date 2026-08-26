import { describe, expect, test } from 'vitest';

import type { SupabashError } from '../../src/api/errors.ts';
import type { SupabashOptions } from '../../src/api/options.ts';
import { Supabash } from '../../src/index.ts';
import { FakeSupabase } from '../support/fake-supabase.ts';

describe('public workspace API', () => {
  test('rejects a request without a bearer token before network access', async () => {
    const api = new FakeSupabase({ token: 'user-a' });
    await expect(
      Supabash.open({
        ...optionsFor(api, 'token'),
        request: new Request('https://application.example'),
      }),
    ).rejects.toMatchObject(authenticationError());
    expect(api.calls).toStrictEqual([]);
  });

  test('rejects a secret project key before network access', async () => {
    const api = new FakeSupabase({ token: 'user-a' });
    await expect(
      Supabash.open({ ...optionsFor(api, 'token'), publishableKey: 'sb_secret_test' }),
    ).rejects.toMatchObject(authorizationError());
    expect(api.calls).toStrictEqual([]);
  });

  test('rejects a service-role user token before network access', async () => {
    const api = new FakeSupabase({});
    await expect(Supabash.open(optionsFor(api, jwtForRole('service_role')))).rejects.toMatchObject(
      authorizationError(),
    );
    expect(api.calls).toStrictEqual([]);
  });

  test('rejects an opaque secret user token before network access', async () => {
    const api = new FakeSupabase({});
    await expect(Supabash.open(optionsFor(api, 'sb_secret_test'))).rejects.toMatchObject(
      authorizationError(),
    );
    expect(api.calls).toStrictEqual([]);
  });

  test('rejects an unsafe verified user identifier', async () => {
    const api = new FakeSupabase({ token: '../user-b' });
    await expect(Supabash.open(optionsFor(api, 'token'))).rejects.toMatchObject(
      authorizationError(),
    );
    expect(api.calls).toHaveLength(1);
  });

  test('rejects an unsafe bucket identifier', async () => {
    const api = new FakeSupabase({ token: 'user-a' });
    await expect(
      Supabash.open({ ...optionsFor(api, 'token'), bucket: ' unsafe' }),
    ).rejects.toMatchObject(authorizationError());
    expect(api.calls).toHaveLength(1);
  });

  test('derives each storage root only from the verified user', async () => {
    const api = new FakeSupabase({ 'token-a': 'user-a', 'token-b': 'user-b' });
    const attemptedOverride = {
      ...optionsFor(api, 'token-a'),
      prefix: 'user-b/',
      userId: 'user-b',
    };
    const first = await Supabash.open(attemptedOverride);
    await first.fs.mkdir('/folder');
    await first.fs.writeFile('/folder/file.md', 'first user\n');
    await first.fs.symlink('/folder/file.md', '/latest');
    await first.commit();

    const second = await Supabash.open(optionsFor(api, 'token-b'));
    const secondSawFirstRoot = await second.fs.exists('/folder');
    await second.fs.writeFile('/file.md', 'second user\n');
    await second.commit();

    const storageCalls = api.calls.filter(({ path }) => path.startsWith('/storage/'));
    expect({
      firstText: api.text('user-a/folder/file.md'),
      keys: api.keys(),
      listPrefixes: api.listPrefixes,
      secondSawFirstRoot,
      secondText: api.text('user-b/file.md'),
      storageAuthorizations: new Set(storageCalls.map(({ authorization }) => authorization)),
    }).toStrictEqual({
      firstText: 'first user\n',
      keys: ['user-a/folder', 'user-a/folder/file.md', 'user-a/latest', 'user-b/file.md'],
      listPrefixes: ['user-a/', 'user-b/'],
      secondSawFirstRoot: false,
      secondText: 'second user\n',
      storageAuthorizations: new Set(['Bearer token-a', 'Bearer token-b']),
    });

    const reopened = await Supabash.open(optionsFor(api, 'token-a'));
    await expect(reopened.fs.readFile('/folder/file.md')).resolves.toBe('first user\n');
    await expect(reopened.fs.readlink('/latest')).resolves.toBe('/folder/file.md');
  });

  test('replaces entry kinds at one stable object key', async () => {
    const api = new FakeSupabase({ token: 'user-a' });
    const first = await Supabash.open(optionsFor(api, 'token'));
    await first.fs.writeFile('/entry', 'file\n');
    await first.commit();

    await first.fs.rm('/entry');
    await first.fs.mkdir('/entry');
    await first.commit();
    expect(api.keys()).toStrictEqual(['user-a/entry']);

    const second = await Supabash.open(optionsFor(api, 'token'));
    await expect(second.fs.lstat('/entry')).resolves.toMatchObject({ isDirectory: true });
    await second.fs.rm('/entry');
    await second.fs.writeFile('/entry', 'again\n');
    await second.commit();

    const third = await Supabash.open(optionsFor(api, 'token'));
    await expect(third.fs.readFile('/entry')).resolves.toBe('again\n');
    expect(api.keys()).toStrictEqual(['user-a/entry']);
  });
});

const optionsFor = (api: FakeSupabase, accessToken: string): SupabashOptions => ({
  bucket: 'workspaces',
  fetch: api.fetch,
  publishableKey: 'sb_publishable_test',
  request: new Request('https://application.example', {
    headers: { Authorization: `Bearer ${accessToken}` },
  }),
  supabaseUrl: 'https://project.supabase.co',
});

const jwtForRole = (role: string): string => `e30.${btoa(JSON.stringify({ role }))}.signature`;

const authenticationError = (): Partial<SupabashError> => ({ code: 'AUTHENTICATION' });

const authorizationError = (): Partial<SupabashError> => ({ code: 'AUTHORIZATION' });
