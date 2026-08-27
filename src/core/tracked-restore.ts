import { InMemoryFs, type FsStat } from 'just-bash/browser';

import type { WorkspaceEntryKind } from '../api/contracts.js';
import { orderRemoteEntries } from './entry-order.js';
import { deduplicateDownload } from './lazy-download.js';
import { parentPaths, ROOT_PATH } from './path.js';
import type { RemoteEntry } from './storage.js';

export const rebuildLiveTree = async (
  entries: readonly RemoteEntry[],
  download: (entry: RemoteEntry) => Promise<Uint8Array>,
  eager = false,
  maxTotalBytes?: number,
): Promise<{ inner: InMemoryFs; kinds: Map<string, WorkspaceEntryKind> }> => {
  const innerOptions = maxTotalBytes === undefined ? undefined : { maxTotalBytes };
  const inner = new InMemoryFs(undefined, innerOptions);
  const kinds = new Map<string, WorkspaceEntryKind>([[ROOT_PATH, 'directory']]);
  for (const entry of orderRemoteEntries(entries)) {
    for (const parent of parentPaths(entry.path)) {
      kinds.set(parent, 'directory');
    }
    kinds.set(entry.path, entry.kind);
    await restoreRemoteEntry(inner, entry, download, eager);
  }
  return { inner, kinds };
};

export const pendingAgainstBaseline = (
  baseline: ReadonlyMap<string, RemoteEntry>,
  entries: readonly RemoteEntry[],
): { deletions: Map<string, RemoteEntry>; upserts: Set<string> } => {
  const deletions = new Map<string, RemoteEntry>();
  const upserts = new Set<string>();
  const keep = new Set(entries.map((entry) => entry.path));
  for (const [path, remote] of baseline) {
    if (path !== ROOT_PATH && !keep.has(path)) {
      deletions.set(path, remote);
    }
  }
  for (const entry of entries) {
    if (entry.path !== ROOT_PATH && !sameStagedEntry(baseline.get(entry.path), entry)) {
      upserts.add(entry.path);
    }
  }
  return { deletions, upserts };
};

export const sameStagedEntry = (
  baseline: RemoteEntry | undefined,
  target: RemoteEntry,
): boolean => {
  if (baseline === undefined || baseline.kind !== target.kind) {
    return false;
  }
  if (target.kind === 'directory') {
    return baseline.mode === target.mode;
  }
  if (target.kind === 'symlink') {
    return baseline.target === target.target;
  }
  return baseline.contentHash !== undefined && baseline.contentHash === target.contentHash;
};

export const restoreRemoteEntry = async (
  inner: InMemoryFs,
  entry: RemoteEntry,
  download: (entry: RemoteEntry) => Promise<Uint8Array>,
  eager = false,
): Promise<void> => {
  if (entry.kind === 'file') {
    const body = eager ? await download(entry) : undefined;
    inner.writeFileLazy(
      entry.path,
      body === undefined ? deduplicateDownload(() => download(entry)) : () => body,
      { mode: entry.mode, mtime: entry.modifiedAt },
    );
    return;
  }
  if (entry.kind === 'directory') {
    await inner.mkdir(entry.path, { recursive: true });
    await inner.chmod(entry.path, entry.mode);
    await inner.utimes(entry.path, entry.modifiedAt, entry.modifiedAt);
    return;
  }
  await inner.symlink(entry.target ?? '', entry.path);
};

export const pristineRemoteStat = (
  path: string,
  baseline: ReadonlyMap<string, RemoteEntry>,
  mutated: boolean,
): Promise<FsStat> | undefined => {
  if (mutated) {
    return undefined;
  }
  const remote = baseline.get(path);
  if (remote?.kind !== 'file') {
    return undefined;
  }
  return Promise.resolve({
    identity: `supabash:${remote.etag ?? remote.path}`,
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
    mode: remote.mode,
    mtime: remote.modifiedAt,
    size: remote.size,
  });
};
