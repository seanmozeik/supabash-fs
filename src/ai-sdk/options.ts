import type { Workspace } from '../api/contracts.js';
import type { ApplyPatchOptions } from '../patch/operations.js';

export interface CommandInspectDecision {
  readonly allow: boolean;
  readonly code?: string;
  readonly reason?: string;
}

export interface CommandInspector {
  readonly inspect: (command: string) => CommandInspectDecision | Promise<CommandInspectDecision>;
}

export interface BashToolLimits {
  readonly maxBashOutput?: number;
  readonly maxCommandLength?: number;
  readonly maxToolExecutionMs?: number;
}

export interface BashToolOptions {
  readonly limits?: BashToolLimits;
  readonly policy?: CommandInspector;
}

export interface ViewImageOptions {
  readonly enabled: boolean;
  readonly maxBytes?: number;
}

export interface ViewImageResult {
  readonly data: string;
  readonly mediaType: string;
  readonly path: string;
}

export interface CreateToolsOptions {
  readonly applyPatch?: boolean | ApplyPatchOptions;
  readonly bash?: BashToolOptions;
  readonly viewImage?: ViewImageOptions;
  readonly workspace: Workspace;
}
