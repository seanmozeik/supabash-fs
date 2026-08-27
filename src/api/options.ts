import type { WorkspaceLimits } from '../history/limits.js';
import type { CommitCoordinator } from './commit.js';

export interface SupabashOptions {
  readonly bucket: string;
  readonly coordinator?: CommitCoordinator;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly publishableKey: string;
  readonly request: Request;
  readonly supabaseUrl: string;
  readonly uploadConcurrency?: number;
}
