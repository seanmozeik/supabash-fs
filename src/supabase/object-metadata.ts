import type { WorkspaceEntryKind } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type { RemoteEntry, UploadEntry } from '../core/storage.js';

const DEFAULT_MODES: Readonly<Record<WorkspaceEntryKind, number>> = {
  directory: 0o755,
  file: 0o644,
  symlink: 0o777,
};

export interface StorageObjectInfo {
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly metadata?: unknown;
  readonly size?: number;
}

interface RemoteEntryInput {
  readonly contentType?: string;
  readonly etag?: string;
  readonly fallbackModifiedAt?: string;
  readonly fallbackSize?: number;
  readonly kind: WorkspaceEntryKind;
  readonly metadata: unknown;
  readonly path: string;
}

export const entryFromInfo = (
  path: string,
  kind: WorkspaceEntryKind,
  info: StorageObjectInfo,
): RemoteEntry =>
  remoteEntry({
    ...(info.contentType !== undefined && { contentType: info.contentType }),
    ...(info.etag !== undefined && { etag: info.etag }),
    ...(info.lastModified !== undefined && { fallbackModifiedAt: info.lastModified }),
    ...(info.size !== undefined && { fallbackSize: info.size }),
    kind,
    metadata: info.metadata,
    path,
  });

export const metadataFor = (entry: UploadEntry): Record<string, string> => ({
  supabash_content_hash: entry.contentHash ?? '',
  supabash_kind: entry.kind,
  supabash_mode: String(entry.mode),
  supabash_modified_at: entry.modifiedAt.toISOString(),
  supabash_target: entry.target ?? '',
  supabash_version_hash: entry.versionHash,
});

export const kindFromInfo = (info: StorageObjectInfo): WorkspaceEntryKind => {
  const kind = metadataString(info.metadata, 'supabash_kind');
  if (kind === 'directory' || kind === 'symlink' || kind === 'file') {
    return kind;
  }
  if (info.contentType === 'application/vnd.supabash.directory') {
    return 'directory';
  }
  return info.contentType === 'application/vnd.supabash.symlink' ? 'symlink' : 'file';
};

export const contentTypeFor = (entry: UploadEntry): string => {
  if (entry.kind === 'directory') {
    return 'application/vnd.supabash.directory';
  }
  if (entry.kind === 'symlink') {
    return 'application/vnd.supabash.symlink';
  }
  return entry.contentType ?? 'application/octet-stream';
};

const remoteEntry = (input: RemoteEntryInput): RemoteEntry => {
  const modifiedAt =
    dateFrom(metadataString(input.metadata, 'supabash_modified_at')) ??
    dateFrom(input.fallbackModifiedAt) ??
    new Date(0);
  const contentHash = metadataString(input.metadata, 'supabash_content_hash');
  const contentType = input.contentType ?? metadataString(input.metadata, 'mimetype');
  const etag = stripEtag(input.etag ?? metadataString(input.metadata, 'eTag'));
  const target = metadataString(input.metadata, 'supabash_target');
  const versionHash = metadataString(input.metadata, 'supabash_version_hash');
  if (input.kind === 'symlink' && target === undefined) {
    throw new SupabashError('STORAGE', 'Stored symbolic link has no target metadata.', {
      path: input.path,
    });
  }
  return {
    ...(contentHash !== undefined && { contentHash }),
    ...(contentType !== undefined && { contentType }),
    ...(etag !== undefined && { etag }),
    kind: input.kind,
    mode: modeFrom(input.metadata, input.kind),
    modifiedAt,
    path: input.path,
    size: input.fallbackSize ?? metadataNumber(input.metadata, 'size') ?? 0,
    ...(target !== undefined && { target }),
    ...(versionHash !== undefined && { versionHash }),
  };
};

const modeFrom = (metadata: unknown, kind: WorkspaceEntryKind): number => {
  const value = metadataNumber(metadata, 'supabash_mode');
  if (value !== undefined && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return DEFAULT_MODES[kind];
};

const metadataString = (metadata: unknown, key: string): string | undefined => {
  const value = metadataValue(metadata, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const metadataNumber = (metadata: unknown, key: string): number | undefined => {
  const value = metadataValue(metadata, key);
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const metadataValue = (metadata: unknown, key: string): unknown => {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const camelKey = camelCase(key);
  const direct = metadata[key] ?? metadata[camelKey];
  const nested = metadata['metadata'];
  return direct ?? (isRecord(nested) ? (nested[key] ?? nested[camelKey]) : undefined);
};

const camelCase = (value: string): string =>
  value
    .split('_')
    .map((part, index) =>
      index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join('');

const stripEtag = (etag: string | undefined): string | undefined => etag?.replaceAll('"', '');

const dateFrom = (value: string | undefined): Date | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
