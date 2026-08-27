/**
 * Bun's ESM bundler emits empty stubs for `export { name } from './mod.js'`.
 * Rebind through local constants so the production bundle includes the implementations.
 */
/* oxlint-disable unicorn/prefer-export-from -- bun drops `export { name } from` as empty stubs */

import {
  CAPABILITY_SCHEMA_VERSION as capabilitySchemaVersion,
  DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS as defaultMaxCapabilityLifetimeSeconds,
} from './api/capability.js';
import { HISTORY_SCHEMA_VERSION as historySchemaVersion } from './api/commit.js';
import { Supabash as openWorkspace, SupabashError as WorkspaceError } from './api/supabash.js';
import { createDelegatedCapability as signDelegatedCapability } from './capability/create.js';
import { verifyDelegatedCapability as checkDelegatedCapability } from './capability/verify.js';
import {
  DEFAULT_MAX_DIFF_PREVIEW_BYTES as defaultMaxDiffPreviewBytes,
  DEFAULT_MAX_FILE_SIZE as defaultMaxFileSize,
  DEFAULT_MAX_HISTORY_PAGE_SIZE as defaultMaxHistoryPageSize,
  DEFAULT_MAX_PATH_LENGTH as defaultMaxPathLength,
  DEFAULT_MAX_REVISIONS_RETAINED as defaultMaxRevisionsRetained,
  DEFAULT_MAX_STAGED_BYTES as defaultMaxStagedBytes,
  DEFAULT_MAX_TRANSACTION_METADATA_BYTES as defaultMaxTransactionMetadataBytes,
  DEFAULT_MAX_VISIBLE_FILES as defaultMaxVisibleFiles,
} from './history/limits.js';
import { applyDiff as applyV4ADiff } from './patch/apply-diff.js';
import {
  applyPatch as applyWorkspacePatch,
  applyPatchOperations as applyWorkspacePatchOperations,
} from './patch/executor.js';
import { DEFAULT_MAX_PATCH_SIZE as defaultMaxPatchSize } from './patch/operations.js';
import { createCommandPolicy as createWorkspaceCommandPolicy } from './policy/inspect.js';
import {
  DEFAULT_MAX_COMMAND_LENGTH as defaultMaxCommandLength,
  DEFAULT_MAX_PIPELINE_DEPTH as defaultMaxPipelineDepth,
  DEFAULT_MAX_SEGMENTS as defaultMaxSegments,
} from './policy/types.js';

export type {
  CapabilityNonceStore,
  CreateDelegatedCapabilityInput,
  DelegatedCapabilityClaims,
  DelegatedOperation,
  DelegatedVerifier,
  OpenDelegatedOptions,
  VerifyDelegatedCapabilityInput,
} from './api/capability.js';
export type {
  CommitReceipt,
  Workspace,
  WorkspaceChange,
  WorkspaceChangeKind,
  WorkspaceEntryKind,
} from './api/contracts.js';
export type {
  CommitContext,
  CommitCoordinator,
  CommitLease,
  CommitLeaseInput,
  CommitOptions,
  CommitStatus,
} from './api/commit.js';
export type { SupabashErrorCode } from './api/errors.js';
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

export const CAPABILITY_SCHEMA_VERSION = capabilitySchemaVersion;
export const DEFAULT_MAX_CAPABILITY_LIFETIME_SECONDS = defaultMaxCapabilityLifetimeSeconds;
export const DEFAULT_MAX_COMMAND_LENGTH = defaultMaxCommandLength;
export const DEFAULT_MAX_DIFF_PREVIEW_BYTES = defaultMaxDiffPreviewBytes;
export const DEFAULT_MAX_FILE_SIZE = defaultMaxFileSize;
export const DEFAULT_MAX_HISTORY_PAGE_SIZE = defaultMaxHistoryPageSize;
export const DEFAULT_MAX_PATCH_SIZE = defaultMaxPatchSize;
export const DEFAULT_MAX_PATH_LENGTH = defaultMaxPathLength;
export const DEFAULT_MAX_PIPELINE_DEPTH = defaultMaxPipelineDepth;
export const DEFAULT_MAX_REVISIONS_RETAINED = defaultMaxRevisionsRetained;
export const DEFAULT_MAX_SEGMENTS = defaultMaxSegments;
export const DEFAULT_MAX_STAGED_BYTES = defaultMaxStagedBytes;
export const DEFAULT_MAX_TRANSACTION_METADATA_BYTES = defaultMaxTransactionMetadataBytes;
export const DEFAULT_MAX_VISIBLE_FILES = defaultMaxVisibleFiles;
export const HISTORY_SCHEMA_VERSION = historySchemaVersion;
export const Supabash = openWorkspace;
export const SupabashError = WorkspaceError;
export const applyDiff = applyV4ADiff;
export const applyPatch = applyWorkspacePatch;
export const applyPatchOperations = applyWorkspacePatchOperations;
export const createCommandPolicy = createWorkspaceCommandPolicy;
export const createDelegatedCapability = signDelegatedCapability;
export const verifyDelegatedCapability = checkDelegatedCapability;
