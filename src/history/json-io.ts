import { SupabashError } from '../api/errors.js';
import type { HistoryBlobStore } from './blob-store.js';
import { assertHistoryKey } from './keys.js';

const text = new TextDecoder();
const bytes = new TextEncoder();

export const readJson = async <T>(
  store: HistoryBlobStore,
  key: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> => {
  assertHistoryKey(key);
  const body = await store.get(key);
  if (body === undefined) {
    return undefined;
  }
  try {
    return parse(JSON.parse(text.decode(body)) as unknown);
  } catch (error) {
    throw new SupabashError('HISTORY_CORRUPTION', 'History record is not valid JSON.', {
      cause: error,
    });
  }
};

export const writeJson = (store: HistoryBlobStore, key: string, value: unknown): Promise<void> => {
  assertHistoryKey(key);
  return store.put(key, bytes.encode(`${JSON.stringify(value)}\n`));
};

export const readBytes = (
  store: HistoryBlobStore,
  key: string,
): Promise<Uint8Array | undefined> => {
  assertHistoryKey(key);
  return store.get(key);
};

export const writeBytes = (
  store: HistoryBlobStore,
  key: string,
  body: Uint8Array,
): Promise<void> => {
  assertHistoryKey(key);
  return store.put(key, body);
};
