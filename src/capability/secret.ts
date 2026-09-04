import { SupabashError } from '../api/errors.js';

const CAPABILITY_SECRET_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * Imports the shared Postgres capability secret. The secret is the same
 * base64url value stored in `supabase_vault` and read by
 * `public.supabash_exchange_capability`.
 */
export const importCapabilitySecret = async (secret: string): Promise<CryptoKey> => {
  const bytes = decodeSecret(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign', 'verify'],
  );
  return key;
};

/** Generates one new capability secret for a database owner to store in the vault. */
export const generateCapabilitySecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(CAPABILITY_SECRET_BYTES));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const decodeSecret = (secret: string): Uint8Array<ArrayBuffer> => {
  if (!BASE64URL.test(secret)) {
    throw new SupabashError(
      'INVALID_CAPABILITY',
      'A capability secret must be base64url without padding.',
    );
  }
  const padded = secret.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  if (binary.length < CAPABILITY_SECRET_BYTES) {
    throw new SupabashError(
      'INVALID_CAPABILITY',
      `A capability secret must decode to at least ${CAPABILITY_SECRET_BYTES} bytes.`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
};
