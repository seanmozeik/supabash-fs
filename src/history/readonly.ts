import { SupabashError } from '../api/errors.js';
import type { ReadonlyWorkspaceView, RevisionEntry } from '../api/history.js';
import { normalizeVirtualPath } from '../core/path.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readBytes, readJson } from './json-io.js';
import { historyKey } from './keys.js';
import { parseRevision } from './parse.js';

export const readRevisionView = async (
  history: HistoryBlobStore,
  revision: string,
): Promise<ReadonlyWorkspaceView> => {
  const record = await readJson(history, historyKey.revision(revision), parseRevision);
  if (record === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Revision does not exist.');
  }
  return {
    entries: record.entries,
    readFile: (path: string) => readRevisionFile(history, record.entries, path),
    revision,
  };
};

const readRevisionFile = async (
  history: HistoryBlobStore,
  entries: readonly RevisionEntry[],
  path: string,
): Promise<string> => {
  const normalized = normalizeVirtualPath(path);
  const entry = entries.find((candidate) => candidate.path === normalized);
  if (entry?.entryKind !== 'file' || entry.contentHash === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Revision file does not exist.', {
      path: normalized,
    });
  }
  const body = await readBytes(history, historyKey.object(entry.contentHash));
  if (body === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Historical file body is no longer retained.', {
      path: normalized,
    });
  }
  return new TextDecoder().decode(body);
};
