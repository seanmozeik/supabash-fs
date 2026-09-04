import type { WorkspaceLimits } from '../history/limits.js';
import type { CommitCoordinator } from './commit.js';

export const CAPABILITY_SCHEMA_VERSION = 1;
export const POSTGRES_CAPABILITY_SCHEMA_VERSION = 3;
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
export const DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS = 900;

export type DelegatedOperation =
  | 'checkpoint'
  | 'commit'
  | 'history'
  | 'purge'
  | 'read'
  | 'restore'
  | 'write';

/** One canonical Postgres workspace identifier. Accepts UUID versions 1 to 8. */
export const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const isDelegatedOperation = (value: string): value is DelegatedOperation => {
  switch (value) {
    case 'checkpoint':
    case 'commit':
    case 'history':
    case 'purge':
    case 'read':
    case 'restore':
    case 'write': {
      return true;
    }
    default: {
      return false;
    }
  }
};

export interface DelegatedCapabilityClaims {
  readonly aud: string;
  readonly bucket: string;
  readonly corr: string;
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly nonce: string;
  readonly ops: readonly DelegatedOperation[];
  readonly origin: string;
  readonly prefix: string;
  readonly sub: string;
  readonly sv: number;
}

export interface PostgresDelegatedCapabilityClaims {
  readonly aud: string;
  readonly backend: 'postgres';
  readonly corr: string;
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly nonce: string;
  readonly ops: readonly DelegatedOperation[];
  readonly origin: string;
  readonly sub: string;
  readonly sv: typeof POSTGRES_CAPABILITY_SCHEMA_VERSION;
  readonly workspace: string;
}

export type AnyDelegatedCapabilityClaims =
  | DelegatedCapabilityClaims
  | PostgresDelegatedCapabilityClaims;

/** Storage capabilities are signed with Ed25519 and verified by the delegate itself. */
export interface CreateDelegatedCapabilityInput {
  readonly claims: DelegatedCapabilityClaims;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

/**
 * Postgres capabilities are signed with HMAC-SHA256. The database is the only
 * verifier, so the secret is shared between the minting host and the database
 * and is never handed to the delegate that presents the capability.
 */
export interface CreatePostgresDelegatedCapabilityInput {
  readonly claims: PostgresDelegatedCapabilityClaims;
  readonly keyId: string;
  readonly secretKey: CryptoKey;
}

export interface CapabilityNonceStore {
  readonly consume: (nonce: string, expiresAt: Date) => Promise<boolean>;
}

export interface DelegatedVerifier {
  readonly audience: string;
  readonly clockSkewSeconds?: number;
  readonly issuer: string;
  readonly maxLifetimeSeconds?: number;
  readonly nonceStore?: CapabilityNonceStore;
  readonly origin: string;
  readonly publicKeys: Readonly<Record<string, CryptoKey>>;
}

export interface VerifyDelegatedCapabilityInput {
  readonly capability: string;
  readonly verifier: DelegatedVerifier;
}

export interface OpenDelegatedOptions {
  readonly bucket: string;
  readonly capability: string;
  readonly coordinator?: CommitCoordinator;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly serviceRoleKey: string;
  readonly supabaseUrl: string;
  readonly uploadConcurrency?: number;
  readonly verifier: DelegatedVerifier;
}
