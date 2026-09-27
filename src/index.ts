export { Bash, defineCommand, InMemoryFs } from 'just-bash/browser';
export type { CustomCommand, IFileSystem, FsStat } from 'just-bash/browser';
export {
  CAPABILITY_SCHEMA_VERSION,
  DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS,
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
} from './api/capability.js';
export { HISTORY_SCHEMA_VERSION } from './api/commit.js';
export {
  createYamlFrontmatterCodec,
  plainTextDocumentCodec,
  renderStoredDocument,
} from './api/document-codec.js';
export {
  isRetryableSupabashError,
  isSupabashError,
  isUnknownOutcomeSupabashError,
} from './api/errors.js';
export { POSTGRES_WORKSPACE_CAPABILITIES } from './api/postgres.js';
export { Supabash, SupabashError } from './api/supabash.js';
export {
  createDelegatedCapability,
  createPostgresDelegatedCapability,
} from './capability/create.js';
export { importCapabilitySecret } from './capability/secret.js';
export { verifyDelegatedCapability } from './capability/verify.js';
export { createWorkspaceFileSystemView } from './core/filesystem-view.js';
export {
  DEFAULT_MAX_DIFF_PREVIEW_BYTES,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_HISTORY_PAGE_SIZE,
  DEFAULT_MAX_PATH_LENGTH,
  DEFAULT_MAX_REVISIONS_RETAINED,
  DEFAULT_MAX_STAGED_BYTES,
  DEFAULT_MAX_TRANSACTION_METADATA_BYTES,
  DEFAULT_MAX_VISIBLE_FILES,
} from './history/limits.js';
export { createMountedFileSystem } from './mounts/compose.js';
export { createFileSystemSnapshot, readWorkspaceSnapshot } from './mounts/snapshot.js';
export { applyDiff } from './patch/apply-diff.js';
export { applyPatch, applyPatchOperations } from './patch/executor.js';
export { DEFAULT_MAX_PATCH_SIZE } from './patch/operations.js';
export { createCommandPolicy } from './policy/inspect.js';
export {
  DEFAULT_MAX_COMMAND_LENGTH,
  DEFAULT_MAX_PIPELINE_DEPTH,
  DEFAULT_MAX_SEGMENTS,
} from './policy/types.js';

export type {
  CapabilityNonceStore,
  AnyDelegatedCapabilityClaims,
  CreateDelegatedCapabilityInput,
  CreatePostgresDelegatedCapabilityInput,
  DelegatedCapabilityClaims,
  DelegatedOperation,
  DelegatedVerifier,
  OpenDelegatedOptions,
  PostgresDelegatedCapabilityClaims,
  VerifyDelegatedCapabilityInput,
} from './api/capability.js';
export type {
  CommitReceipt,
  Workspace,
  WorkspaceBackendKind,
  WorkspaceCapabilities,
  WorkspaceChange,
  WorkspaceChangeKind,
  WorkspaceEntryKind,
} from './api/contracts.js';
export type {
  DocumentMetadata,
  DocumentMetadataValue,
  StoredTextDocument,
  TextDocumentCodec,
  YamlFrontmatterCodecOptions,
} from './api/document-codec.js';
export type {
  WorkspaceObservability,
  WorkspaceOperation,
  WorkspaceOperationEvent,
} from './api/observability.js';
export type {
  CreatePostgresWorkspaceOptions,
  DelegatedPostgresWorkspace,
  DelegatedPostgresWorkspaceInfo,
  OpenPostgresDelegatedOptions,
  PostgresWorkspaceDocumentSnapshot,
  PostgresWorkspace,
  PostgresWorkspaceCapabilities,
  PostgresWorkspaceOptions,
  PostgresWorkspaceSnapshot,
} from './api/postgres.js';
export type {
  CommitContext,
  CommitCoordinator,
  CommitLease,
  CommitLeaseInput,
  CommitOptions,
  CommitStatus,
} from './api/commit.js';
export type { SupabashErrorCode, SupabashErrorOptions } from './api/errors.js';
export type {
  CheckpointOptions,
  CheckpointReceipt,
  CheckpointRecord,
  HistoryPage,
  HistoryQuery,
  HistoryRecord,
  PurgeOptions,
  PurgeReceipt,
  ReadonlyWorkspaceView,
  RestorePlan,
  RevisionDiff,
  RevisionDiffEntry,
  RevisionDiffInput,
  RevisionDiffKind,
  RevisionDiffRef,
  RevisionEntry,
} from './api/history.js';
export type { JsonValue } from './api/json.js';
export type { WorkspaceLimits } from './history/limits.js';
export type { WorkspaceFileSystemViewOptions } from './core/filesystem-view.js';
export type {
  FileSystemMount,
  WritableWorkspaceMount,
  ReadonlySnapshotMount,
  MountedFileSystem,
  MountDescriptor,
} from './mounts/contracts.js';
export type {
  FileSystemSnapshot,
  SnapshotFile,
  SnapshotLimits,
  CreateFileSystemSnapshotOptions,
} from './mounts/snapshot.js';
export type { SupabashOptions } from './api/options.js';
export type { ApplyDiffMode } from './patch/apply-diff.js';
export type {
  ApplyPatchBatchMode,
  ApplyPatchOperation,
  ApplyPatchOptions,
  ApplyPatchResult,
  ApplyPatchStatus,
} from './patch/operations.js';
export type {
  CommandInspectDecision,
  CommandInspector,
  CommandPolicyFileSystem,
  CommandPolicyOptions,
  PolicyReasonCode,
} from './policy/types.js';

export const POSTGRES_INSTALL_SQL_URL = new URL(
  '../sql/postgres/0001_install.sql',
  import.meta.url,
);
export const POSTGRES_REMOVE_SQL_URL = new URL('../sql/postgres/0001_remove.sql', import.meta.url);
