import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  type DelegatedCapabilityClaims,
  type VerifyDelegatedCapabilityInput,
} from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { assertClaimSchema, parseClaims } from './claims.js';
import { jwsKeyId, peekCompactJwsHeader, verifyCompactJws } from './jws.js';

export const verifyDelegatedCapability = async (
  input: VerifyDelegatedCapabilityInput,
): Promise<DelegatedCapabilityClaims> => {
  try {
    return await verifyInner(input);
  } catch (error) {
    if (error instanceof SupabashError) {
      throw error;
    }
    throw new SupabashError('INVALID_CAPABILITY', 'Delegated capability could not be verified.', {
      cause: error,
    });
  }
};

const verifyInner = async (
  input: VerifyDelegatedCapabilityInput,
): Promise<DelegatedCapabilityClaims> => {
  const unverifiedHeader = peekCompactJwsHeader(input.capability);
  const keyId = jwsKeyId(unverifiedHeader);
  const publicKey = input.verifier.publicKeys[keyId];
  if (publicKey?.type !== 'public') {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability key id is unknown.');
  }
  const { header, payload } = await verifyCompactJws(input.capability, publicKey);
  if (jwsKeyId(header) !== keyId) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability key id is unknown.');
  }
  const claims = parseClaims(payload);
  assertClaimSchema(claims);
  assertAudience(claims, input.verifier);
  await assertFresh(claims, input);
  return claims;
};

const assertAudience = (
  claims: DelegatedCapabilityClaims,
  verifier: VerifyDelegatedCapabilityInput['verifier'],
): void => {
  if (claims.iss !== verifier.issuer || claims.aud !== verifier.audience) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability issuer or audience does not match.');
  }
  if (claims.origin !== verifier.origin) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability origin does not match.');
  }
};

const assertFresh = async (
  claims: DelegatedCapabilityClaims,
  input: VerifyDelegatedCapabilityInput,
): Promise<void> => {
  const skew = input.verifier.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp + skew < now) {
    throw new SupabashError('EXPIRED_CAPABILITY', 'Delegated capability has expired.');
  }
  if (claims.iat > now + skew) {
    throw new SupabashError(
      'INVALID_CAPABILITY',
      'Capability issued-at time is too far in the future.',
    );
  }
  const store = input.verifier.nonceStore;
  if (store !== undefined) {
    const firstUse = await store.consume(claims.nonce, new Date(claims.exp * 1000));
    if (!firstUse) {
      throw new SupabashError('INVALID_CAPABILITY', 'Delegated capability nonce was already used.');
    }
  }
};
