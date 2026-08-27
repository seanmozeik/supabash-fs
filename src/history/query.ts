import { SupabashError } from '../api/errors.js';
import type { HistoryPage, HistoryQuery, HistoryRecord } from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson } from './json-io.js';
import { HISTORY_ROOT, historyKey } from './keys.js';
import type { WorkspaceLimits } from './limits.js';
import { parseComplete, parseHead } from './parse.js';
import { historyPageLimit } from './quota.js';
import type { CompleteRecord } from './records.js';

export const listCompleteRecords = async (
  history: HistoryBlobStore,
): Promise<readonly CompleteRecord[]> => {
  const listed = await history.list(`${HISTORY_ROOT}/transactions/`);
  const records: CompleteRecord[] = [];
  for (const key of listed.filter((entry) => entry.endsWith('/complete.json'))) {
    const complete = await readJson(history, key, parseComplete);
    if (complete !== undefined) {
      records.push(complete);
    }
  }
  return records;
};

export const readHistoryPage = async (
  history: HistoryBlobStore,
  scope: string,
  query: HistoryQuery = {},
  limits: WorkspaceLimits = {},
): Promise<HistoryPage> => {
  const limit = historyPageLimit(query.limit, limits);
  const completes = await listCompleteRecords(history);
  const records = completes
    .map((complete) => historyRecord(complete, scope))
    .toSorted((left, right) => {
      const byTime = left.committedAt.getTime() - right.committedAt.getTime();
      return byTime === 0 ? comparePaths(left.transactionId, right.transactionId) : byTime;
    });
  const start = historyStart(records, query.cursor);
  const page = records.slice(start, start + limit);
  const next = page.length === limit ? page.at(-1)?.cursor : undefined;
  return next === undefined ? { records: page } : { nextCursor: next, records: page };
};

const historyStart = (records: readonly HistoryRecord[], cursor: string | undefined): number => {
  if (cursor === undefined) {
    return 0;
  }
  const index = records.findIndex((record) => record.transactionId === cursor);
  if (index === -1) {
    throw new SupabashError(
      'REVISION_NOT_FOUND',
      'History cursor does not match a committed transaction.',
    );
  }
  return index + 1;
};

const historyRecord = (complete: CompleteRecord, scope: string): HistoryRecord => ({
  actor: complete.actor,
  changes: complete.changes,
  committedAt: new Date(complete.committedAt),
  correlationId: complete.correlationId,
  cursor: complete.transactionId,
  parentRevision: complete.parentRevision,
  revision: complete.newRevision,
  schemaVersion: complete.schemaVersion,
  scope,
  status: complete.status,
  transactionId: complete.transactionId,
  ...(complete.cause !== undefined && { cause: complete.cause }),
});

export const requireHeadRevision = async (history: HistoryBlobStore): Promise<string> => {
  const head = await readJson(history, historyKey.head, parseHead);
  if (head === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Workspace has no committed revision yet.');
  }
  return head.revision;
};
