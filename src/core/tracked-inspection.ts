import type { FsStat, InMemoryFs } from 'just-bash/browser';

import type { WorkspaceEntryKind } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import { sha256 } from './hash.js';
import { isSameOrDescendant, normalizeVirtualPath, parentPaths, ROOT_PATH } from './path.js';
import type { RemoteEntry, UploadDraft } from './storage.js';
import { pristineRemoteStat } from './tracked-restore.js';

type Download = (entry: RemoteEntry) => Promise<Uint8Array>;

export const uploadDraftFor = async (
  inner: InMemoryFs,
  kinds: ReadonlyMap<string, WorkspaceEntryKind>,
  path: string,
): Promise<UploadDraft> => {
  const normalized = normalizeVirtualPath(path);
  const kind = kinds.get(normalized);
  if (kind === undefined) {
    throw new SupabashError('INVALID_PATH', 'Changed path no longer exists.', { path });
  }
  const stat = await inner.lstat(normalized);
  if (kind === 'file') {
    return {
      body: await inner.readFileBuffer(normalized),
      kind,
      mode: stat.mode,
      modifiedAt: stat.mtime,
      path: normalized,
    };
  }
  if (kind === 'symlink') {
    return {
      kind,
      mode: stat.mode,
      modifiedAt: stat.mtime,
      path: normalized,
      target: await inner.readlink(normalized),
    };
  }
  return { kind, mode: stat.mode, modifiedAt: stat.mtime, path: normalized };
};

export const entryForAudit = async (
  entry: RemoteEntry | undefined,
  hashes: Map<string, Promise<string>>,
  download: Download,
): Promise<RemoteEntry | undefined> => {
  if (entry === undefined || entry.contentHash !== undefined || entry.kind === 'directory') {
    return entry;
  }
  const contentHash =
    entry.kind === 'file'
      ? await hashForRemote(entry, hashes, download)
      : await sha256(new TextEncoder().encode(entry.target ?? ''));
  return { ...entry, contentHash };
};

export const hashForRemote = (
  entry: RemoteEntry,
  hashes: Map<string, Promise<string>>,
  download: Download,
): Promise<string> => {
  const existing = hashes.get(entry.path);
  if (existing !== undefined) {
    return existing;
  }
  const hash =
    entry.contentHash === undefined
      ? download(entry).then((body) => sha256(body))
      : Promise.resolve(entry.contentHash);
  hashes.set(entry.path, hash);
  return hash;
};

export const fileMatchesBaseline = async (
  inner: InMemoryFs,
  baseline: RemoteEntry | undefined,
  hashes: Map<string, Promise<string>>,
  download: Download,
): Promise<boolean> => {
  if (baseline?.kind !== 'file') {
    return false;
  }
  const stat = await inner.lstat(baseline.path);
  const currentHash = await sha256(await inner.readFileBuffer(baseline.path));
  return (
    currentHash === (await hashForRemote(baseline, hashes, download)) && stat.mode === baseline.mode
  );
};

export const pristineStatFor = (
  path: string,
  baseline: ReadonlyMap<string, RemoteEntry>,
  changed: boolean,
): Promise<FsStat> | undefined => pristineRemoteStat(normalizeVirtualPath(path), baseline, changed);

export const entriesWithin = (
  kinds: ReadonlyMap<string, WorkspaceEntryKind>,
  path: string,
): (readonly [string, WorkspaceEntryKind])[] =>
  [...kinds].filter(
    ([candidate]) => candidate !== ROOT_PATH && isSameOrDescendant(candidate, path),
  );

export const recordUpsert = (
  path: string,
  kind: WorkspaceEntryKind,
  kinds: Map<string, WorkspaceEntryKind>,
  deletions: Map<string, RemoteEntry>,
  upserts: Set<string>,
): void => {
  for (const parent of parentPaths(path)) {
    kinds.set(parent, 'directory');
  }
  kinds.set(path, kind);
  deletions.delete(path);
  upserts.add(path);
};

export const recordDeletion = (
  path: string,
  baseline: ReadonlyMap<string, RemoteEntry>,
  deletions: Map<string, RemoteEntry>,
  kinds: Map<string, WorkspaceEntryKind>,
  moves: Map<string, string>,
  upserts: Set<string>,
): void => {
  const normalized = normalizeVirtualPath(path);
  const entry = baseline.get(normalized);
  if (entry !== undefined) {
    deletions.set(normalized, entry);
  }
  upserts.delete(normalized);
  kinds.delete(normalized);
  for (const [from, to] of moves) {
    if (to === normalized) {
      moves.delete(from);
    }
  }
};

export const recordMove = (
  from: string,
  to: string,
  baseline: ReadonlyMap<string, RemoteEntry>,
  moves: Map<string, string>,
): void => {
  const previous = [...moves].find(([, destination]) => destination === from);
  if (previous !== undefined) {
    moves.delete(previous[0]);
    if (previous[0] !== to) {
      moves.set(previous[0], to);
    }
  } else if (baseline.has(from) && from !== to) {
    moves.set(from, to);
  }
};
