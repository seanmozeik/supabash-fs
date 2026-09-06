import { InMemoryFs, type IFileSystem } from 'just-bash/browser';

import type { Workspace } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import { restrictFileSystem } from '../capability/readonly-fs.js';
import { sha256 } from '../core/hash.js';
import { normalizeVirtualPath, parentPaths } from '../core/path.js';

export interface SnapshotFile {
  readonly path: string;
  readonly content: string;
}

export interface SnapshotLimits {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

/** A detached UTF-8 source. Its revision is supplied by the trusted publisher. */
export interface FileSystemSnapshot {
  readonly fs: IFileSystem;
  readonly sourceId: string;
  readonly revision: string;
  readonly digest: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

export interface CreateFileSystemSnapshotOptions {
  readonly sourceId: string;
  readonly revision: string;
  readonly files: readonly SnapshotFile[];
  readonly limits?: SnapshotLimits;
}

const snapshotLimits = (limits: SnapshotLimits = {}) => {
  const maxFiles = limits.maxFiles ?? 10_000;
  const maxBytes = limits.maxBytes ?? 16 * 1024 * 1024;
  if (![maxFiles, maxBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new SupabashError(
      'QUOTA_EXCEEDED',
      'Snapshot limits must be non-negative safe integers.',
    );
  }
  return { maxBytes, maxFiles };
};

/** Adapt rows from one consistent table read, a release bundle, or another trusted source. */
export const createFileSystemSnapshot = async (
  options: CreateFileSystemSnapshotOptions,
): Promise<FileSystemSnapshot> => {
  const { sourceId, revision } = options;
  if ([sourceId, revision].some((value) => value.trim().length === 0 || value.length > 1024)) {
    throw new SupabashError(
      'INVALID_PATH',
      'Snapshot source and revision must be bounded identifiers.',
    );
  }
  const { maxBytes, maxFiles } = snapshotLimits(options.limits);
  if (options.files.length > maxFiles) {
    throw new SupabashError('QUOTA_EXCEEDED', 'Snapshot exceeds its file limit.');
  }
  const paths = new Set<string>();
  let byteCount = 0;
  const files = options.files
    .map(({ path, content }) => {
      const normalized = normalizeVirtualPath(path);
      if (!path.startsWith('/') || normalized === '/' || paths.has(normalized)) {
        throw new SupabashError('INVALID_PATH', 'Snapshot file path is invalid or duplicated.', {
          path,
        });
      }
      paths.add(normalized);
      byteCount += new TextEncoder().encode(content).length;
      if (byteCount > maxBytes) {
        throw new SupabashError('QUOTA_EXCEEDED', 'Snapshot exceeds its byte limit.');
      }
      return { content, path: normalized };
    })
    .toSorted((left, right) => {
      if (left.path === right.path) {
        return 0;
      }
      return left.path < right.path ? -1 : 1;
    });
  if (files.some(({ path }) => parentPaths(path).some((parent) => paths.has(parent)))) {
    throw new SupabashError('INVALID_PATH', 'A snapshot file cannot also be a directory.');
  }
  const fs = new InMemoryFs(Object.fromEntries(files.map(({ path, content }) => [path, content])));
  const fingerprints = await Promise.all(
    files.map(async ({ path, content }) => [path, await sha256(new TextEncoder().encode(content))]),
  );
  const digest = await sha256(new TextEncoder().encode(JSON.stringify(fingerprints)));
  return Object.freeze({
    byteCount,
    digest,
    fileCount: files.length,
    fs: Object.freeze(restrictFileSystem(fs, 'read')),
    revision,
    sourceId,
  });
};

/** Read an explicit immutable text revision; staged edits never enter this snapshot. */
export const readWorkspaceSnapshot = async (options: {
  readonly workspace: Pick<Workspace, 'readRevision'>;
  readonly sourceId: string;
  readonly revision: string;
  readonly limits?: SnapshotLimits;
}): Promise<FileSystemSnapshot> => {
  const { workspace, sourceId, revision, limits } = options;
  const { maxFiles, maxBytes } = snapshotLimits(limits);
  const view = await workspace.readRevision(revision);
  if (view.revision !== revision) {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      'Snapshot revision does not match the requested revision.',
    );
  }
  if (view.entries.some((entry) => entry.entryKind === 'symlink')) {
    throw new SupabashError(
      'UNSUPPORTED_CONTENT',
      'Shared text snapshots do not contain symbolic links.',
    );
  }
  const entries = view.entries.filter((entry) => entry.entryKind === 'file');
  if (entries.length > maxFiles || entries.reduce((sum, entry) => sum + entry.size, 0) > maxBytes) {
    throw new SupabashError('QUOTA_EXCEEDED', 'Revision exceeds snapshot limits.');
  }
  const files: SnapshotFile[] = [];
  let byteCount = 0;
  for (const entry of entries) {
    const content = await view.readFile(entry.path);
    byteCount += new TextEncoder().encode(content).length;
    if (byteCount > maxBytes) {
      throw new SupabashError('QUOTA_EXCEEDED', 'Revision content exceeds snapshot limits.');
    }
    files.push({ content, path: entry.path });
  }
  return createFileSystemSnapshot({
    files,
    revision,
    sourceId,
    ...(limits !== undefined && { limits }),
  });
};
