/**
 * Bun's ESM bundler emits empty stubs for `export { name } from './mod.js'`.
 * Rebind through local constants so the production bundle includes the implementations.
 */
/* oxlint-disable unicorn/prefer-export-from -- bun drops `export { name } from` as empty stubs */

import { DEFAULT_MAX_BASH_EXECUTION_TIME_MS as defaultMaxBashExecutionTimeMs } from './bash.js';
import { createTools as createWorkspaceTools } from './create-tools.js';

export type { WorkspaceTools, WorkspaceToolSet } from './create-tools.js';
export type {
  BashToolLimits,
  BashToolOptions,
  CommandInspectDecision,
  CommandInspector,
  CreateToolsOptions,
  ViewImageOptions,
  ViewImageResult,
} from './options.js';

export const createTools = createWorkspaceTools;
export const DEFAULT_MAX_BASH_EXECUTION_TIME_MS = defaultMaxBashExecutionTimeMs;
