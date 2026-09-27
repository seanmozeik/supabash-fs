import { SupabashError } from '../api/errors.js';
import type { HistoryPage, HistoryQuery, HistoryRecord } from '../api/history.js';
import { retainedChain } from './ancestry.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson } from './json-io.js';
import { HISTORY_ROOT, historyKey } from './keys.js';
import type { WorkspaceLimits } from './limits.js';
import { parseComplete, parseHead, parseRevision } from './parse.js';
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
  const causal = await causalCompletes(history, completes);
  const records = causal.map((complete) => historyRecord(complete, scope));
  const start = historyStart(records, query.cursor, query.cursorMissing);
  const page = records.slice(start, start + limit);
  const next = start + page.length < records.length ? page.at(-1)?.cursor : undefined;
  return next === undefined ? { records: page } : { nextCursor: next, records: page };
};

const causalCompletes = async (
  history: HistoryBlobStore,
  completes: readonly CompleteRecord[],
): Promise<readonly CompleteRecord[]> => {
  const head = await readJson(history, historyKey.head, parseHead);
  if (head === undefined) {
    return [];
  }
  const reverse = await retainedChain(
    history,
    completes.map((record) => ({ ...record, revision: record.newRevision })),
    head.revision,
  );
  return reverse.toReversed();
};

const historyStart = (
  records: readonly HistoryRecord[],
  cursor: string | undefined,
  missing?: 'error' | 'oldest',
): number => {
  if (cursor === undefined) {
    return 0;
  }
  const index = records.findIndex((record) => record.transactionId === cursor);
  if (index === -1) {
    if (missing === 'oldest') {
      return 0;
    }
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
  ...(complete.idempotencyKey !== undefined && { idempotencyKey: complete.idempotencyKey }),
  ...(complete.metadata !== undefined && { metadata: complete.metadata }),
});

export const requireHeadRevision = async (history: HistoryBlobStore): Promise<string> => {
  const head = await readJson(history, historyKey.head, parseHead);
  if (head === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Workspace has no committed revision yet.');
  }
  if ((await readJson(history, historyKey.revision(head.revision), parseRevision)) === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Current revision manifest is missing.');
  }
  return head.revision;
};
