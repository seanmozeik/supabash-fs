import type {
  AnyDelegatedCapabilityClaims,
  CreateDelegatedCapabilityInput,
  CreatePostgresDelegatedCapabilityInput,
} from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { assertClaimSchema, parseClaims } from './claims.js';
import { compactJws } from './jws.js';

export const createDelegatedCapability = (
  input: CreateDelegatedCapabilityInput,
): Promise<string> => {
  if (input.privateKey.type !== 'private' || input.privateKey.algorithm.name !== 'Ed25519') {
    throw new SupabashError('INVALID_CAPABILITY', 'Signing requires an Ed25519 private key.');
  }
  const claims = signableClaims(input.claims, input.keyId);
  if ('backend' in claims) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not storage.');
  }
  return compactJws(
    'EdDSA',
    { alg: 'EdDSA', kid: input.keyId, typ: 'JWS' },
    claims,
    input.privateKey,
  );
};

export const createPostgresDelegatedCapability = (
  input: CreatePostgresDelegatedCapabilityInput,
): Promise<string> => {
  assertCapabilitySecretKey(input.secretKey);
  const claims = signableClaims(input.claims, input.keyId);
  if (!('backend' in claims)) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not Postgres.');
  }
  return compactJws(
    'HS256',
    { alg: 'HS256', kid: input.keyId, typ: 'JWS' },
    claims,
    input.secretKey,
  );
};

export const assertCapabilitySecretKey = (key: CryptoKey): void => {
  if (key.type !== 'secret' || key.algorithm.name !== 'HMAC') {
    throw new SupabashError(
      'INVALID_CAPABILITY',
      'Postgres capabilities require an HMAC-SHA256 secret key.',
    );
  }
};

const signableClaims = (value: unknown, keyId: string): AnyDelegatedCapabilityClaims => {
  if (keyId.length === 0) {
    throw new SupabashError('INVALID_CAPABILITY', 'A key id is required to sign a capability.');
  }
  const claims = parseClaims(value);
  assertClaimSchema(claims);
  return claims;
};
