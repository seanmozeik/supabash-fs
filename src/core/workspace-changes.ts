import type { CommitContext } from '../api/commit.js';
import type { WorkspaceChange, WorkspaceEntryKind } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type { RevisionEntry } from '../api/history.js';
import { contentTypeForPath } from './content-type.js';
import { comparePaths } from './entry-order.js';
import { sha256 } from './hash.js';
import type { PendingChanges, RemoteEntry, UploadDraft, UploadEntry } from './storage.js';

type BaselineEntry = (path: string) => RemoteEntry | undefined;
type EntryKind = (path: string) => WorkspaceEntryKind;

export const previewWorkspaceChanges = (
  pending: PendingChanges,
  kindOf: EntryKind,
): readonly WorkspaceChange[] => {
  const movedFrom = new Set(pending.moves.map((move) => move.from));
  const movedTo = new Set(pending.moves.map((move) => move.to));
  return [
    ...pending.moves.map((move) => ({
      entryKind: kindOf(move.to),
      kind: 'move' as const,
      moveFrom: move.from,
      moveTo: move.to,
      path: move.to,
    })),
    ...pending.deletions
      .filter((entry) => !movedFrom.has(entry.path))
      .map((entry) => changeForDelete(entry)),
    ...pending.upserts
      .filter((path) => !movedTo.has(path))
      .map((path) => ({ entryKind: kindOf(path), kind: 'upsert' as const, path })),
  ].toSorted((left, right) => comparePaths(left.path, right.path));
};

export const committedWorkspaceChanges = (
  pending: PendingChanges,
  uploads: readonly (RemoteEntry | UploadEntry)[],
  baseline: readonly RemoteEntry[],
  baselineEntry: BaselineEntry,
): readonly WorkspaceChange[] => {
  const baselineByPath = new Map(baseline.map((entry) => [entry.path, entry]));
  const uploaded = new Map(uploads.map((entry) => [entry.path, entry]));
  const movedFrom = new Set(pending.moves.map((move) => move.from));
  const movedTo = new Set(pending.moves.map((move) => move.to));
  return [
    ...pending.moves.map((move) =>
      changeForMove(
        baselineByPath.get(move.from) ?? baselineEntry(move.from),
        uploaded.get(move.to) ?? baselineEntry(move.to),
        move.from,
        move.to,
      ),
    ),
    ...pending.deletions
      .filter((entry) => !movedFrom.has(entry.path))
      .map((entry) => changeForDelete(baselineByPath.get(entry.path) ?? entry)),
    ...pending.upserts
      .filter((path) => !movedTo.has(path))
      .map((path) =>
        changeForUpload(uploaded.get(path) ?? baselineEntry(path), baselineByPath.get(path)),
      ),
  ].toSorted((left, right) => comparePaths(left.path, right.path));
};

export const prepareUpload = async (entry: UploadDraft): Promise<UploadEntry> => {
  const contentHash = await contentHashFor(entry);
  const versionHash = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        contentHash,
        kind: entry.kind,
        mode: entry.mode,
        modifiedAt: entry.modifiedAt.toISOString(),
        target: entry.target,
      }),
    ),
  );
  return {
    ...entry,
    contentHash,
    contentType: entry.contentType ?? contentTypeForPath(entry.path),
    versionHash,
  };
};

export const visibleEntryCount = (
  baseline: readonly RemoteEntry[],
  deletions: readonly RemoteEntry[],
  uploads: readonly UploadEntry[],
): number => {
  const deleted = new Set(deletions.map((entry) => entry.path));
  const visible = new Set(baseline.map((entry) => entry.path).filter((path) => !deleted.has(path)));
  for (const upload of uploads) {
    visible.add(upload.path);
  }
  return visible.size;
};

export const mergeAuditBaseline = (
  current: readonly RemoteEntry[],
  audited: readonly RemoteEntry[],
): readonly RemoteEntry[] => {
  const byPath = new Map(audited.map((entry) => [entry.path, entry]));
  return current.map((entry) => {
    const prior = byPath.get(entry.path);
    return entry.contentHash === undefined && prior?.contentHash !== undefined
      ? { ...entry, contentHash: prior.contentHash }
      : entry;
  });
};

