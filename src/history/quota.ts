import { SupabashError } from '../api/errors.js';
import type { JsonValue } from '../api/json.js';
import type { UploadEntry } from '../core/storage.js';
import {
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_PATH_LENGTH,
  DEFAULT_MAX_STAGED_BYTES,
  DEFAULT_MAX_TRANSACTION_METADATA_BYTES,
  DEFAULT_MAX_VISIBLE_FILES,
  type WorkspaceLimits,
} from './limits.js';

export const assertCommitQuotas = (
  uploads: readonly UploadEntry[],
  deletions: readonly { path: string }[],
  visibleCount: number,
  metadata: Readonly<Record<string, JsonValue>> | undefined,
  limits: WorkspaceLimits = {},
): void => {
  const maxFiles = limits.maxVisibleFiles ?? DEFAULT_MAX_VISIBLE_FILES;
  const maxPath = limits.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;
  const maxFile = limits.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxStaged = limits.maxStagedBytes ?? DEFAULT_MAX_STAGED_BYTES;
  const maxMetadata = limits.maxTransactionMetadataBytes ?? DEFAULT_MAX_TRANSACTION_METADATA_BYTES;
  if (visibleCount > maxFiles) {
    throw quota('Workspace exceeds the visible file limit.');
  }
  for (const entry of [...uploads, ...deletions]) {
    if (entry.path.length > maxPath) {
      throw quota('Path exceeds the configured maximum length.', entry.path);
    }
  }
  let staged = 0;
  for (const upload of uploads) {
    const size = upload.body?.byteLength ?? 0;
    if (size > maxFile) {
      throw quota('File exceeds the configured maximum size.', upload.path);
    }
    staged += size;
  }
  if (staged > maxStaged) {
    throw quota('Staged changes exceed the configured byte budget.');
  }
  if (metadata !== undefined && jsonSize(metadata) > maxMetadata) {
    throw quota('Commit metadata exceeds the configured maximum size.');
  }
};

const jsonSize = (value: Readonly<Record<string, JsonValue>>): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const quota = (message: string, path?: string): SupabashError =>
  path === undefined
    ? new SupabashError('QUOTA_EXCEEDED', message)
    : new SupabashError('QUOTA_EXCEEDED', message, { path });
