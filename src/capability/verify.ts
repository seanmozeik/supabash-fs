import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS,
  type AnyDelegatedCapabilityClaims,
  type DelegatedCapabilityClaims,
  type PostgresDelegatedCapabilityClaims,
  type VerifyDelegatedCapabilityInput,
} from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { assertClaimSchema, parseClaims } from './claims.js';
import { jwsKeyId, peekCompactJwsHeader, verifyCompactJws } from './jws.js';

export const verifyDelegatedCapability = async (
  input: VerifyDelegatedCapabilityInput,
): Promise<DelegatedCapabilityClaims> => {
  const claims = await verifyDelegatedCapabilityClaims(input);
  if ('backend' in claims) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not storage.');
  }
  await consumeDelegatedCapabilityNonce(claims, input.verifier);
  return claims;
};

export const verifyPostgresDelegatedCapability = async (
  input: VerifyDelegatedCapabilityInput,
): Promise<PostgresDelegatedCapabilityClaims> => {
  const claims = await verifyDelegatedCapabilityClaims(input);
  if (!('backend' in claims)) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not Postgres.');
  }
  await consumeDelegatedCapabilityNonce(claims, input.verifier);
  return claims;
};

export const verifyDelegatedCapabilityClaims = async (
  input: VerifyDelegatedCapabilityInput,
): Promise<AnyDelegatedCapabilityClaims> => {
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
): Promise<AnyDelegatedCapabilityClaims> => {
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
  assertFresh(claims, input);
  return claims;
};

const assertAudience = (
  claims: AnyDelegatedCapabilityClaims,
  verifier: VerifyDelegatedCapabilityInput['verifier'],
): void => {
  if (claims.iss !== verifier.issuer || claims.aud !== verifier.audience) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability issuer or audience does not match.');
  }
  if (claims.origin !== verifier.origin) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability origin does not match.');
  }
};

const assertFresh = (
  claims: AnyDelegatedCapabilityClaims,
  input: VerifyDelegatedCapabilityInput,
): void => {
  const skew = input.verifier.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const maxLifetime = input.verifier.maxLifetimeSeconds ?? DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(skew) || skew < 0) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability clock skew is invalid.');
  }
  if (!Number.isSafeInteger(maxLifetime) || maxLifetime < 1) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability maximum lifetime is invalid.');
  }
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
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxLifetime) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability lifetime is invalid.');
  }
};

export const consumeDelegatedCapabilityNonce = async (
  claims: AnyDelegatedCapabilityClaims,
  verifier: VerifyDelegatedCapabilityInput['verifier'],
): Promise<void> => {
  const store = verifier.nonceStore;
  if (store !== undefined) {
    let firstUse: boolean;
    try {
      firstUse = await store.consume(claims.nonce, new Date(claims.exp * 1000));
    } catch (error) {
      throw new SupabashError('INVALID_CAPABILITY', 'Capability nonce could not be recorded.', {
        cause: error,
      });
    }
    if (!firstUse) {
      throw new SupabashError('INVALID_CAPABILITY', 'Delegated capability nonce was already used.');
    }
  }
};
