import { describe, expect, test } from 'vitest';

import { authenticate } from '../../src/supabase/auth.ts';

const invalidSession = (): Promise<Response> =>
  Promise.resolve(Response.json({ msg: 'invalid token' }, { status: 401 }));

describe('session verification failures', () => {
  test.each([500, 502, 503, 504])(
    'allows a retry after infrastructure status %s',
    async (status) => {
      const unavailable = (): Promise<Response> =>
        Promise.resolve(new Response('unavailable', { status }));
      await expect(
        authenticate({
          supabaseUrl: 'https://example.supabase.co',
          publishableKey: 'sb_publishable_test',
          request: new Request('https://example.test', {
            headers: { authorization: 'Bearer test' },
          }),
          fetch: Object.assign(unavailable, { preconnect: fetch.preconnect }),
        }),
      ).rejects.toMatchObject({ code: 'STORAGE', retryable: true, outcomeUnknown: false });
    },
  );

  test('keeps an invalid session non-retryable', async () => {
    await expect(
      authenticate({
        supabaseUrl: 'https://example.supabase.co',
        publishableKey: 'sb_publishable_test',
        request: new Request('https://example.test', { headers: { authorization: 'Bearer test' } }),
        fetch: Object.assign(invalidSession, { preconnect: fetch.preconnect }),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION', retryable: false, outcomeUnknown: false });
  });
});
