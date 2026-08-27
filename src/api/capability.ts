import type { WorkspaceLimits } from '../history/limits.js';
import type { CommitCoordinator } from './commit.js';

export const CAPABILITY_SCHEMA_VERSION = 1;
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

export interface CreateDelegatedCapabilityInput {
  readonly claims: DelegatedCapabilityClaims;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
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
