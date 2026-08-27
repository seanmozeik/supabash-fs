/**
 * Bun's ESM bundler emits empty stubs for `export { name } from './mod.js'`.
 * Rebind through local constants so the production bundle includes the implementations.
 */
/* oxlint-disable unicorn/prefer-export-from -- bun drops `export { name } from` as empty stubs */

import { Supabash as openWorkspace, SupabashError as WorkspaceError } from './api/supabash.js';
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
  CommitReceipt,
  Workspace,
  WorkspaceChange,
  WorkspaceChangeKind,
  WorkspaceEntryKind,
} from './api/contracts.js';
export type { SupabashErrorCode } from './api/errors.js';
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

export const DEFAULT_MAX_COMMAND_LENGTH = defaultMaxCommandLength;
export const DEFAULT_MAX_PATCH_SIZE = defaultMaxPatchSize;
export const DEFAULT_MAX_PIPELINE_DEPTH = defaultMaxPipelineDepth;
export const DEFAULT_MAX_SEGMENTS = defaultMaxSegments;
export const Supabash = openWorkspace;
export const SupabashError = WorkspaceError;
export const applyDiff = applyV4ADiff;
export const applyPatch = applyWorkspacePatch;
export const applyPatchOperations = applyWorkspacePatchOperations;
export const createCommandPolicy = createWorkspaceCommandPolicy;
