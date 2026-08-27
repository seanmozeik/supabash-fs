import { SupabashError } from '../api/errors.js';
import type { RestorePlan, RevisionEntry } from '../api/history.js';
import type { RemoteEntry } from '../core/storage.js';
import type { TrackedFileSystem } from '../core/tracked-file-system.js';
import type { HistoryBlobStore } from './blob-store.js';
import { diffRevisions } from './diff.js';
import { readBytes, readJson } from './json-io.js';
import { historyKey } from './keys.js';
import { parseRevision } from './parse.js';
import { requireHeadRevision } from './query.js';

export const planRestore = async (
  history: HistoryBlobStore,
  fs: TrackedFileSystem,
  revision: string,
): Promise<RestorePlan> => {
  const current = await requireHeadRevision(history);
  const target = await readJson(history, historyKey.revision(revision), parseRevision);
  if (target === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Restore revision does not exist.');
  }
  if ((await readJson(history, historyKey.revision(current), parseRevision)) === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Current revision manifest is missing.');
  }
  const diff = await diffRevisions(history, { from: { revision: current }, to: { revision } });
  await fs.stageRemoteTree(target.entries.map(remoteFromRevision), (entry) =>
    downloadRevision(history, entry),
  );
  return { diff, sourceRevision: revision };
};

const remoteFromRevision = (entry: RevisionEntry): RemoteEntry => ({
  kind: entry.entryKind,
  mode: entry.mode,
  modifiedAt: new Date(0),
  path: entry.path,
  size: entry.size,
  ...(entry.contentHash !== undefined && { contentHash: entry.contentHash }),
  ...(entry.etag !== undefined && { etag: entry.etag }),
  ...(entry.target !== undefined && { target: entry.target }),
});

const downloadRevision = async (
  history: HistoryBlobStore,
  entry: RemoteEntry,
): Promise<Uint8Array> => {
  if (entry.contentHash === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'File revision is missing a content hash.', {
      path: entry.path,
    });
  }
  const body = await readBytes(history, historyKey.object(entry.contentHash));
  if (body === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Historical file body is no longer retained.', {
      path: entry.path,
    });
  }
  return body;
};
