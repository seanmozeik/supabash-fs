import type { WorkspaceLimits } from '../history/limits.js';
import type { DelegatedOperation, DelegatedVerifier } from './capability.js';
import type { Workspace, WorkspaceCapabilities } from './contracts.js';
import type { DocumentMetadata, TextDocumentCodec } from './document-codec.js';
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
  /** A detached copy of the committed base. Staged filesystem changes are excluded. */
  readonly committedSnapshot: () => PostgresWorkspaceSnapshot;
}

export interface PostgresWorkspaceDocumentSnapshot {
  readonly body: string;
  readonly bodyByteSize: number;
  readonly bodyHash: string;
  readonly byteSize: number;
  readonly content: string;
  readonly contentHash: string;
  readonly metadata: DocumentMetadata;
  readonly path: string;
}

export interface PostgresWorkspaceSnapshot {
  readonly committedAt: Date | null;
  readonly documents: readonly PostgresWorkspaceDocumentSnapshot[];
  readonly revision: string | null;
  readonly transactionId: string | null;
}

export interface DelegatedPostgresWorkspaceInfo {
  readonly actor: string;
  readonly correlationId: string;
  readonly operations: readonly DelegatedOperation[];
  readonly subject: string;
  readonly workspace: string;
}

export interface DelegatedPostgresWorkspace extends PostgresWorkspace {
  readonly delegation: DelegatedPostgresWorkspaceInfo;
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
  /** Require the signed capability to contain exactly this operation set. */
  readonly expectedOperations?: readonly DelegatedOperation[];
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly observability?: WorkspaceObservability;
  readonly serviceRoleKey: string;
  readonly supabaseUrl: string;
  readonly verifier: DelegatedVerifier;
}
