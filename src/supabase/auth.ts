import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SupabashError } from '../api/errors.js';
import type { SupabashOptions } from '../api/options.js';

export interface AuthenticatedClient {
  readonly client: SupabaseClient;
  readonly userId: string;
}

export const authenticate = async (options: SupabashOptions): Promise<AuthenticatedClient> => {
  assertPublishableKey(options.publishableKey);
  const accessToken = bearerTokenFrom(options.request);
  if (accessToken.startsWith('sb_secret_') || jwtRole(accessToken) === 'service_role') {
    throw new SupabashError('AUTHORIZATION', 'A service-role token cannot open a workspace.');
  }

  const client = createClient(options.supabaseUrl, options.publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
  const { data, error } = await client.auth.getUser(accessToken);
  if (error !== null) {
    throw new SupabashError('AUTHENTICATION', 'Supabase did not verify the user session.', {
      cause: error,
    });
  }
  const userId = verifiedUserId(data.user);
  return { client, userId };
};

const verifiedUserId = (user: unknown): string => {
  const userId = isRecord(user) ? user['id'] : undefined;
  if (!isNonEmptyString(userId)) {
    throw new SupabashError('AUTHENTICATION', 'Supabase returned no verified user ID.');
  }
  return userId;
};

const bearerTokenFrom = (request: Request): string => {
  const header = request.headers.get('authorization');
  const match = header?.match(/^Bearer (?<token>[^\s]+)$/iu);
  const token = match?.groups?.['token'];
  if (token === undefined) {
    throw new SupabashError('AUTHENTICATION', 'A single bearer token is required.');
  }
  return token;
};

const assertPublishableKey = (key: string): void => {
  if (key.startsWith('sb_publishable_')) {
    return;
  }
  if (key.startsWith('sb_secret_') || jwtRole(key) !== 'anon') {
    throw new SupabashError(
      'AUTHORIZATION',
      'A Supabase publishable key or legacy anon key is required.',
    );
  }
};

const jwtRole = (token: string): string | undefined => {
  const [, payload] = token.split('.');
  if (payload === undefined) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(decodeBase64Url(payload));
    return isRecord(decoded) && typeof decoded['role'] === 'string' ? decoded['role'] : undefined;
  } catch {
    return undefined;
  }
};

const decodeBase64Url = (value: string): string => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return atob(padded);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
