import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS,
  type AnyDelegatedCapabilityClaims,
  type CapabilityNonceStore,
  type DelegatedCapabilityClaims,
  type PostgresDelegatedCapabilityClaims,
  type VerifyDelegatedCapabilityInput,
  type VerifyPostgresDelegatedCapabilityInput,
} from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { assertClaimSchema, parseClaims } from './claims.js';
import { assertCapabilitySecretKey } from './create.js';
import { jwsKeyId, peekCompactJwsHeader, verifyCompactJws } from './jws.js';

interface NonceHolder {
  readonly nonceStore?: CapabilityNonceStore;
}

interface FreshnessBounds {
  readonly clockSkewSeconds?: number;
  readonly maxLifetimeSeconds?: number;
}

interface Audience {
  readonly audience: string;
  readonly issuer: string;
  readonly origin: string;
}

export const verifyDelegatedCapability = async (
  input: VerifyDelegatedCapabilityInput,
): Promise<DelegatedCapabilityClaims> => {
  const claims = await verifyStorageCapabilityClaims(input);
  await consumeDelegatedCapabilityNonce(claims, input.verifier);
  return claims;
};

export const verifyPostgresDelegatedCapability = async (
  input: VerifyPostgresDelegatedCapabilityInput,
): Promise<PostgresDelegatedCapabilityClaims> => {
  const claims = await verifyPostgresCapabilityClaims(input);
  await consumeDelegatedCapabilityNonce(claims, input.verifier);
  return claims;
};

export const verifyStorageCapabilityClaims = (
  input: VerifyDelegatedCapabilityInput,
): Promise<DelegatedCapabilityClaims> =>
  guard(async () => {
    const claims = await verifyInner(
      'EdDSA',
      input.capability,
      (keyId) => publicKeyFor(input.verifier.publicKeys[keyId]),
      input.verifier,
    );
    if ('backend' in claims) {
      throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not storage.');
    }
    return claims;
  });

/**
 * Verifies a Postgres capability locally. Only the minting host holds the
 * shared secret. A delegate that presents a capability must let
 * `public.supabash_exchange_capability` verify it inside the database.
 */
export const verifyPostgresCapabilityClaims = (
  input: VerifyPostgresDelegatedCapabilityInput,
): Promise<PostgresDelegatedCapabilityClaims> =>
  guard(async () => {
    const claims = await verifyInner(
      'HS256',
      input.capability,
      (keyId) => secretKeyFor(input.verifier.secretKeys[keyId]),
      input.verifier,
    );
    if (!('backend' in claims)) {
      throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not Postgres.');
    }
    return claims;
  });

export const consumeDelegatedCapabilityNonce = async (
  claims: AnyDelegatedCapabilityClaims,
  verifier: NonceHolder,
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

const guard = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
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
  algorithm: 'EdDSA' | 'HS256',
  capability: string,
  keyFor: (keyId: string) => CryptoKey,
  verifier: Audience & FreshnessBounds,
): Promise<AnyDelegatedCapabilityClaims> => {
  const keyId = jwsKeyId(peekCompactJwsHeader(capability), algorithm);
  const { header, payload } = await verifyCompactJws(algorithm, capability, keyFor(keyId));
  if (jwsKeyId(header, algorithm) !== keyId) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability key id is unknown.');
  }
  const claims = parseClaims(payload);
  assertClaimSchema(claims);
  assertAudience(claims, verifier);
  assertFresh(claims, verifier);
  return claims;
};

const publicKeyFor = (key: CryptoKey | undefined): CryptoKey => {
  if (key?.type !== 'public') {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability key id is unknown.');
  }
  return key;
};

const secretKeyFor = (key: CryptoKey | undefined): CryptoKey => {
  if (key === undefined) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability key id is unknown.');
  }
  assertCapabilitySecretKey(key);
  return key;
};

const assertAudience = (claims: AnyDelegatedCapabilityClaims, verifier: Audience): void => {
  if (claims.iss !== verifier.issuer || claims.aud !== verifier.audience) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability issuer or audience does not match.');
  }
  if (claims.origin !== verifier.origin) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability origin does not match.');
  }
};

const assertFresh = (claims: AnyDelegatedCapabilityClaims, bounds: FreshnessBounds): void => {
  const skew = bounds.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const maxLifetime = bounds.maxLifetimeSeconds ?? DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS;
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
