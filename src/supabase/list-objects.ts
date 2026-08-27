import { SupabashError } from '../api/errors.js';
import { listedStorageKey, type ListedStorageObject } from './listed-key.js';

const LIST_PAGE_SIZE = 1000;

export interface StorageListBucket {
  readonly listV2: (
    options: { cursor?: string; limit: number; prefix: string },
    extra?: { cache?: RequestCache },
  ) => Promise<{
    data: { hasNext: boolean; nextCursor?: string; objects: readonly ListedStorageObject[] } | null;
    error: unknown;
  }>;
}

export const listObjectKeys = async (
  bucket: StorageListBucket,
  prefix: string,
  root: string,
): Promise<readonly string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await bucket.listV2(
      { ...(cursor !== undefined && { cursor }), limit: LIST_PAGE_SIZE, prefix },
      { cache: 'no-store' },
    );
    if (response.error !== null || response.data === null) {
      throw new SupabashError('STORAGE', 'Supabase Storage operation failed during list.', {
        cause: response.error,
      });
    }
    for (const object of response.data.objects) {
      const key = listedStorageKey(prefix, object);
      if (!key.startsWith(root)) {
        throw new SupabashError('AUTHORIZATION', 'Supabase returned a key outside the user root.');
      }
      keys.push(key);
    }
    cursor = response.data.hasNext ? response.data.nextCursor : undefined;
    if (response.data.hasNext && cursor === undefined) {
      throw new SupabashError('STORAGE', 'Supabase omitted the next list cursor.');
    }
  } while (cursor !== undefined);
  return keys;
};
