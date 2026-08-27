import type { RevisionEntry } from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import { sha256 } from '../core/hash.js';
import type { RemoteEntry, ScopedStorage } from '../core/storage.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readBytes, writeBytes } from './json-io.js';
import { historyKey } from './keys.js';

export const revisionEntriesFrom = async (
  baseline: readonly RemoteEntry[],
  deletions: readonly RemoteEntry[],
  uploads: readonly RemoteEntry[],
  storage: ScopedStorage,
  history: HistoryBlobStore,
): Promise<readonly RevisionEntry[]> => {
  const next = new Map(baseline.map((entry) => [entry.path, entry]));
  for (const deleted of deletions) {
    next.delete(deleted.path);
  }
  for (const uploaded of uploads) {
    next.set(uploaded.path, uploaded);
  }
  const entries: RevisionEntry[] = [];
  const ordered = [...next.values()].toSorted((left, right) => comparePaths(left.path, right.path));
  for (const entry of ordered) {
    entries.push(await storedEntry(entry, storage, history));
  }
  return entries;
};

const storedEntry = async (
  entry: RemoteEntry,
  storage: ScopedStorage,
  history: HistoryBlobStore,
): Promise<RevisionEntry> => {
  const contentHash = await ensureObject(entry, storage, history);
  return {
    entryKind: entry.kind,
    mode: entry.mode,
    path: entry.path,
    size: entry.size,
    ...(contentHash !== undefined && { contentHash }),
    ...(entry.etag !== undefined && { etag: entry.etag }),
    ...(entry.target !== undefined && { target: entry.target }),
  };
};

const ensureObject = async (
  entry: RemoteEntry,
  storage: ScopedStorage,
  history: HistoryBlobStore,
): Promise<string | undefined> => {
  if (entry.kind !== 'file') {
    return entry.kind === 'symlink'
      ? sha256(new TextEncoder().encode(entry.target ?? ''))
      : undefined;
  }
  const body = await storage.download(entry);
  const hash = entry.contentHash ?? (await sha256(body));
  const key = historyKey.object(hash);
  if ((await readBytes(history, key)) === undefined) {
    await writeBytes(history, key, body);
  }
  return hash;
};
