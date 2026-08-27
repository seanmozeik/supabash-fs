import { SupabashError } from '../api/errors.js';
import type { HistoryBlobStore } from '../history/blob-store.js';
import { HISTORY_ROOT, assertHistoryKey } from '../history/keys.js';
import { listObjectKeys } from './list-objects.js';
import { isStorageNotFound } from './not-found.js';

type BucketApi = {
  readonly download: (key: string) => Promise<{ data: Blob | null; error: unknown }>;
  readonly listV2: (
    options: { cursor?: string; limit: number; prefix: string },
    extra?: { cache?: RequestCache },
  ) => Promise<{
    data: {
      hasNext: boolean;
      nextCursor?: string;
      objects: readonly { key?: string; name: string }[];
    } | null;
    error: unknown;
  }>;
  readonly remove: (keys: string[]) => Promise<{ error: unknown }>;
  readonly upload: (
    key: string,
    body: Uint8Array,
    options: { cacheControl: string; contentType: string; upsert: boolean },
  ) => Promise<{ error: unknown }>;
};

const REMOVE_BATCH = 1000;

export class SupabaseHistoryStore implements HistoryBlobStore {
  private readonly bucket: BucketApi;
  private readonly root: string;

  constructor(bucket: BucketApi, root: string) {
    this.bucket = bucket;
    this.root = root;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.bucket.download(this.storageKey(key));
    if (response.error !== null) {
      if (isStorageNotFound(response.error)) {
        return undefined;
      }
      throw storageFailure('history-download', response.error);
    }
    if (response.data === null) {
      return undefined;
    }
    return new Uint8Array(await response.data.arrayBuffer());
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const response = await this.bucket.upload(this.storageKey(key), body, {
      cacheControl: '0',
      contentType: 'application/octet-stream',
      upsert: true,
    });
    if (response.error !== null) {
      throw storageFailure('history-upload', response.error);
    }
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += REMOVE_BATCH) {
      const batch = keys.slice(index, index + REMOVE_BATCH).map((key) => this.storageKey(key));
      const response = await this.bucket.remove(batch);
      if (response.error !== null) {
        throw storageFailure('history-remove', response.error);
      }
    }
  }

  async list(prefix: string): Promise<readonly string[]> {
    assertHistoryKey(prefix.endsWith('/') ? `${prefix}x` : prefix);
    const keys = await listObjectKeys(this.bucket, `${this.root}${prefix}`, this.root);
    return keys.map((key) => key.slice(this.root.length));
  }

  private storageKey(key: string): string {
    assertHistoryKey(key);
    const storageKey = `${this.root}${key}`;
    if (!storageKey.startsWith(`${this.root}${HISTORY_ROOT}/`)) {
      throw new SupabashError('AUTHORIZATION', 'History key escaped the private namespace.');
    }
    return storageKey;
  }
}

const storageFailure = (operation: string, cause: unknown): SupabashError =>
  new SupabashError('STORAGE', `Supabase Storage operation failed during ${operation}.`, { cause });
