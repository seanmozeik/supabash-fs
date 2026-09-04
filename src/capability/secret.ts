import { SupabashError } from '../api/errors.js';

const CAPABILITY_SECRET_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * Imports the shared Postgres capability secret. The secret is the base64url
 * value that `public.supabash_register_capability_verifier` returned once and
 * that the database reads back from `supabase_vault`. Only the minting host
 * holds it. A delegate that presents a capability never needs it.
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

const decodeSecret = (secret: string): Uint8Array<ArrayBuffer> => {
  if (!BASE64URL.test(secret)) {
    throw invalid('A capability secret must be base64url without padding.');
  }
  const padded = secret.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  } catch (error) {
    throw new SupabashError(
      'INVALID_CAPABILITY',
      'A capability secret must be base64url without padding.',
      { cause: error },
    );
  }
  if (binary.length < CAPABILITY_SECRET_BYTES) {
    throw invalid(`A capability secret must decode to at least ${CAPABILITY_SECRET_BYTES} bytes.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
};

const invalid = (message: string): SupabashError =>
  new SupabashError('INVALID_CAPABILITY', message);
