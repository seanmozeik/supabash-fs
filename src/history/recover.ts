import { comparePaths } from '../core/entry-order.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson, writeJson } from './json-io.js';
import { historyKey } from './keys.js';
import { parseHead } from './parse.js';
import { listCompleteRecords } from './query.js';
import type { CompleteRecord, HeadRecord } from './records.js';

export const recoverPublishedHead = async (history: HistoryBlobStore): Promise<void> => {
  const completes = await listCompleteRecords(history);
  if (completes.length === 0) {
    return;
  }
  const head = await readJson(history, historyKey.head, parseHead);
  const adopted = newestDescendant(completes, head?.revision ?? null);
  if (adopted === undefined || head?.revision === adopted.newRevision) {
    return;
  }
  const nextHead: HeadRecord = {
    committedAt: adopted.committedAt,
    revision: adopted.newRevision,
    schemaVersion: adopted.schemaVersion,
    transactionId: adopted.transactionId,
  };
  await writeJson(history, historyKey.head, nextHead);
};

const newestDescendant = (
  completes: readonly CompleteRecord[],
  start: string | null,
): CompleteRecord | undefined => {
  let currentRevision = start;
  let current: CompleteRecord | undefined;
  for (;;) {
    const parent = currentRevision;
    const children = completes
      .filter((record) => record.parentRevision === parent)
      .toSorted(compareCompletes);
    const next = children.at(-1);
    if (next === undefined) {
      return current;
    }
    current = next;
    currentRevision = next.newRevision;
  }
};

const compareCompletes = (left: CompleteRecord, right: CompleteRecord): number => {
  const byTime = left.committedAt.localeCompare(right.committedAt);
  return byTime === 0 ? comparePaths(left.transactionId, right.transactionId) : byTime;
};
