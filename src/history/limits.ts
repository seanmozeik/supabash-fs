export const DEFAULT_MAX_VISIBLE_FILES = 10_000;
export const DEFAULT_MAX_PATH_LENGTH = 1024;
export const DEFAULT_MAX_FILE_SIZE = 10_485_760;
export const DEFAULT_MAX_STAGED_BYTES = 52_428_800;
export const DEFAULT_MAX_HISTORY_PAGE_SIZE = 100;
export const DEFAULT_MAX_DIFF_PREVIEW_BYTES = 8192;
export const DEFAULT_MAX_TRANSACTION_METADATA_BYTES = 16_384;
export const DEFAULT_MAX_REVISIONS_RETAINED = 50;

export interface WorkspaceLimits {
  readonly maxDiffPreviewBytes?: number;
  readonly maxFileSize?: number;
  readonly maxHistoryPageSize?: number;
  readonly maxPathLength?: number;
  readonly maxStagedBytes?: number;
  readonly maxTransactionMetadataBytes?: number;
  readonly maxVisibleFiles?: number;
}
