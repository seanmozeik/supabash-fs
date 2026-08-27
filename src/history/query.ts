import { SupabashError } from '../api/errors.js';
import type { HistoryPage, HistoryQuery, HistoryRecord } from '../api/history.js';
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
  const causal = await causalCompletes(history, completes);
  const records = causal.map((complete) => historyRecord(complete, scope));
  const start = historyStart(records, query.cursor);
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
  const byRevision = new Map(completes.map((record) => [record.newRevision, record]));
  const reverse: CompleteRecord[] = [];
  const seen = new Set<string>();
  let revision: string | null = head.revision;
  while (revision !== null) {
    if (seen.has(revision)) {
      throw new SupabashError('HISTORY_CORRUPTION', 'Revision history contains a cycle.');
    }
    seen.add(revision);
    const record = byRevision.get(revision);
    if (record === undefined) {
      break;
    }
    reverse.push(record);
    revision = record.parentRevision;
  }
  return reverse.toReversed();
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
  ...(complete.idempotencyKey !== undefined && { idempotencyKey: complete.idempotencyKey }),
  ...(complete.metadata !== undefined && { metadata: complete.metadata }),
});

export const requireHeadRevision = async (history: HistoryBlobStore): Promise<string> => {
  const head = await readJson(history, historyKey.head, parseHead);
  if (head === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Workspace has no committed revision yet.');
  }
  return head.revision;
};
