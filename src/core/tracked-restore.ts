import type { FsStat, InMemoryFs } from 'just-bash/browser';

import { deduplicateDownload } from './lazy-download.js';
import type { RemoteEntry } from './storage.js';

export const restoreRemoteEntry = async (
  inner: InMemoryFs,
  entry: RemoteEntry,
  download: (entry: RemoteEntry) => Promise<Uint8Array>,
): Promise<void> => {
  if (entry.kind === 'file') {
    inner.writeFileLazy(
      entry.path,
      deduplicateDownload(() => download(entry)),
      { mode: entry.mode, mtime: entry.modifiedAt },
    );
    return;
  }
  await (entry.kind === 'directory'
    ? inner.mkdir(entry.path, { recursive: true })
    : inner.symlink(entry.target ?? '', entry.path));
  await inner.chmod(entry.path, entry.mode);
  await inner.utimes(entry.path, entry.modifiedAt, entry.modifiedAt);
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
