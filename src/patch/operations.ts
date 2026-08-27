export type ApplyPatchOperation =
  | { readonly type: 'create_file'; readonly path: string; readonly diff: string }
  | {
      readonly type: 'update_file';
      readonly path: string;
      readonly diff: string;
      readonly moveTo?: string;
    }
  | { readonly type: 'delete_file'; readonly path: string };

export type ApplyPatchStatus = 'completed' | 'failed';

export type ApplyPatchBatchMode = 'all-or-nothing' | 'ordered';

export interface ApplyPatchResult {
  readonly status: ApplyPatchStatus;
  readonly output?: string;
  readonly cause?: Error;
}

export interface ApplyPatchOptions {
  readonly maxPatchSize?: number;
  readonly mode?: ApplyPatchBatchMode;
}

export const DEFAULT_MAX_PATCH_SIZE = 1_048_576;