export const sameRemoteVersion = (baseline: RemoteEntry, current: RemoteEntry): boolean => {
  if (baseline.etag !== undefined || current.etag !== undefined) {
    return baseline.etag === current.etag;
  }
  if (baseline.versionHash !== undefined || current.versionHash !== undefined) {
    return baseline.versionHash === current.versionHash;
  }
  return (
    baseline.size === current.size && baseline.modifiedAt.getTime() === current.modifiedAt.getTime()
  );
};

export const remoteAsRevision = (entry: RemoteEntry): RevisionEntry => ({
  entryKind: entry.kind,
  mode: entry.mode,
  path: entry.path,
  size: entry.size,
  ...(entry.contentHash !== undefined && { contentHash: entry.contentHash }),
  ...(entry.etag !== undefined && { etag: entry.etag }),
  ...(entry.target !== undefined && { target: entry.target }),
});

export const resolvedCommitContext = (
  context: CommitContext | undefined,
  restoreSourceRevision: string | undefined,
): CommitContext => {
  const resolved = context ?? { actor: 'workspace', correlationId: crypto.randomUUID() };
  if (restoreSourceRevision === undefined) {
    return resolved;
  }
  return { ...resolved, metadata: { ...resolved.metadata, sourceRevision: restoreSourceRevision } };
};

export const conflictError = (path: string): SupabashError =>
  new SupabashError('COMMIT_CONFLICT', 'Stored entry changed after the workspace opened.', {
    path,
  });

export const partialCommitError = (error: unknown): SupabashError =>
  new SupabashError('PARTIAL_COMMIT', 'Commit did not finish publishing a complete revision.', {
    cause: asSupabashError(error),
  });

export const asSupabashError = (error: unknown): SupabashError =>
  error instanceof SupabashError
    ? error
    : new SupabashError('STORAGE', 'Workspace storage operation failed.', { cause: error });

const contentHashFor = (entry: UploadDraft): Promise<string> =>
  entry.body === undefined
    ? sha256(new TextEncoder().encode(entry.target ?? ''))
    : sha256(entry.body);

const changeForDelete = (entry: RemoteEntry): WorkspaceChange => ({
  entryKind: entry.kind,
  kind: 'delete',
  path: entry.path,
  ...(entry.contentHash !== undefined && {
    beforeHash: entry.contentHash,
    contentHash: entry.contentHash,
  }),
  ...(entry.etag !== undefined && { beforeEtag: entry.etag, etag: entry.etag }),
  beforeSize: entry.size,
});

const changeForUpload = (
  entry: RemoteEntry | UploadEntry | undefined,
  before?: RemoteEntry,
): WorkspaceChange => {
  if (entry === undefined) {
    throw new SupabashError('STORAGE', 'Upload is missing from the commit set.');
  }
  const etag = 'etag' in entry ? entry.etag : undefined;
  const afterSize = 'size' in entry ? entry.size : entry.body?.byteLength;
  return {
    entryKind: entry.kind,
    kind: 'upsert',
    path: entry.path,
    ...(entry.contentHash !== undefined && {
      afterHash: entry.contentHash,
      contentHash: entry.contentHash,
    }),
    ...(before?.contentHash !== undefined && { beforeHash: before.contentHash }),
    ...(before?.etag !== undefined && { beforeEtag: before.etag }),
    ...(before !== undefined && { beforeSize: before.size }),
    ...(etag !== undefined && { afterEtag: etag, etag }),
    ...(afterSize !== undefined && { afterSize }),
  };
};

const changeForMove = (
  before: RemoteEntry | undefined,
  after: RemoteEntry | UploadEntry | undefined,
  from: string,
  to: string,
): WorkspaceChange => {
  if (before === undefined || after === undefined) {
    throw new SupabashError('STORAGE', 'Move is missing from the commit set.');
  }
  const afterEtag = 'etag' in after ? after.etag : undefined;
  const afterSize = 'size' in after ? after.size : after.body?.byteLength;
  return {
    entryKind: after.kind,
    kind: 'move',
    moveFrom: from,
    moveTo: to,
    path: to,
    ...(before.contentHash !== undefined && {
      beforeHash: before.contentHash,
      contentHash: after.contentHash ?? before.contentHash,
    }),
    ...(after.contentHash !== undefined && { afterHash: after.contentHash }),
    ...(before.etag !== undefined && { beforeEtag: before.etag }),
    ...(afterEtag !== undefined && { afterEtag }),
    beforeSize: before.size,
    ...(afterSize !== undefined && { afterSize }),
  };
};
