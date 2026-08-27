import { SupabashError } from '../api/errors.js';

export const HISTORY_ROOT = '.supabash';

const encodeHistoryId = (value: string): string => encodeURIComponent(value).replaceAll('.', '%2E');

export const historyKey = {
  abort: (transactionId: string) => `${HISTORY_ROOT}/transactions/${transactionId}/abort.json`,
  checkpoint: (id: string) => `${HISTORY_ROOT}/checkpoints/${encodeHistoryId(id)}.json`,
  complete: (transactionId: string) =>
    `${HISTORY_ROOT}/transactions/${transactionId}/complete.json`,
  head: `${HISTORY_ROOT}/head.json`,
  idempotency: (key: string) => `${HISTORY_ROOT}/idempotency/${encodeHistoryId(key)}.json`,
  intent: (transactionId: string) => `${HISTORY_ROOT}/transactions/${transactionId}/intent.json`,
  object: (hash: string) => `${HISTORY_ROOT}/objects/${hash}`,
  revision: (revision: string) => `${HISTORY_ROOT}/revisions/${revision}.json`,
} as const;

export const assertHistoryKey = (key: string): void => {
  if (!key.startsWith(`${HISTORY_ROOT}/`) || key.includes('..') || key.includes('\\')) {
    throw new SupabashError('AUTHORIZATION', 'History key escaped the private namespace.');
  }
};

export const isHistoryRelative = (relative: string): boolean =>
  relative === HISTORY_ROOT || relative.startsWith(`${HISTORY_ROOT}/`);
