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

export const DEFAULT_MAX_PATCH_SIZE = defaultMaxPatchSize;
export const Supabash = openWorkspace;
export const SupabashError = WorkspaceError;
export const applyDiff = applyV4ADiff;
export const applyPatch = applyWorkspacePatch;
export const applyPatchOperations = applyWorkspacePatchOperations;
