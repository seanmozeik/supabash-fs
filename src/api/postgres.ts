import type { WorkspaceLimits } from '../history/limits.js';
import type { DelegatedVerifier } from './capability.js';
import type { Workspace, WorkspaceCapabilities } from './contracts.js';
import type { TextDocumentCodec } from './document-codec.js';
import type { WorkspaceObservability } from './observability.js';

export const POSTGRES_WORKSPACE_CAPABILITIES = Object.freeze({
  backend: 'postgres',
  content: 'utf8-text-tree',
  durableEmptyDirectories: false,
  modes: false,
  symbolicLinks: false,
} as const satisfies WorkspaceCapabilities);

export type PostgresWorkspaceCapabilities = typeof POSTGRES_WORKSPACE_CAPABILITIES;

export interface PostgresWorkspace extends Workspace {
  readonly capabilities: PostgresWorkspaceCapabilities;
}

export interface PostgresWorkspaceOptions {
  /** The one canonical workspace identifier understood by the installed SQL functions. */
  readonly workspace: string;
  readonly documentCodec?: TextDocumentCodec;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly observability?: WorkspaceObservability;
  readonly publishableKey: string;
  readonly request: Request;
  readonly supabaseUrl: string;
}

export interface CreatePostgresWorkspaceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly publishableKey: string;
  readonly request: Request;
  readonly supabaseUrl: string;
}

export interface OpenPostgresDelegatedOptions {
  readonly capability: string;
  readonly documentCodec?: TextDocumentCodec;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly observability?: WorkspaceObservability;
  readonly serviceRoleKey: string;
  readonly supabaseUrl: string;
  readonly verifier: DelegatedVerifier;
}
