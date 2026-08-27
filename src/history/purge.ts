import type { PurgeOptions, PurgeReceipt } from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson } from './json-io.js';
import { HISTORY_ROOT, historyKey } from './keys.js';
import { DEFAULT_MAX_REVISIONS_RETAINED } from './limits.js';
import { parseCheckpoint, parseHead, parseRevision } from './parse.js';

export const purgeHistory = async (
  history: HistoryBlobStore,
  options: PurgeOptions,
): Promise<PurgeReceipt> => {
  const maxRevisions = options.maxRevisions ?? DEFAULT_MAX_REVISIONS_RETAINED;
  const head = await readJson(history, historyKey.head, parseHead);
  const listedRevisions = await history.list(`${HISTORY_ROOT}/revisions/`);
  const revisionKeys = listedRevisions.filter((key) => key.endsWith('.json'));
  const records = [];
  for (const key of revisionKeys) {
    const record = await readJson(history, key, parseRevision);
    if (record !== undefined) {
      records.push(record);
    }
  }
  records.sort((left, right) => comparePaths(left.committedAt, right.committedAt));
  const pinned = new Set<string>();
  if (head !== undefined) {
    pinned.add(head.revision);
  }
  const listedCheckpoints = await history.list(`${HISTORY_ROOT}/checkpoints/`);
  for (const key of listedCheckpoints) {
    const checkpoint = await readJson(history, key, parseCheckpoint);
    if (checkpoint !== undefined) {
      pinned.add(checkpoint.revision);
    }
  }
  const cutoff = options.maxAgeMs === undefined ? undefined : Date.now() - options.maxAgeMs;
  const removable = records.filter((record, index) => {
    if (pinned.has(record.revision)) {
      return false;
    }
    const tooOld = cutoff !== undefined && Date.parse(record.committedAt) < cutoff;
    const tooMany = index < records.length - maxRevisions;
    return tooOld || tooMany;
  });
  const removableSet = new Set(removable);
  const retained = new Set(
    records.filter((record) => !removableSet.has(record)).flatMap((record) => hashesOf(record)),
  );
  const objectKeys = await history.list(`${HISTORY_ROOT}/objects/`);
  const unusedObjects = objectKeys.filter((key) => {
    const hash = key.slice(`${HISTORY_ROOT}/objects/`.length);
    return !retained.has(hash);
  });
  const transactionKeys = removable.flatMap((record) => [
    historyKey.intent(record.transactionId),
    historyKey.complete(record.transactionId),
    historyKey.revision(record.revision),
  ]);
  const objects = [...unusedObjects, ...transactionKeys];
  const bytes = await byteSize(history, objects);
  if (options.dryRun !== true && objects.length > 0) {
    await history.remove(objects);
  }
  return { bytes, dryRun: options.dryRun === true, objects };
};

const hashesOf = (record: { entries: readonly { contentHash?: string }[] }): readonly string[] =>
  record.entries.flatMap((entry) => (entry.contentHash === undefined ? [] : [entry.contentHash]));

const byteSize = async (history: HistoryBlobStore, keys: readonly string[]): Promise<number> => {
  let total = 0;
  for (const key of keys) {
    const body = await history.get(key);
    total += body?.byteLength ?? 0;
  }
  return total;
};
