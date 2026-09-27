import { SupabashError } from '../api/errors.js';
import type { HistoryBlobStore } from './blob-store.js';
import { nullableString, parseHistoryObject } from './fields.js';
import { readJson, writeJson } from './json-io.js';
import { HISTORY_ROOT } from './keys.js';

interface RevisionLink {
  readonly parentRevision: string | null;
  readonly revision: string;
}

const ancestryKey = (revision: string): string =>
  `${HISTORY_ROOT}/ancestry/${encodeURIComponent(revision)}.json`;

// Persist only opaque ancestry, never document contents or transaction metadata.
// All links must be durable before purge deletes any revision or completion.
export const preserveAncestry = async (
  history: HistoryBlobStore,
  records: readonly RevisionLink[],
): Promise<void> => {
  for (const record of records) {
    await writeJson(history, ancestryKey(record.revision), {
      parentRevision: record.parentRevision,
    });
  }
};

export const retainedChain = async <T extends RevisionLink>(
  history: HistoryBlobStore,
  records: readonly T[],
  head: string | undefined,
): Promise<readonly T[]> => {
  const byRevision = new Map(records.map((record) => [record.revision, record]));
  const retained: T[] = [];
  const seen = new Set<string>();
  let revision = head ?? null;
  while (revision !== null) {
    if (seen.has(revision)) {
      throw new SupabashError('HISTORY_CORRUPTION', 'Revision history contains a cycle.');
    }
    seen.add(revision);
    const record = byRevision.get(revision);
    if (record === undefined) {
      const parent = await readJson(history, ancestryKey(revision), (value) =>
        nullableString(parseHistoryObject(value), 'parentRevision'),
      );
      // Old purges did not retain ancestry. Never invent order from timestamps.
      revision = parent ?? null;
    } else {
      retained.push(record);
      revision = record.parentRevision;
    }
  }
  return retained;
};
