import { SupabashError } from '../api/errors.js';
import type { PurgeOptions, PurgeReceipt } from '../api/history.js';
import { preserveAncestry, retainedChain } from './ancestry.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson } from './json-io.js';
import { HISTORY_ROOT, historyKey } from './keys.js';
import { parseCheckpoint, parseComplete, parseHead, parseIntent, parseRevision } from './parse.js';
import { normalizePurgeOptions } from './quota.js';
import type { HeadRecord, RevisionRecord } from './records.js';

export const purgeHistory = async (
  history: HistoryBlobStore,
  options: PurgeOptions,
): Promise<PurgeReceipt> => {
  const normalized = normalizePurgeOptions(options);
  const { maxRevisions } = normalized;
  const head = await readJson(history, historyKey.head, parseHead);
  const records = await loadRevisions(history);
  const chain = await retainedChain(history, records, head?.revision);
  const pinned = await pinnedRevisions(history, head);
  if (normalized.keepAfterRevision !== undefined) {
    if (!chain.some((record) => record.revision === normalized.keepAfterRevision)) {
      throw new SupabashError(
        'REVISION_NOT_FOUND',
        'Retention floor must be on the retained head chain.',
      );
    }
    for (const record of chain) {
      pinned.add(record.revision);
      if (record.revision === normalized.keepAfterRevision) {
        break;
      }
    }
  }
  const keptByCount = new Set(chain.slice(0, maxRevisions).map((record) => record.revision));
  const cutoff = normalized.maxAgeMs === undefined ? undefined : Date.now() - normalized.maxAgeMs;
  const removable = records.filter((record) => {
    if (pinned.has(record.revision)) {
      return false;
    }
    const tooOld = cutoff !== undefined && Date.parse(record.committedAt) < cutoff;
    const tooMany = !keptByCount.has(record.revision);
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
  const transactionKeys: string[] = [];
  for (const record of removable) {
    const complete = await readJson(
      history,
      historyKey.complete(record.transactionId),
      parseComplete,
    );
    transactionKeys.push(
      historyKey.intent(record.transactionId),
      historyKey.complete(record.transactionId),
      historyKey.revision(record.revision),
    );
    if (complete?.idempotencyKey !== undefined) {
      transactionKeys.push(historyKey.idempotency(complete.idempotencyKey));
    }
  }
  const aborted = await removableAbortedTransactions(history, cutoff);
  const objects = [...new Set([...unusedObjects, ...transactionKeys, ...aborted])].toSorted();
  const bytes = await byteSize(history, objects);
  if (normalized.dryRun !== true && objects.length > 0) {
    await preserveAncestry(history, removable);
    await history.remove(objects);
  }
  return { bytes, dryRun: normalized.dryRun === true, objects };
};

const removableAbortedTransactions = async (
  history: HistoryBlobStore,
  cutoff: number | undefined,
): Promise<readonly string[]> => {
  if (cutoff === undefined) {
    return [];
  }
  const listed = await history.list(`${HISTORY_ROOT}/transactions/`);
  const aborted = new Set(
    listed
      .filter((key) => key.endsWith('/abort.json'))
      .map((key) => key.slice(0, key.lastIndexOf('/'))),
  );
  const removable: string[] = [];
  for (const key of listed.filter((entry) => entry.endsWith('/intent.json'))) {
    const directory = key.slice(0, key.lastIndexOf('/'));
    if (aborted.has(directory)) {
      const intent = await readJson(history, key, parseIntent);
      if (intent !== undefined && Date.parse(intent.createdAt) < cutoff) {
        removable.push(key, historyKey.abort(intent.transactionId));
      }
    }
  }
  return removable;
};

const loadRevisions = async (history: HistoryBlobStore): Promise<RevisionRecord[]> => {
  const listed = await history.list(`${HISTORY_ROOT}/revisions/`);
  const records: RevisionRecord[] = [];
  for (const key of listed) {
    if (key.endsWith('.json')) {
      const record = await readJson(history, key, parseRevision);
      if (record !== undefined) {
        records.push(record);
      }
    }
  }
  return records;
};

const pinnedRevisions = async (
  history: HistoryBlobStore,
  head: HeadRecord | undefined,
): Promise<Set<string>> => {
  const pinned = new Set<string>();
  if (head !== undefined) {
    pinned.add(head.revision);
  }
  const listed = await history.list(`${HISTORY_ROOT}/checkpoints/`);
  for (const key of listed) {
    const checkpoint = await readJson(history, key, parseCheckpoint);
    if (checkpoint !== undefined) {
      pinned.add(checkpoint.revision);
    }
  }
  return pinned;
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
