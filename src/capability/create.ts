import type { CreateDelegatedCapabilityInput } from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { assertClaimSchema, parseClaims } from './claims.js';
import { compactJws } from './jws.js';

export const createDelegatedCapability = (
  input: CreateDelegatedCapabilityInput,
): Promise<string> => {
  if (input.privateKey.type !== 'private' || input.privateKey.algorithm.name !== 'Ed25519') {
    throw new SupabashError('INVALID_CAPABILITY', 'Signing requires an Ed25519 private key.');
  }
  if (input.keyId.length === 0) {
    throw new SupabashError('INVALID_CAPABILITY', 'A key id is required to sign a capability.');
  }
  const claims = parseClaims(input.claims);
  assertClaimSchema(claims);
  return compactJws({ alg: 'EdDSA', kid: input.keyId, typ: 'JWS' }, claims, input.privateKey);
};
