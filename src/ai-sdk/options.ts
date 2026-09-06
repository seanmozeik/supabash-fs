import type { CustomCommand, IFileSystem } from 'just-bash/browser';

import type { ApplyPatchOptions } from '../patch/operations.js';
import type { CommandInspector, CommandPolicyOptions } from '../policy/types.js';

export type {
  CommandInspectDecision,
  CommandInspector,
  CommandPolicyOptions,
} from '../policy/types.js';
export interface BashToolLimits {
  readonly maxBashOutput?: number;
  readonly maxCommandLength?: number;
  readonly maxExecutionTimeMs?: number;
}

export interface BashToolOptions {
  readonly customCommands?: readonly CustomCommand[];
  readonly limits?: BashToolLimits;
  readonly policy?: CommandInspector;
  readonly policyOptions?: CommandPolicyOptions;
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
  /** The authorized tool view. Commit and history handles stay with the host. */
  readonly filesystem: IFileSystem;
}
