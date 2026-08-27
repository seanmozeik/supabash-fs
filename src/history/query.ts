import { SupabashError } from '../api/errors.js';
import type { HistoryPage, HistoryQuery, HistoryRecord } from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson } from './json-io.js';
import { HISTORY_ROOT, historyKey } from './keys.js';
import { DEFAULT_MAX_HISTORY_PAGE_SIZE } from './limits.js';
import { parseComplete, parseHead } from './parse.js';

export const readHistoryPage = async (
  history: HistoryBlobStore,
  scope: string,
  query: HistoryQuery = {},
): Promise<HistoryPage> => {
  const limit = query.limit ?? DEFAULT_MAX_HISTORY_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_MAX_HISTORY_PAGE_SIZE) {
    throw new SupabashError('QUOTA_EXCEEDED', 'History page size is outside the allowed range.');
  }
  const listed = await history.list(`${HISTORY_ROOT}/transactions/`);
  const keys = listed.filter((key) => key.endsWith('/complete.json'));
  const records: HistoryRecord[] = [];
  for (const key of keys) {
    const complete = await readJson(history, key, parseComplete);
    if (complete !== undefined) {
      records.push(historyRecord(complete, scope));
    }
  }
  records.sort((left, right) => {
    const byTime = left.committedAt.getTime() - right.committedAt.getTime();
    return byTime === 0 ? comparePaths(left.transactionId, right.transactionId) : byTime;
  });
  const start =
    query.cursor === undefined
      ? 0
      : records.findIndex((record) => record.transactionId === query.cursor) + 1;
  const page = records.slice(Math.max(0, start), Math.max(0, start) + limit);
  const next = page.length === limit ? page.at(-1)?.cursor : undefined;
  return next === undefined ? { records: page } : { nextCursor: next, records: page };
};

const historyRecord = (
  complete: Awaited<ReturnType<typeof parseComplete>>,
  scope: string,
): HistoryRecord => ({
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
