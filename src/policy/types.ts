import type { IFileSystem } from 'just-bash/browser';

export type PolicyReasonCode =
  | 'ambiguous-path'
  | 'command-too-long'
  | 'dangerous-command'
  | 'host-escape'
  | 'network-disabled'
  | 'path-out-of-root'
  | 'pipeline-too-deep'
  | 'recursive-root'
  | 'reserved-path'
  | 'too-many-segments'
  | 'unbounded-work'
  | 'unsupported-command'
  | 'unsupported-syntax';

export interface CommandInspectDecision {
  readonly allow: boolean;
  readonly code?: string;
  readonly reason?: string;
}

export interface CommandInspector {
  readonly inspect: (command: string) => CommandInspectDecision | Promise<CommandInspectDecision>;
}

export interface CommandPolicyFileSystem {
  readonly lstat: IFileSystem['lstat'];
  readonly readlink: IFileSystem['readlink'];
}

export interface CommandPolicyOptions {
  readonly allowNetwork?: boolean;
  readonly allowRecursiveRoot?: boolean;
  readonly extraAllowCommands?: readonly string[];
  readonly extraDenyCommands?: readonly string[];
  readonly fs?: CommandPolicyFileSystem;
  readonly inspectors?: readonly CommandInspector[];
  readonly maxCommandLength?: number;
  readonly maxPipelineDepth?: number;
  readonly maxSegments?: number;
}

export const DEFAULT_MAX_COMMAND_LENGTH = 32_768;
export const DEFAULT_MAX_PIPELINE_DEPTH = 8;
export const DEFAULT_MAX_SEGMENTS = 32;

export const denyPolicy = (code: PolicyReasonCode, reason: string): CommandInspectDecision => ({
  allow: false,
  code,
  reason,
});

export const allowPolicy = (): CommandInspectDecision => ({ allow: true });
